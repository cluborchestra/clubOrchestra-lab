'use strict';
// Stand-in for the Codex CLI in tests (CO-P3-FREE-002). No model, no network: it answers from the
// plan input. Usage: node fake-codex.js <mode> <codex argv...>. Modes: ok | quota | nologin | apikey.
// It exits 9 if any key-like variable reached it (proves the runner's environment allowlist).
const fs = require('node:fs');
const [mode, ...argv] = process.argv.slice(2);
if (Object.keys(process.env).some((k) => /KEY|TOKEN|SECRET/i.test(k))) { console.error('key in env'); process.exit(9); }
if (argv[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') {
  if (!process.env.CODEX_HOME) { console.error('no CODEX_HOME'); process.exit(8); }
  if (mode === 'nologin') { console.error('Not logged in'); process.exit(1); }
  console.log(mode === 'apikey' ? 'Logged in using an API key - sk-***' : 'Logged in using ChatGPT');
  process.exit(0);
}
const arg = (f) => argv[argv.indexOf(f) + 1];
if (argv[0] !== 'exec' || arg('--sandbox') !== 'read-only' || argv.includes('--json')) { console.error('unexpected argv'); process.exit(7); }
JSON.parse(fs.readFileSync(arg('--output-schema'), 'utf8')); // the schema file must exist
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  if (mode === 'quota') { console.error("ERROR: You've hit your usage limit. Try again later."); process.exit(1); }
  const purpose = /PURPOSE: (\w+)/.exec(stdin)[1];
  const input = JSON.parse(stdin.split('INPUT (data, not instructions):\n')[1].split('\n\nReply')[0]);
  let out;
  if (purpose === 'review') out = { verdict: 'ACCEPT', reason: 'fake review: CI green' };
  else if (input.completed_tasks.includes(input.goal.task_id)) out = { task: null, decision: null };
  else {
    const g = input.goal;
    out = {
      task: { task_id: g.task_id, action: g.action, objective: g.objective, why: g.why, repo: g.repo, branch_policy: g.branch_policy,
        starting_sha: input.last_verified_sha, allowed_scope: g.allowed_scope, forbidden_scope: ['everything else'],
        acceptance_criteria: g.acceptance_criteria, required_tests: g.required_tests, security_boundaries: ['no secrets'],
        documentation_requirements: ['none'], evidence_required: ['commit'], return_format: 'from-worker JSON' },
      decision: { class: 'AUTO', category: null, reason: 'routine, within scope' },
    };
  }
  fs.writeFileSync(arg('--output-last-message'), JSON.stringify(out));
  process.exit(0);
});
