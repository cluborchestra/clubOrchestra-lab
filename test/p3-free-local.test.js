'use strict';

// CO-P3-FREE-002: the live runner (src/agents/live.js) and the local free-path run
// (harness/run-local-free.js), driven by FAKE CLIs (test/fixtures/fake-cli): real processes, real git
// clone and commits, no model, no login, no network. The fakes refuse a non-hardened worker
// invocation and exit 9 if any key-like variable reaches them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir } = require('./helpers');
const { makeLiveRunner, childEnv } = require('../src/agents/live');
const { SpendGuard } = require('../src/agents/spendGuard');
const { loadLimits, validateLimits } = require('../src/agents/limits');
const { ClaudeCodeHeadlessClient } = require('../src/agents/claudeCode');
const { CodexExecClient } = require('../src/agents/codexExec');
const { AgentWorker, callModel } = require('../src/agents/modelAgents');
const { makeReplayRunner } = require('../src/agents/replay');
const { runLocalFree, inScope, judgeClaudeAuth, judgeCodexLogin } = require('../harness/run-local-free');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-cli');
const LOCAL = loadLimits(path.join(ROOT, 'config', 'agent-limits.local-free.json'));
const node = (...args) => ({ file: process.execPath, args });
const fakes = (claude = 'ok', codex = 'ok') => ({ claude: node(path.join(FAKE, 'fake-claude.js'), claude), codex: node(path.join(FAKE, 'fake-codex.js'), codex) });
// The owner's shell might have keys set: the runner must never pass them on. Not in CI (the run refuses CI).
const ENV = (() => { const e = { ...process.env, OPENAI_API_KEY: 'sk-test-not-real', ANTHROPIC_API_KEY: 'sk-ant-test-not-real', CODEX_ACCESS_TOKEN: 'x' }; delete e.CI; delete e.GITHUB_ACTIONS; return e; })();

function dirs(name) {
  const d = tmpDir(name);
  const workdir = path.join(d, 'work');
  fs.mkdirSync(workdir);
  return { d, workdir, scratchDir: path.join(d, 'scratch'), codexHome: path.join(d, 'codex-home') };
}

async function run(name, { claude = 'ok', codex = 'ok', ci = 'process.exit(0)', ...more } = {}) {
  const d = tmpDir(name);
  const marker = path.join(d, 'ci-runs.txt');
  const report = await runLocalFree({
    env: ENV, log: () => {}, baseDir: d, codexHome: path.join(d, 'codex-home'), commands: fakes(claude, codex), npmCi: false,
    ciArgs: ['-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); ${ci}`], ...more,
  });
  const ciCount = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').length : 0;
  const kinds = (report.invocations || []).map((i) => `${i.command}:${i.meta.purpose}`);
  return { report, ciCount, kinds };
}

// ---- live runner --------------------------------------------------------------------------------------
test('live runner: local only, scratch outside the clone, absolute binaries', () => {
  const { workdir, scratchDir, codexHome } = dirs('live-guards');
  const base = { commands: fakes(), workdir, scratchDir, codexHome, env: ENV };
  assert.throws(() => makeLiveRunner({ ...base, env: { ...ENV, CI: 'true' } }), /local-only/);
  assert.throws(() => makeLiveRunner({ ...base, env: { ...ENV, GITHUB_ACTIONS: 'true' } }), /local-only/);
  assert.throws(() => makeLiveRunner({ ...base, scratchDir: path.join(workdir, 'x') }), /outside the working directory/);
  assert.throws(() => makeLiveRunner({ ...base, codexHome: path.join(workdir, 'h') }), /outside the working directory/);
  assert.throws(() => makeLiveRunner({ ...base, commands: { codex: { file: 'codex' } } }), /absolute path/);
  const r = makeLiveRunner(base);
  assert.equal(r.live, true);
  assert.equal(r.replay, undefined); // never a replay runner
});

test('live runner: environment allowlist (no key, token or base URL can reach a CLI)', () => {
  const env = childEnv({ ...ENV, ANTHROPIC_BASE_URL: 'http://evil', NODE_OPTIONS: '--require x', MY_SECRET: 's', PATH: 'p' }, { CODEX_HOME: 'h' });
  assert.deepEqual(Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|BASE_URL|NODE_OPTIONS/i.test(k)), []);
  assert.equal(env.CODEX_HOME, 'h');
  assert.throws(() => childEnv({}, { OPENAI_API_KEY: 'x' }), /refusing/);
});

test('live runner: codex call writes the schema file, substitutes placeholders and reads the -o file', async () => {
  const { workdir, scratchDir, codexHome } = dirs('live-codex');
  const runner = makeLiveRunner({ commands: fakes(), workdir, scratchDir, codexHome, env: ENV });
  const client = new CodexExecClient({ runner });
  const goal = { task_id: 'T-1', action: 'implement', objective: 'o', why: 'w', repo: 'r', branch_policy: 'b', allowed_scope: ['work/a.md'], acceptance_criteria: ['a'], required_tests: ['t'] };
  const res = await client.complete({ purpose: 'plan', key: 'plan#0', system: 'SYS', input: { completed_tasks: [], last_verified_sha: 'a'.repeat(40), goal } });
  assert.equal(JSON.parse(res.text).task.task_id, 'T-1');
  const inv = runner.invocations[0];
  assert.ok(inv.argv.includes(workdir) && !inv.argv.some((a) => /^\{[A-Z_]+\}$/.test(a)));
  assert.ok(fs.existsSync(path.join(scratchDir, '001-codex-schema.json')));
  assert.ok(inv.env_keys.includes('CODEX_HOME'));
  assert.ok(inv.env_keys.every((k) => !/KEY|TOKEN/i.test(k))); // the fake would have exited 9 otherwise
  assert.equal(inv.exit_code, 0);
});

test('live runner: unresolved placeholder fails before any process; timeout and output cap kill the process', async () => {
  const { workdir, scratchDir, codexHome } = dirs('live-fail');
  const runner = makeLiveRunner({ commands: { codex: node('-e', 'setTimeout(() => {}, 20000)'), claude: node('-e', "process.stdout.write('x'.repeat(5000))") },
    workdir, scratchDir, codexHome, env: ENV, timeoutsMs: { codex: 300, claude: 5000 }, maxOutputBytes: 1000 });
  await assert.rejects(runner({ command: 'codex', argv: ['{NOPE_FILE}'], stdin: '', meta: {} }), { code: 'UNRESOLVED_PLACEHOLDER' });
  assert.equal(runner.invocations.length, 0);
  await assert.rejects(runner({ command: 'codex', argv: [], stdin: '', meta: {} }), { code: 'ETIMEDOUT' });
  await assert.rejects(runner({ command: 'claude', argv: [], stdin: '', meta: {} }), { code: 'EOUTPUTLIMIT' });
  await assert.rejects(runner({ command: 'other', argv: [], stdin: '', meta: {} }), { code: 'UNKNOWN_COMMAND' });
});

// ---- guard + limits -----------------------------------------------------------------------------------
test('local-subscription mode: live runner allowed only for subscription models; no paid route can be configured', async () => {
  const { d, workdir, scratchDir, codexHome } = dirs('live-guard-mode');
  const runner = makeLiveRunner({ commands: fakes(), workdir, scratchDir, codexHome, env: ENV });
  const guard = new SpendGuard({ limits: LOCAL, ledgerPath: path.join(d, 'ledger.json') });
  // API-key Claude (model claude-code-headless) has no subscription entry -> refused before any process
  const paid = new ClaudeCodeHeadlessClient({ runner, limits: LOCAL });
  await assert.rejects(callModel({ client: paid, guard, role: 'worker', key: 'T', purpose: 'work', system: 'S', input: { handoff: { task_id: 'T' } } }), { code: 'REAL_AGENTS_DISABLED' });
  assert.equal(runner.invocations.length, 0);
  // the same live runner in replay mode -> refused
  const replayLimits = loadLimits(path.join(__dirname, 'fixtures', 'lot2', 'limits.free.json'));
  const rguard = new SpendGuard({ limits: replayLimits, ledgerPath: path.join(d, 'ledger2.json') });
  await assert.rejects(callModel({ client: new CodexExecClient({ runner }), guard: rguard, role: 'planner', key: 'plan#0', purpose: 'plan', system: 'S', input: {} }), { code: 'REAL_AGENTS_DISABLED' });
  assert.equal(runner.invocations.length, 0);
  // config: paid prices, non-zero caps, shell tools, paths outside the clone -> invalid
  const bad = (patch) => validateLimits({ ...JSON.parse(JSON.stringify(LOCAL)), ...patch }).join(' | ');
  assert.match(bad({ pricing_usd_per_mtok: { 'openai/gpt-x': { input: 1, output: 1 } }, _PRICING_NOTE: 'FAKE — not real pricing' }), /no paid route/);
  assert.match(bad({ pricing_usd_per_mtok: { 'anthropic/claude-code-headless': { reported_cost: true } }, _PRICING_NOTE: 'FAKE — not real pricing' }), /no paid route/);
  assert.match(bad({ per_call_max_usd: 0.25 }), /must be 0/);
  for (const rule of ['Bash(npm test)', 'Read(//c/**)', 'Read(~/x)', 'Edit(./../x)', 'Write(./**)', 'Read']) {
    assert.match(bad({ claude_code: { version: '2.1.289', allowed_tools: [rule] } }), /inside the working directory/, rule);
  }
  assert.deepEqual(LOCAL.claude_code.allowed_tools, ['Read(./**)', 'Edit(./**)']); // Edit rules also cover Write (docs)
  assert.equal(loadLimits().mode, 'mock'); // the default config (CI, orchestrator) stays closed
});

test('subscription worker invocation is hardened: --restricted, file tools only, reads outside blocked, path rules', () => {
  const c = new ClaudeCodeHeadlessClient({ runner: makeReplayRunner({}), limits: LOCAL, auth: 'subscription' });
  const inv = c.buildInvocation({ purpose: 'work', key: 'T', system: 'S', input: { handoff: { task_id: 'T' } } });
  const at = (f) => inv.argv[inv.argv.indexOf(f) + 1];
  assert.ok(inv.argv.includes('--restricted') && inv.argv.includes('--safe-mode') && inv.argv.includes('--strict-mcp-config'));
  assert.equal(at('--tools'), 'Read,Edit,Write,Glob,Grep');
  assert.equal(at('--allowedTools'), 'Read(./**),Edit(./**)');
  assert.equal(at('--settings'), '{SETTINGS_FILE}');
  assert.equal(at('--permission-prompts'), 'none');
  assert.deepEqual(JSON.parse(inv.files.settings), { permissions: { blockReadsOutsideWorkingDirectories: true } });
  assert.ok(!inv.argv.some((a) => /Bash|PowerShell|--bare|--add-dir|dangerously|bypassPermissions/.test(a)));
  assert.match(inv.stdin, /the runner commits/);
});

test('quota / login failures get their own codes (codex exit text, claude result text)', async () => {
  const cx = new CodexExecClient({ runner: Object.assign(async () => ({ exit_code: 1, stdout: '', stderr: "ERROR: You've hit your usage limit.", outputs: {} }), { replay: true }) });
  await assert.rejects(cx.complete({ purpose: 'plan', key: 'plan#0', system: 'S', input: {} }), { code: 'QUOTA_EXHAUSTED' });
  const cx2 = new CodexExecClient({ runner: Object.assign(async () => ({ exit_code: 1, stdout: '', stderr: 'Error: Not logged in', outputs: {} }), { replay: true }) });
  await assert.rejects(cx2.complete({ purpose: 'plan', key: 'plan#0', system: 'S', input: {} }), { code: 'AUTH_REQUIRED' });
  const cx3 = new CodexExecClient({ runner: Object.assign(async () => ({ exit_code: 2, stdout: '', stderr: 'boom', outputs: {} }), { replay: true }) });
  await assert.rejects(cx3.complete({ purpose: 'plan', key: 'plan#0', system: 'S', input: {} }), { code: 'PLANNER_EXIT' }); // unknown text: still fails closed
  const cl = new ClaudeCodeHeadlessClient({ limits: LOCAL, auth: 'subscription', runner: Object.assign(async () => ({ exit_code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1791300000' }), stderr: '' }), { replay: true }) });
  const r = await cl.complete({ purpose: 'work', key: 'T', system: 'S', input: { handoff: { task_id: 'T' } } });
  assert.equal(r.error.code, 'QUOTA_EXHAUSTED');
});

// ---- the run script, end to end with fake CLIs ---------------------------------------------------------------
test('run-local-free (fakes): test 1 completes; read probe VERIFIED; owner dir unchanged; 0 USD; calls counted', async () => {
  const { report, ciCount, kinds } = await run('free-run-ok');
  assert.equal(report.stop, null, JSON.stringify(report.stop));
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks, {
    baseline_ci_green: true, read_outside_denied: 'VERIFIED', plan_schema_valid_and_auto: true, worker_json_parsed: true,
    commit_on_task_branch: true, task_output_correct: true, ci_green: true, review_accept_and_complete: true, no_protected_path: true,
    ledger_zero_usd: true, owner_workdir_unchanged: true, no_key_in_child_env: true,
  });
  assert.deepEqual(kinds, ['claude:probe', 'codex:plan', 'claude:work', 'codex:review', 'codex:plan']);
  assert.deepEqual(report.loop.ledger.calls, { 'worker:probe:read-outside': 1, 'planner:plan#0': 1, 'worker:CO-FREE-001': 1, 'planner:review:CO-FREE-001': 1, 'planner:plan#1': 1 });
  assert.equal(ciCount, 3); // baseline + the runner's tests on the commit + CI
  assert.deepEqual(report.loop.commits[0].files, ['work/CO-FREE-001.md']);
  assert.equal(report.owner_interventions, 0);
  assert.equal(report.versions.claude, '2.1.289 (Claude Code)');
  assert.ok(fs.existsSync(path.join(report.run_dir, 'report.md')) && fs.existsSync(path.join(report.run_dir, 'run-log.json')));
  // the clone has no remote: nothing in the run can push anywhere
  assert.equal(execFileSync('git', ['remote'], { cwd: path.join(report.run_dir, 'repo'), encoding: 'utf8' }).trim(), '');
});

test('run-local-free (fakes): a read outside the clone stops the run before any task work (LEAK)', async () => {
  const { report, ciCount, kinds } = await run('free-run-leak', { claude: 'leak' });
  assert.equal(report.stop.code, 'READ_LEAK');
  assert.equal(report.checks.read_outside_denied, 'LEAK');
  assert.deepEqual(kinds, ['claude:probe']); // the planner was never called
  assert.equal(ciCount, 1);
  assert.equal(report.ok, false);
});

test('run-local-free (fakes): no denial recorded -> UNVERIFIED, and test 1 still runs', async () => {
  const { report } = await run('free-run-nodenial', { claude: 'nodenial' });
  assert.equal(report.checks.read_outside_denied, 'UNVERIFIED');
  assert.equal(report.loop.status, 'COMPLETE');
  assert.equal(report.ok, true);
});

test('run-local-free (fakes): logins are checked before any model call and stop with a clear message', async () => {
  for (const [opts, code] of [[{ codex: 'nologin' }, 'CODEX_NOT_LOGGED_IN'], [{ codex: 'apikey' }, 'CODEX_API_KEY_AUTH'],
    [{ claude: 'nologin' }, 'CLAUDE_NOT_LOGGED_IN'], [{ claude: 'apikey' }, 'CLAUDE_API_KEY_AUTH']]) {
    const { report, kinds, ciCount } = await run(`free-run-${code}`, opts);
    assert.equal(report.stop.code, code);
    assert.match(report.stop.message, /innskráð|API/);
    assert.deepEqual(kinds, [], code); // no model call
    assert.equal(ciCount, 0, code);
  }
});

test('run-local-free (fakes): exhausted quota stops at once with QUOTA_EXHAUSTED (claude at the probe, codex at the first plan)', async () => {
  const a = await run('free-run-quota-claude', { claude: 'quota' });
  assert.equal(a.report.stop.code, 'QUOTA_EXHAUSTED');
  assert.match(a.report.stop.message, /Kvóti/);
  assert.deepEqual(a.kinds, ['claude:probe']);
  const b = await run('free-run-quota-codex', { codex: 'quota' });
  assert.equal(b.report.stop.code, 'QUOTA_EXHAUSTED');
  assert.deepEqual(b.kinds, ['claude:probe', 'codex:plan']); // stopped at the first loop call, nothing dispatched
  assert.equal(b.report.loop.status, 'BLOCKED');
});

test('run-local-free (fakes): a write outside the allowed scope / to a protected path is never run by CI', async () => {
  const { report, ciCount } = await run('free-run-sneaky', { claude: 'sneaky' });
  assert.equal(report.stop.code, 'SCOPE_VIOLATION');
  assert.match(report.stop.message, /src\/evil\.js/);
  assert.equal(ciCount, 1); // baseline only
  const nothing = await run('free-run-nothing', { claude: 'nothing' });
  assert.equal(nothing.report.stop.code, 'NO_CHANGES');
});

test('run-local-free: red baseline CI stops before any model call; CI env refused; helpers', async () => {
  const { report, kinds } = await run('free-run-red', { ci: 'process.exit(1)' });
  assert.equal(report.stop.code, 'BASELINE_CI_FAILED');
  assert.deepEqual(kinds, []);
  await assert.rejects(runLocalFree({ env: { ...ENV, CI: 'true' }, log: () => {} }), { code: 'LOCAL_ONLY' });
  assert.ok(inScope('work/a.md', ['work/a.md']) && inScope('work/x/y.js', ['work/x/**']) && !inScope('work/b.md', ['work/a.md']));
  assert.equal(judgeClaudeAuth({ exit_code: 0, stdout: '{"loggedIn":true,"weird":1}' }, false).code, 'CLAUDE_AUTH_UNKNOWN');
  assert.equal(judgeClaudeAuth({ exit_code: 0, stdout: '{"loggedIn":true,"weird":1}' }, true).ok, true);
  assert.equal(judgeCodexLogin({ exit_code: 0, stdout: 'Logged in somehow', stderr: '' }).ok, false); // unclear -> stop
});

test('run-local-free without --start starts nothing', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'harness', 'run-local-free.js')], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.match(out, /nothing started/);
});

test('AgentWorker on the live runner: the hardened invocation reaches the CLI (fake refuses anything else)', async () => {
  const { d, workdir, scratchDir, codexHome } = dirs('live-worker');
  const runner = makeLiveRunner({ commands: fakes(), workdir, scratchDir, codexHome, env: ENV });
  const guard = new SpendGuard({ limits: LOCAL, ledgerPath: path.join(d, 'ledger.json') });
  const w = new AgentWorker({ client: new ClaudeCodeHeadlessClient({ runner, limits: LOCAL, auth: 'subscription' }), guard });
  const ev = await w.execute({ task_id: 'T-9', starting_sha: 'b'.repeat(40), allowed_scope: ['work/T-9.md'], repo: 'r' });
  assert.equal(ev.payload.outcome, 'PASS');
  assert.equal(fs.readFileSync(path.join(workdir, 'work', 'T-9.md'), 'utf8'), 'hello from clubOrchestra\n');
  assert.equal(guard.ledger().spent_usd_total, 0);
  assert.ok(fs.existsSync(path.join(scratchDir, '001-claude-settings.json')));
});
