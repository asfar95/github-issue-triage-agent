// Unified AI client — normalises OpenAI and Anthropic to one interface.
// Agent loops stay unchanged; only this file knows which SDK to call.
//
// Provider selection (in priority order):
//   1. AI_PROVIDER=anthropic  +  AI_API_KEY=sk-ant-...   → Anthropic SDK (native)
//   2. AI_PROVIDER=<other>    +  AI_BASE_URL=<url>       → OpenAI-compatible shim
//   3. (nothing set)                                      → Anthropic SDK (default)

const AI_PROVIDER = process.env.AI_PROVIDER || 'anthropic';
const AI_API_KEY  = process.env.AI_API_KEY;
const AI_BASE_URL = process.env.AI_BASE_URL;

const USE_ANTHROPIC = AI_PROVIDER === 'anthropic' && !AI_BASE_URL;

// ── Format converters ──────────────────────────────────────────────────────────

function toAnthropicTools(tools) {
  return tools.map(t => ({
    name:         t.function.name,
    description:  t.function.description || '',
    input_schema: t.function.parameters,
  }));
}

// OpenAI messages array → Anthropic messages array.
// Tool results (role:'tool') are batched into one user message per turn.
function toAnthropicMessages(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type:  'tool_use',
            id:    tc.id,
            name:  tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
      }
      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Batch all consecutive tool results into one user message
      const toolResults = [];
      while (i < messages.length && messages[i].role === 'tool') {
        toolResults.push({
          type:        'tool_result',
          tool_use_id: messages[i].tool_call_id,
          content:     messages[i].content,
        });
        i++;
      }
      i--; // outer loop will increment
      result.push({ role: 'user', content: toolResults });
    }
  }
  return result;
}

// Anthropic response → OpenAI-compatible shape so agent loops need no changes
function fromAnthropicResponse(response) {
  const textBlocks    = response.content.filter(b => b.type === 'text');
  const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
  return {
    choices: [{
      message: {
        role:       'assistant',
        content:    textBlocks.length ? textBlocks.map(b => b.text).join('') : null,
        tool_calls: toolUseBlocks.length
          ? toolUseBlocks.map(b => ({
              id:       b.id,
              type:     'function',
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            }))
          : null,
      },
    }],
  };
}

// ── Unified send ───────────────────────────────────────────────────────────────

async function chatCompletions({ model, system, messages, tools, max_tokens = 1500 }) {
  if (USE_ANTHROPIC) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey: AI_API_KEY });
    const response  = await client.messages.create({
      model,
      max_tokens,
      system,
      messages:    toAnthropicMessages(messages),
      tools:       tools && tools.length ? toAnthropicTools(tools) : undefined,
      tool_choice: tools && tools.length ? { type: 'auto' } : undefined,
    });
    return fromAnthropicResponse(response);
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: AI_API_KEY, baseURL: AI_BASE_URL });
  return client.chat.completions.create({
    model,
    messages:            [{ role: 'system', content: system }, ...messages],
    tools,
    tool_choice:         'auto',
    parallel_tool_calls: false,
    max_tokens,
  });
}

module.exports = { chatCompletions, USE_ANTHROPIC, AI_PROVIDER };
