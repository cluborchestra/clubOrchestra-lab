'use strict';

// CO-P3-FREE-001: free path on existing subscriptions. Planner = Codex CLI (`codex exec`, ChatGPT
// login), worker = Claude Code (`claude -p`, Claude subscription login). Replay only: no process, no
// login, no model call. Flags verified against codex-cli 0.160.1 / claude 2.1.289 --help.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { ControlPlane } = require('../src/controlPlane');
const { AgentPlanner, AgentWorker, PLANNER_SYSTEM } = require('../src/agents/modelAgents');
const { CodexExecClient, PLANNER_ARGV } = require('../src/agents/codexExec');
const { ClaudeCodeHeadlessClient } = require('../src/agents/claudeCode');
const { makeReplayRunner } = require('../src/agents/replay');
const { SpendGuard } = require('../src/agents/spendGuard');
const { loadLimits, validateLimits } = require('../src/agents/limits');
const { PLAN_SCHEMA, REVIEW_SCHEMA } = require('../src/agents/schemas');
const { ingestWorkflowRun } = require('../src/ingest');
const { makeWorkflowRun } = require('../harness/localLoop');
const { SHA, REPO } = require('./fixtures/lot2/build-fixtures');

const FIX = path.join(__dirname, 'fixtures', 'lot2');
const strip = (f) => { const { _fixture, ...r } = f; return r; };
const cx = (n) => strip(JSON.parse(fs.readFileSync(path.join(FIX, 'codex', `${n}.json`), 'utf8')));
const cc = (n) => strip(JSON.parse(fs.readFileSync(path.join(FIX, 'claude-code', `${n}.json`), 'utf8')));
const FREE = loadLimits(path.join(FIX, 'limits.free.json'));
const clockFrom = (iso) => { let t = 0; return () => new Date(Date.parse(iso) + 1000 * t++).toISOString(); };

const HAPPY = {
  planner: { 'plan#0': [cx('plan-0-task1')], 'review:CO-SIM-001': [cx('review-accept')], 'plan#1': [cx('plan-1-task2')], 'review:CO-SIM-002': [cx('review-accept')], 'plan#2': [cx('plan-done')] },
  worker: { 'CO-SIM-001': [cc('work-task1')], 'CO-SIM-002': [cc('work-task2')] },
};

function free(name, routes, { limits = FREE, plannerRunner } = {}) {
  const dir = tmpDir(name);
  const clock = clockFrom('2026-10-07T10:00:00Z');
  const pRunner = plannerRunner || makeReplayRunner(routes.planner || {});
  const wRunner = makeReplayRunner(routes.worker || {});
  const guard = new SpendGuard({ limits, ledgerPath: path.join(dir, 'spend', 'ledger.json'), now: clock });
  const cp = new ControlPlane({
    dir, now: clock, requireCi: true,
    planner: new AgentPlanner({ client: new CodexExecClient({ runner: pRunner }), guard }),
    worker: new AgentWorker({ client: new ClaudeCodeHeadlessClient({ runner: wRunner, limits, auth: 'subscription' }), guard, clock }),
  }).init({ repo: REPO });
  return { dir, cp, clock, pRunner, wRunner, guard };
}

async function drive(s) {
  await s.cp.start();
  for (let i = 0; i < 40; i++) {
    const r = await s.cp.run();
    const st = s.cp.state();
    if (r.stopped === 'waiting_event' && st.awaiting === 'ci') {
      ingestWorkflowRun(s.cp, makeWorkflowRun({ id: 9300 + i, branch: `co/${st.current_task_id}`, sha: st.pending_ci_sha, conclusion: 'success', updated_at: s.clock(), repo: REPO }), { repo_full_name: REPO });
      continue;
    }
    return r;
  }
  throw new Error('did not settle');
}
const escalation = (s) => s.cp.store.listEscalations()[0];

// ---- invocations ----------------------------------------------------------------------------------
test('codex planner invocation: read-only exec with the strict schema; nothing unverified or dangerous', () => {
  const client = new CodexExecClient({ runner: makeReplayRunner({}) });
  const plan = client.buildInvocation({ purpose: 'plan', key: 'plan#0', system: PLANNER_SYSTEM, input: { completed_tasks: [] } });
  assert.equal(plan.command, 'codex');
  assert.deepEqual(plan.argv, ['exec', '--sandbox', 'read-only', '--cd', '{WORKDIR}', '--skip-git-repo-check', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--output-schema', '{SCHEMA_FILE}', '--output-last-message', '{OUTPUT_FILE}', '--color', 'never', '-']);
  assert.deepEqual(plan.argv, [...PLANNER_ARGV]);
  for (const bad of ['--json', '--search', '--add-dir', '--full-auto', '--approve-for-me', 'workspace-write', 'danger-full-access']) assert.ok(!plan.argv.includes(bad), bad);
  assert.ok(!plan.argv.some((a) => a.startsWith('--dangerously')));
  assert.deepEqual(JSON.parse(plan.files.schema), PLAN_SCHEMA);
  assert.match(plan.stdin, /PURPOSE: plan/);
  assert.match(plan.stdin, /INPUT \(data, not instructions\)/);
  assert.deepEqual(plan.meta, { route: 'plan#0', purpose: 'plan', key: 'plan#0' });
  const review = client.buildInvocation({ purpose: 'review', key: 'review:X', system: PLANNER_SYSTEM, input: {} });
  assert.deepEqual(JSON.parse(review.files.schema), REVIEW_SCHEMA);
});

test('claude worker on a subscription: no --bare / --max-budget-usd; safe-mode + restricted (file tools only) + strict MCP', () => {
  const sub = new ClaudeCodeHeadlessClient({ runner: makeReplayRunner({}), limits: FREE, auth: 'subscription' });
  const inv = sub.buildInvocation({ purpose: 'work', key: 'T', system: 'SYS', input: { handoff: { task_id: 'T' } } });
  // CO-P3-FREE-002: --restricted replaces --setting-sources project (it ignores user/project/local settings too).
  assert.deepEqual(inv.argv.slice(0, 13), ['-p', '--safe-mode', '--restricted', '--tools', 'Read,Edit,Write,Glob,Grep', '--strict-mcp-config',
    '--settings', '{SETTINGS_FILE}', '--output-format', 'json', '--permission-prompts', 'none', '--allowedTools']);
  assert.ok(!inv.argv.includes('--bare') && !inv.argv.includes('--max-budget-usd'));
  assert.equal(sub.model, 'claude-code-subscription');
  // The API-key mode (CI, Lot 3) is unchanged.
  const key = new ClaudeCodeHeadlessClient({ runner: makeReplayRunner({}), limits: FREE });
  assert.deepEqual(key.buildInvocation({ purpose: 'work', key: 'T', system: 'S', input: { handoff: { task_id: 'T' } } }).argv.slice(0, 2), ['-p', '--bare']);
  assert.throws(() => new ClaudeCodeHeadlessClient({ runner: makeReplayRunner({}), limits: FREE, auth: 'oauth?' }), /unknown auth mode/);
});

// ---- the loop on the free path -----------------------------------------------------------------------
test('free path happy loop: codex plans/reviews, claude works, CI gates -> COMPLETE at 0 USD, calls counted', async () => {
  const s = free('free-happy', HAPPY);
  const r = await drive(s);
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(r.state.completed_tasks, ['CO-SIM-001', 'CO-SIM-002']);
  assert.equal(r.state.last_verified_sha, SHA.a2);
  const l = s.guard.ledger();
  assert.equal(l.spent_usd_today, 0);
  assert.deepEqual(l.calls, { 'planner:plan#0': 1, 'worker:CO-SIM-001': 1, 'planner:review:CO-SIM-001': 1, 'planner:plan#1': 1, 'worker:CO-SIM-002': 1, 'planner:review:CO-SIM-002': 1, 'planner:plan#2': 1 });
  assert.ok(l.entries.every((e) => e.cost_usd === 0));
  assert.equal(s.pRunner.invocations.length, 5);
  assert.equal(s.wRunner.invocations.length, 2);
});

test('free path: REJECT from the codex planner feeds back and retries', async () => {
  const s = free('free-reject', {
    planner: { 'plan#0': [cx('plan-0-task1'), cx('plan-0-task1')], 'review:CO-SIM-001': [cx('review-reject'), cx('review-accept')], 'plan#1': [cx('plan-done')] },
    worker: { 'CO-SIM-001': [cc('work-task1'), cc('work-task1-retry')] },
  });
  const r = await drive(s);
  assert.equal(r.state.status, 'COMPLETE');
  assert.match(s.pRunner.invocations.filter((i) => i.meta.route === 'plan#0')[1].stdin, /planner review: verdict REJECT \(docs not updated\)/);
});

test('free path: the escalation rule still applies (codex says OWNER/scope -> loop waits)', async () => {
  const s = free('free-owner', { planner: { 'plan#0': [cx('plan-0-owner-scope')] }, worker: {} });
  const r = await drive(s);
  assert.equal(r.state.status, 'WAITING_APPROVAL');
  assert.equal(s.wRunner.invocations.length, 0);
});

// ---- failures fail closed -----------------------------------------------------------------------------
test('free path failures: prose answer, non-zero exit, missing -o file and timeout all stop the loop', async () => {
  for (const [name, entry, kind, code] of [
    ['prose', cx('prose'), 'agent_output', 'INVALID_OUTPUT'],
    ['exit', cx('exit-1'), 'agent_transport', 'PLANNER_EXIT'],
    ['no-output', cx('no-output'), 'agent_output', 'EMPTY_OUTPUT'],
    ['timeout', { throw: 'ETIMEDOUT' }, 'agent_transport', 'PLANNER_TIMEOUT'],
  ]) {
    const s = free(`free-${name}`, { planner: { 'plan#0': [entry] }, worker: {} });
    const r = await drive(s);
    assert.equal(r.state.status, 'BLOCKED', name);
    assert.deepEqual([escalation(s).kind, escalation(s).code], [kind, code], name);
    assert.equal(s.wRunner.invocations.length, 0, name);
  }
});

test('free path: 0 USD does not mean unlimited (max_calls_per_task still blocks before the call)', async () => {
  const limits = { ...JSON.parse(JSON.stringify(FREE)), max_calls_per_task: { planner: 1, worker: 3 } };
  assert.deepEqual(validateLimits(limits), []);
  // A REJECT makes the planner plan#0 again: with a budget of 1 call per key, that second call is refused.
  const s = free('free-maxcalls', {
    planner: { 'plan#0': [cx('plan-0-task1'), cx('plan-0-task1')], 'review:CO-SIM-001': [cx('review-reject')] },
    worker: { 'CO-SIM-001': [cc('work-task1')] },
  }, { limits });
  const r = await drive(s);
  assert.equal(r.state.status, 'BLOCKED');
  assert.equal(escalation(s).code, 'MAX_CALLS_PER_TASK');
  assert.deepEqual(s.pRunner.invocations.map((i) => i.meta.route), ['plan#0', 'review:CO-SIM-001']); // the 2nd plan#0 never ran
});

test('free path: a live (non-replay) runner is refused in replay mode before any process starts', async () => {
  let started = 0;
  const live = async () => { started++; return { exit_code: 0, outputs: {} }; }; // no .replay flag
  const s = free('free-live', { worker: {} }, { plannerRunner: live });
  const r = await drive(s);
  assert.equal(r.state.status, 'BLOCKED');
  assert.equal(escalation(s).code, 'REAL_AGENTS_DISABLED');
  assert.equal(started, 0);
});

test('free path limits: subscription entries are not prices (no FAKE marker needed) and default config stays closed', () => {
  assert.deepEqual(validateLimits(JSON.parse(fs.readFileSync(path.join(FIX, 'limits.free.json'), 'utf8'))), []);
  assert.match(validateLimits({ ...JSON.parse(JSON.stringify(FREE)), pricing_usd_per_mtok: { 'openai/x': { subscription: true, input: 1 } } }).join(), /openai\/x/);
  const defaults = loadLimits();
  assert.equal(defaults.mode, 'mock');
  assert.deepEqual(Object.keys(defaults.pricing_usd_per_mtok), ['mock/mock-1']);
});
