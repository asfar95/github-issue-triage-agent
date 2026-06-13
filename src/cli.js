require('dotenv').config();
const { runAgent } = require('./agent');

// Usage: node src/cli.js <owner>/<repo> <issue_number>
// Example: node src/cli.js asfar95/ai-agent-playground 1

const [, , repoArg, issueArg] = process.argv;

if (!repoArg || !issueArg) {
  console.error('Usage: node src/cli.js <owner>/<repo> <issue_number>');
  process.exit(1);
}

const [owner, repo] = repoArg.split('/');
const issueNumber = parseInt(issueArg, 10);

if (!owner || !repo || isNaN(issueNumber)) {
  console.error('Invalid arguments. Example: node src/cli.js asfar95/ai-agent-playground 1');
  process.exit(1);
}

runAgent(owner, repo, issueNumber)
  .then(result => {
    console.log(`\n🏁 Done — ${result.iterations} iteration(s)`);
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
