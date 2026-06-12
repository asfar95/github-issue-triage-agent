const OpenAI = require('openai');
const { Octokit } = require('@octokit/rest');
const { TOOL_DEFINITIONS, TOOL_HANDLERS } = require('./tools/github');

const MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_ITERATIONS || '10', 10);
const MAX_RETRIES = parseInt(process.env.AGENT_MAX_RETRIES || '3', 10);
const BOT_MARKER = '<!-- triage-agent -->';

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
});
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are an expert GitHub issue triage agent. Your job is to help maintainers by automatically triaging new issues.

When given an issue to triage, follow these steps:
1. Fetch the full issue details and READ the title and body carefully
2. Fetch available labels for the repo
3. Search for similar or duplicate issues using keywords from the title
4. Classify the issue into exactly one of these categories:

   - BUG: a genuine defect in the software
   - FEATURE: a request for new functionality
   - QUESTION: the reporter needs help or clarification
   - DUPLICATE: the same issue already exists (you found it in your search)
   - USER_ERROR: the reporter is misusing the API or doing something incorrectly — the software is working as intended
   - WONTFIX: the behaviour is intentional by design, or the request is out of scope
   - NEEDS_MORE_INFO: too vague to classify — specific details are missing

5. Add the appropriate label ONLY if it exists in the repo's label list (from get_repo_labels):
   - BUG → "bug"
   - FEATURE → "enhancement"
   - QUESTION → "question"
   - DUPLICATE → "duplicate"
   - USER_ERROR → "invalid"
   - WONTFIX → "wontfix"
   - NEEDS_MORE_INFO → "needs-more-info" or "question"
   If the exact label doesn't exist, skip labeling rather than guessing.

6. Post a single helpful, context-aware comment referencing the actual issue content:
   - BUG (steps provided): acknowledge the specific problem, confirm you reproduce/understand it, state next steps
   - BUG (steps missing): ask specifically for what is missing — don't ask for things already provided
   - FEATURE: acknowledge the specific feature described, explain the contribution or roadmap process
   - QUESTION: answer directly using the context given, or point to the relevant resource
   - DUPLICATE: link to the exact existing issue and briefly explain why it is the same
   - USER_ERROR: politely explain what the reporter is doing wrong and show the correct usage with an example
   - WONTFIX: explain why the behaviour is intentional or out of scope, suggest a workaround if one exists
   - NEEDS_MORE_INFO: ask for the specific missing details (version, steps, error output, etc.)

7. Close the issue ONLY if classified as DUPLICATE, USER_ERROR, or WONTFIX.
   NEVER close a BUG or FEATURE issue — they must stay open for the team to act on.
   NEVER close a NEEDS_MORE_INFO issue — wait for the reporter to respond.

IMPORTANT: Call ONE tool at a time. Never batch multiple tool calls in a single response. Wait to see the result of each tool call before deciding what to call next.

- Always read the full issue body before writing the comment
- Never ask for information that is already present in the issue
- Every comment must reference the actual content of the issue — no generic templates
- Be polite and respectful even when closing as invalid or wontfix
- If an issue claims something "doesn't work" or "is broken", look up the source code before classifying:
  1. Call list_repo_files with path="" to see the repo structure
  2. Call list_repo_files on the relevant folder (e.g. "src") to find the right file
  3. Call get_file_content on the actual file to read the implementation
  4. Only then decide: is this a real bug or user error?
- Never guess file paths — always list files first to confirm they exist

ESCALATION — use escalate_to_human instead of guessing when you encounter:
- Security or vulnerability reports (even potential ones) — a human must assess impact and disclosure
- Privacy / data leak reports — same reason
- Legal mentions (copyright, licensing, GDPR, DMCA) — requires legal judgement
- Issues that span multiple teams or repos (e.g. "bug in the API and the dashboard") — human must coordinate
- Genuine ambiguity after reading the code — if you've read the source and still can't tell if it's a bug or by design, escalate; do not flip a coin
- Any issue where a wrong call could cause harm (e.g. closing a real security bug as "user error")

When you escalate:
- Write a clear one-sentence reason explaining what you found and why it's beyond your confidence
- List the specific questions the human reviewer needs to answer
- Do NOT post a regular comment AND escalate — use only escalate_to_human
- Do NOT close the issue when escalating`;

// ── Fix 1: Idempotency ─────────────────────────────────────────────────────────
// Check if the bot has already triaged this issue to prevent double-processing.
async function alreadyTriaged(owner, repo, issueNumber) {
  const { data: comments } = await octokit.issues.listComments({
    owner, repo, issue_number: issueNumber, per_page: 20,
  });
  return comments.some(c => c.body.includes(BOT_MARKER));
}

// ── Fix 2: Label pre-check ─────────────────────────────────────────────────────
// Wrap add_labels to silently filter out labels that don't exist in the repo.
async function safeLabelHandler(args) {
  const { owner, repo, issue_number, labels } = args;

  const { data: repoLabels } = await octokit.issues.listLabelsForRepo({ owner, repo });
  const existing = new Set(repoLabels.map(l => l.name.toLowerCase()));
  const valid = labels.filter(l => existing.has(l.toLowerCase()));
  const skipped = labels.filter(l => !existing.has(l.toLowerCase()));

  if (skipped.length > 0) {
    console.warn(`     ⚠️  Skipping non-existent labels: ${skipped.join(', ')}`);
  }

  if (valid.length === 0) {
    return { success: false, reason: 'None of the requested labels exist in this repo', skipped };
  }

  return TOOL_HANDLERS.add_labels({ owner, repo, issue_number, labels: valid });
}

// ── Fix 3: Context pruning ─────────────────────────────────────────────────────
// Keeps the first user message (task) + the most recent MAX_CONTEXT messages to
// cap token growth. Drops orphaned tool results at the boundary.
const MAX_CONTEXT = 12;
function pruneMessages(messages) {
  if (messages.length <= MAX_CONTEXT + 1) return messages;
  const head = messages.slice(0, 1);
  let tail = messages.slice(-MAX_CONTEXT);
  // Skip orphaned tool results that lost their preceding assistant call
  let start = 0;
  while (start < tail.length && tail[start].role === 'tool') start++;
  return [...head, ...tail.slice(start)];
}

// ── Fix 4: Rate limit retry ────────────────────────────────────────────────────
async function callLLMWithRetry(messages, attempt = 0) {
  try {
    return await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...pruneMessages(messages)],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_tokens: parseInt(process.env.AI_MAX_TOKENS || '2048', 10),
    });
  } catch (err) {
    const isRateLimit = err.status === 429 || err.message?.includes('rate limit');
    const isRetryable = isRateLimit || err.status === 503;

    if (isRetryable && attempt < MAX_RETRIES) {
      const delay = [15000, 30000, 60000][attempt]; // 15s, 30s, 60s — suited for per-minute rate limits
      console.warn(`  ⏳ Rate limited — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
      return callLLMWithRetry(messages, attempt + 1);
    }
    throw err;
  }
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
async function runAgent(owner, repo, issueNumber, { skipIdempotency = false } = {}) {
  console.log(`\n🤖 Agent starting triage for ${owner}/${repo}#${issueNumber}`);

  // Idempotency check — skipped on reopened events so re-triggering works
  if (!skipIdempotency && await alreadyTriaged(owner, repo, issueNumber)) {
    console.log(`⏭️  Issue #${issueNumber} already triaged — skipping`);
    return { success: true, skipped: true };
  }

  const messages = [
    { role: 'user', content: `Triage issue #${issueNumber} in the ${owner}/${repo} repository.` },
  ];

  // Override handlers: safe labeling + guard against closing actionable issues
  const safeCloseHandler = async (args) => {
    const { data: issue } = await octokit.issues.get({ owner: args.owner, repo: args.repo, issue_number: args.issue_number });
    const labels = issue.labels.map(l => l.name.toLowerCase());
    const blockedLabels = ['bug', 'enhancement', 'feature'];
    const blocked = blockedLabels.find(l => labels.includes(l));
    if (blocked) {
      console.warn(`     ⚠️  Blocked close_issue — issue has label "${blocked}" (bugs/features must stay open)`);
      return { success: false, reason: `Cannot close a "${blocked}" issue — it must stay open for the team to fix.` };
    }
    return TOOL_HANDLERS.close_issue(args);
  };
  const handlers = { ...TOOL_HANDLERS, add_labels: safeLabelHandler, close_issue: safeCloseHandler };

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`\n🔄 Iteration ${iterations}`);

    let response;
    try {
      response = await callLLMWithRetry(messages);
    } catch (err) {
      console.error(`  ❌ LLM API error: ${err.message}`);
      messages.push({
        role: 'user',
        content: 'Your last response contained an invalid tool call. Please try again with correct arguments.',
      });
      continue;
    }

    const message = response.choices[0].message;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      console.log(`\n✅ Agent finished after ${iterations} iteration(s)`);
      if (message.content) console.log(`💬 Agent: ${message.content}`);
      return { success: true, iterations, summary: message.content };
    }

    for (const toolCall of message.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`  🔧 Calling tool: ${name}`, JSON.stringify(args));

      // Inject BOT_MARKER so the idempotency check detects prior triage
      if (name === 'post_comment' || name === 'escalate_to_human') {
        if (!args.body?.includes(BOT_MARKER)) {
          args.body = `${args.body}\n\n${BOT_MARKER}`;
        }
      }

      let result;
      try {
        const handler = handlers[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        result = await handler(args);
        console.log(`     ✅ ${name} succeeded`);
      } catch (err) {
        result = { error: err.message };
        console.error(`     ❌ ${name} failed: ${err.message}`);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.warn(`⚠️  Agent hit max iterations (${MAX_ITERATIONS})`);
  return { success: false, iterations, summary: 'Max iterations reached' };
}

module.exports = { runAgent };
