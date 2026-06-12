const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ── Tool implementations ───────────────────────────────────────────────────────

async function getFileContent({ owner, repo, path }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    // Cap at 3000 chars to avoid blowing the context
    return { path, content: content.slice(0, 3000) + (content.length > 3000 ? '\n... [truncated]' : '') };
  } catch (err) {
    return { error: `Could not read ${path}: ${err.message}` };
  }
}

async function listRepoFiles({ owner, repo, path = '' }) {
  const { data } = await octokit.repos.getContent({ owner, repo, path });
  return Array.isArray(data)
    ? data.map(f => ({ name: f.name, path: f.path, type: f.type }))
    : [{ name: data.name, path: data.path, type: data.type }];
}

async function getIssueDetails({ owner, repo, issue_number }) {
  const { data } = await octokit.issues.get({ owner, repo, issue_number });
  return {
    number: data.number,
    title: data.title,
    body: data.body || '',
    state: data.state,
    labels: data.labels.map(l => l.name),
    author: data.user.login,
    created_at: data.created_at,
    comments: data.comments,
    url: data.html_url,
  };
}

async function searchSimilarIssues({ owner, repo, query }) {
  const { data } = await octokit.search.issuesAndPullRequests({
    q: `${query} repo:${owner}/${repo} is:issue`,
    per_page: 5,
    sort: 'relevance',
  });
  return data.items.map(i => ({
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    created_at: i.created_at,
  }));
}

async function getRepoLabels({ owner, repo }) {
  const { data } = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 50 });
  return data.map(l => ({ name: l.name, description: l.description || '' }));
}

async function addLabels({ owner, repo, issue_number, labels }) {
  await octokit.issues.addLabels({ owner, repo, issue_number, labels });
  return { success: true, labels_added: labels };
}

async function postComment({ owner, repo, issue_number, body }) {
  const { data } = await octokit.issues.createComment({ owner, repo, issue_number, body });
  return { success: true, comment_url: data.html_url };
}

async function closeIssue({ owner, repo, issue_number, reason }) {
  await octokit.issues.update({
    owner, repo, issue_number,
    state: 'closed',
    state_reason: reason || 'completed',
  });
  return { success: true };
}

async function escalateToHuman({ owner, repo, issue_number, reason, questions }) {
  // Ensure the escalation label exists (create with amber colour if missing)
  const labelName = 'needs-human-review';
  const { data: existing } = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
  if (!existing.find(l => l.name === labelName)) {
    await octokit.issues.createLabel({
      owner, repo,
      name: labelName,
      color: 'e4b429',
      description: 'Flagged by triage agent — requires human judgement',
    });
  }

  await octokit.issues.addLabels({ owner, repo, issue_number, labels: [labelName] });

  const questionsBlock = questions && questions.length
    ? `\n\n**Questions for the reviewer:**\n${questions.map(q => `- ${q}`).join('\n')}`
    : '';

  const body = `👋 I've reviewed this issue but flagged it for human review because:

> ${reason}
${questionsBlock}

I've applied the \`needs-human-review\` label so a maintainer can take a look. I haven't closed or changed anything else.

<!-- triage-agent -->`;

  const { data: comment } = await octokit.issues.createComment({ owner, repo, issue_number, body });
  return { success: true, comment_url: comment.html_url, label_applied: labelName };
}

// ── Tool registry (OpenAI function-calling format) ────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_repo_files',
      description: 'List files and folders in the repository to find relevant source files',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          path:  { type: 'string', description: 'Folder path to list (empty string for root)' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_content',
      description: 'Read the content of a source file in the repository to understand the actual implementation',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          path:  { type: 'string', description: 'File path (e.g. "src/index.js")' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_issue_details',
      description: 'Get full details of a GitHub issue including title, body, labels, and author',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string', description: 'Repository owner' },
          repo:         { type: 'string', description: 'Repository name' },
          issue_number: { type: 'number', description: 'Issue number' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_similar_issues',
      description: 'Search for similar or duplicate issues in the repository',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          query: { type: 'string', description: 'Search keywords extracted from the issue title/body' },
        },
        required: ['owner', 'repo', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_repo_labels',
      description: 'List all available labels in the repository',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_labels',
      description: 'Add one or more labels to an issue',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
          labels:       { type: 'array', items: { type: 'string' }, description: 'Label names to add' },
        },
        required: ['owner', 'repo', 'issue_number', 'labels'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_comment',
      description: 'Post a comment on an issue',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
          body:         { type: 'string', description: 'Comment body in markdown' },
        },
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_issue',
      description: 'Close an issue. Only use for confirmed duplicates or spam.',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
          reason:       { type: 'string', enum: ['completed', 'not_planned'], description: 'Reason for closing' },
        },
        required: ['owner', 'repo', 'issue_number', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Flag the issue for human review when you cannot confidently triage it. Applies a "needs-human-review" label and posts a comment explaining what the human reviewer should decide.',
      parameters: {
        type: 'object',
        properties: {
          owner:        { type: 'string' },
          repo:         { type: 'string' },
          issue_number: { type: 'number' },
          reason: {
            type: 'string',
            description: 'One sentence explaining why this issue needs human judgement',
          },
          questions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific questions the human reviewer should answer (e.g. "Is this a known limitation or a real bug?")',
          },
        },
        required: ['owner', 'repo', 'issue_number', 'reason'],
      },
    },
  },
];

const TOOL_HANDLERS = {
  get_issue_details:     getIssueDetails,
  search_similar_issues: searchSimilarIssues,
  get_repo_labels:       getRepoLabels,
  add_labels:            addLabels,
  post_comment:          postComment,
  close_issue:           closeIssue,
  escalate_to_human:     escalateToHuman,
  list_repo_files:       listRepoFiles,
  get_file_content:      getFileContent,
};

module.exports = { TOOL_DEFINITIONS, TOOL_HANDLERS };
