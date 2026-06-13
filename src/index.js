require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const { runAgent } = require('./agent');

const ROUTER_PORT = parseInt(process.env.ROUTER_PORT || '3000', 10);

function signalTriageDone(owner, repo, issueNumber) {
  const body = JSON.stringify({ owner, repo, issueNumber });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: ROUTER_PORT,
      path: '/internal/triage-done', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', err => {
      console.warn(`  ⚠️  Could not signal triage-done: ${err.message}`);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

const app = express();
const PORT = process.env.PORT || 3002;

function verifySignature(rawBody, signature) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  await new Promise(resolve => req.on('end', resolve));
  const rawBody = Buffer.concat(chunks);
  if (!verifySignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (event !== 'issues') {
    return res.status(200).json({ message: `Ignored event: ${event}` });
  }

  let payload;
  try {
    let bodyStr = rawBody.toString();
    if (bodyStr.startsWith('payload=')) bodyStr = decodeURIComponent(bodyStr.slice(8));
    payload = JSON.parse(bodyStr);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { action, repository, issue } = payload;

  if (action !== 'opened' && action !== 'reopened') {
    return res.status(200).json({ message: `Ignored action: ${action}` });
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;
  const isReopen = action === 'reopened';

  console.log(`\n📬 Issue ${isReopen ? 'reopened' : 'opened'}: ${owner}/${repo}#${issueNumber} — "${issue.title}"`);

  // Acknowledge immediately, triage async
  res.status(200).json({ message: 'Triage started', issue: issueNumber });

  // Always signal triage-done (even on failure) so the router can unblock autofix.
  (async () => {
    try {
      await runAgent(owner, repo, issueNumber, { skipIdempotency: isReopen });
    } catch (err) {
      console.error('❌ Agent error:', err.message);
    } finally {
      await signalTriageDone(owner, repo, issueNumber);
    }
  })();
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🤖 GitHub Issue Triage Agent`);
  console.log(`   Webhook : http://localhost:${PORT}/webhook`);
  console.log(`   Health  : http://localhost:${PORT}/health\n`);
});
