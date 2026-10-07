'use strict';
// Stand-in for Claude Code in tests (CO-P3-FREE-002). No model, no network. Usage:
// node fake-claude.js <mode> <claude argv...>. Modes: ok | leak | nodenial | quota | nologin | apikey | sneaky | nothing.
// It refuses (exit 7) unless the worker invocation is the hardened one: --restricted, file tools only,
// the settings file blocking reads outside the working directory, path rules only.
const fs = require('node:fs');
const path = require('node:path');
const [mode, ...argv] = process.argv.slice(2);
if (Object.keys(process.env).some((k) => /KEY|TOKEN|SECRET/i.test(k))) { console.error('key in env'); process.exit(9); }
if (argv[0] === '--version') { console.log('2.1.289 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (mode === 'nologin') { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
  console.log(JSON.stringify(mode === 'apikey' ? { loggedIn: true, authMethod: 'api_key' } : { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
const arg = (f) => argv[argv.indexOf(f) + 1];
const settings = JSON.parse(fs.readFileSync(arg('--settings'), 'utf8'));
const hardened = argv[0] === '-p' && argv.includes('--restricted') && argv.includes('--safe-mode') && arg('--tools') === 'Read,Edit,Write,Glob,Grep'
  && arg('--permission-prompts') === 'none' && !argv.includes('--bare') && !/Bash|PowerShell/.test(arg('--allowedTools'))
  && settings.permissions.blockReadsOutsideWorkingDirectories === true;
if (!hardened) { console.error(`not hardened: ${argv.join(' ')}`); process.exit(7); }
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const h = JSON.parse(stdin.split('HANDOFF:\n')[1]);
  const res = (result, extra = {}) => { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result, total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 }, permission_denials: [], ...extra })); process.exit(0); };
  const json = (outcome, more = {}) => JSON.stringify({ task_id: h.task_id, outcome, starting_sha: h.starting_sha, ending_sha: h.starting_sha, files_changed: [],
    tests: [], ci: { status: 'pending' }, docs_synced: true, risks: [], blockers: [], next_recommendation: 'await CI', ...more });
  if (mode === 'quota') { console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1791300000' })); process.exit(1); }
  if (h.task_id === 'PROBE-READ-OUTSIDE') {
    const p = /read the file at (.+?) with exactly/.exec(h.objective)[1];
    if (mode === 'leak') res(json('PASS', { risks: [fs.readFileSync(p, 'utf8').trim()] }));
    if (mode === 'nodenial') res(json('BLOCKED', { blockers: ['I chose not to try'] }));
    res(json('BLOCKED', { blockers: ['Read denied'] }), { permission_denials: [{ tool_name: 'Read', tool_use_id: 'toolu_fake', tool_input: { file_path: p } }] });
  }
  if (mode !== 'nothing') {
    const f = mode === 'sneaky' ? 'src/evil.js' : h.allowed_scope[0];
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, mode === 'sneaky' ? 'module.exports = 1;\n' : 'hello from clubOrchestra\n');
  }
  res(json('PASS', { files_changed: [h.allowed_scope[0]] }));
});
