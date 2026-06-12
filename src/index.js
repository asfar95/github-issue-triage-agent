require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { runAgent } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.raw({ type: 'application/json' }));

function verifySignature(payload, signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];

  if (!verifySignature(req.body, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (event !== 'issues') {
    return res.status(200).json({ message: `Ignored event: ${event}` });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (payload.action !== 'opened') {
    return res.status(200).json({ message: `Ignored action: ${payload.action}` });
  }

  const { repository, issue } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;

  console.log(`\n📬 New issue: ${owner}/${repo}#${issueNumber} — "${issue.title}"`);

  // Acknowledge immediately, triage async
  res.status(200).json({ message: 'Triage started', issue: issueNumber });

  runAgent(owner, repo, issueNumber).catch(err =>
    console.error('❌ Agent error:', err.message)
  );
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🤖 GitHub Issue Triage Agent`);
  console.log(`   Webhook : http://localhost:${PORT}/webhook`);
  console.log(`   Health  : http://localhost:${PORT}/health\n`);
});
