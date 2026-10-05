'use strict';

// P3 Lot 2: replay dry run with the real API shapes.
// The planner uses the OpenAI Responses API (zero-dep adapter + replay transport, judged by
// openai@7.28.0). The worker uses Claude Code headless JSON (replay runner). No network (trap
// installed by helpers), no keys, no live mode, no cost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tmpDir, transitions } = require('./helpers');
const { attempts } = require('./support/no-network');
const { ControlPlane } = require('../src/controlPlane');
const { AgentPlanner, AgentWorker } = require('../src/agents/modelAgents');
const { OpenAIResponsesClient, API_URL } = require('../src/agents/openaiResponses');
const { ClaudeCodeHeadlessClient } = require('../src/agents/claudeCode');
const { makeReplayTransport, makeReplayRunner } = require('../src/agents/replay');
const { SpendGuard, utcDay } = require('../src/agents/spendGuard');
const { loadLimits, validateLimits, FAKE_PRICING_NOTE } = require('../src/agents/limits');
const { SpendBlockedError } = require('../src/agents/errors');
const { ingestWorkflowRun } = require('../src/ingest');
const { makeWorkflowRun } = require('../harness/localLoop');
const { SHA, MODEL, REPO } = require('./fixtures/lot2/build-fixtures');
const { POLICY } = require('../src/policy');

const FIX = path.join(__dirname, 'fixtures', 'lot2');
const strip = (f) => { const { _fixture, ...rest } = f; return rest; };
const oa = (name) => strip(JSON.parse(fs.readFileSync(path.join(FIX, 'openai', `${name}.json`), 'utf8')));
const cc = (name) => strip(JSON.parse(fs.readFileSync(path.join(FIX, 'claude-code', `${name}.json`), 'utf8')));
const LIMITS = loadLimits(path.join(FIX, 'limits.replay.json'));
const limitsWith = (over) => {
  const l = { ...JSON.parse(JSON.stringify(LIMITS)), ...over };
  assert.deepEqual(validateLimits(l), []);
  return l;
};
const clockFrom = (iso) => { let t = 0; return () => new Date(Date.parse(iso) + 1000 * t++).toISOString(); };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const HAPPY = {
  planner: {
    'plan#0': [oa('plan-0-task1')], 'review:CO-SIM-001': [oa('review-accept')],
    'plan#1': [oa('plan-1-task2')], 'review:CO-SIM-002': [oa('review-accept')], 'plan#2': [oa('plan-done')],
  },
  worker: { 'CO-SIM-001': [cc('work-task1')], 'CO-SIM-002': [cc('work-task2')] },
};
const ONE_TASK = (planner, worker) => ({ planner: { 'plan#1': [oa('plan-done')], ...planner }, worker });

// Builds one "run" of the agent layer: guard + clients + adapters + control plane on `dir`.
// transport/runner stand for the outside world and survive across runs.
function instance(dir, { transport, runner, limits = LIMITS, clock, sleeps }) {
  const guard = new SpendGuard({ limits, ledgerPath: path.join(dir, 'spend', 'ledger.json'), now: clock });
  const pClient = new OpenAIResponsesClient({ transport, model: MODEL, limits, sleep: (ms) => sleeps.push(ms) });
  const wClient = new ClaudeCodeHeadlessClient({ runner, limits });
  const cp = new ControlPlane({
    dir, now: clock, requireCi: true,
    planner: new AgentPlanner({ client: pClient, guard }),
    worker: new AgentWorker({ client: wClient, guard, clock }),
  }).init({ repo: REPO });
  return { guard, pClient, wClient, cp };
}

function replay(name, routes, opts = {}) {
  const dir = tmpDir(name);
  const s = {
    dir, clock: clockFrom('2026-10-05T21:00:00Z'), sleeps: [],
    transport: makeReplayTransport(routes.planner || {}), runner: makeReplayRunner(routes.worker || {}),
  };
  s.make = () => Object.assign(s, instance(dir, { ...s, limits: opts.limits || LIMITS }));
  s.make();
  return s;
}

// planner -> worker -> CI (simulated workflow_run) -> planner review -> next task, with no human
// "continue". freshEachStep: a new guard/control-plane instance per step, like separate Actions runs.
function drive(s, { freshEachStep = false } = {}) {
  s.cp.start();
  for (let i = 0; i < 60; i++) {
    if (freshEachStep) s.make();
    const r = s.cp.run({ maxSteps: freshEachStep ? 1 : 100 });
    const st = s.cp.state();
    if (r.stopped === 'waiting_event' && st.awaiting === 'ci') {
      ingestWorkflowRun(s.cp, makeWorkflowRun({ id: 9100 + i, branch: `co/${st.current_task_id}`, sha: st.pending_ci_sha, conclusion: 'success', updated_at: s.clock(), repo: REPO }), { repo_full_name: REPO });
      continue;
    }
    if (freshEachStep && r.stopped === 'max_steps') continue;
    return r;
  }
  throw new Error('drive: did not settle');
}

const ledger = (s) => JSON.parse(fs.readFileSync(path.join(s.dir, 'spend', 'ledger.json'), 'utf8'));
const escalation = (s) => s.cp.store.listEscalations()[0];
const blockedWith = (s, kind, code) => {
  assert.equal(s.cp.state().status, 'BLOCKED');
  const e = escalation(s);
  assert.equal(e.kind, kind);
  assert.equal(e.code, code);
  return e;
};

// ---- 1. happy path --------------------------------------------------------------------------------
test('1 happy path: planner -> worker -> CI -> planner ACCEPT -> next task -> COMPLETE (replayed API shapes)', () => {
  const s = replay('l2-happy', HAPPY);
  const r = drive(s);
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(r.state.completed_tasks, ['CO-SIM-001', 'CO-SIM-002']);
  assert.equal(r.state.last_verified_sha, SHA.a2);
  assert.ok(transitions(s.cp).filter((t) => t === 'WAITING_EVENT->RUNNING').length === 2);
  assert.equal(s.cp.store.readAudit().filter((e) => e.kind === 'planner_review' && e.verdict === 'ACCEPT').length, 2);
  assert.deepEqual(Object.values(s.transport.remaining()).filter((n) => n > 0), []); // every fixture consumed
  // The planner request is the real Responses shape: POST /v1/responses with a strict json_schema.
  const req = s.transport.requests[0];
  assert.equal(req.url, API_URL);
  assert.equal(req.method, 'POST');
  assert.equal(req.body.text.format.type, 'json_schema');
  assert.equal(req.body.text.format.strict, true);
  assert.equal(req.body.store, false);
  assert.ok(!('authorization' in req.headers), 'adapter never sets an Authorization header');
  // The worker invocation is `claude -p --output-format json` with the configured limits.
  const inv = s.runner.invocations[0];
  assert.equal(inv.command, 'claude');
  assert.deepEqual(inv.argv.slice(0, 5), ['-p', '--output-format', 'json', '--max-turns', '8']);
  assert.equal(attempts().length, 0);
});

// ---- 2. planner REJECT -> feedback -> new attempt ------------------------------------------------------
test('2 planner REJECT: feedback reaches the planner, a new attempt passes within limits', () => {
  const s = replay('l2-reject', ONE_TASK({
    'plan#0': [oa('plan-0-task1'), oa('plan-0-task1')],
    'review:CO-SIM-001': [oa('review-reject'), oa('review-accept')],
  }, { 'CO-SIM-001': [cc('work-task1'), cc('work-task1-retry')] }));
  const r = drive(s);
  assert.equal(r.state.status, 'COMPLETE');
  assert.equal(r.state.last_verified_sha, SHA.a1b); // the second attempt's commit
  assert.equal(r.state.failure_count, 0);
  assert.ok(transitions(s.cp).includes('WAITING_EVENT->FAILED'));
  const plans = s.transport.requests.filter((q) => q.body.metadata.co_key === 'plan#0').map((q) => JSON.parse(q.body.input));
  assert.equal(plans[0].feedback, null);
  assert.match(plans[1].feedback.errors.join(), /planner review: verdict REJECT \(docs not updated for the new module\)/);
  assert.equal(ledger(s).calls['planner:plan#0'], 2);
  assert.equal(ledger(s).calls['worker:CO-SIM-001'], 2);
});

// ---- 3. malformed JSON / schema violation -----------------------------------------------------------
test('3 malformed JSON / schema violation -> fail closed (BLOCKED), cost still booked', () => {
  const a = replay('l2-prose', ONE_TASK({ 'plan#0': [oa('malformed-json')] }, {}));
  drive(a);
  blockedWith(a, 'agent_output', 'INVALID_OUTPUT');
  near(ledger(a).spent_usd_today, (1500 * 2 + 20 * 8) / 1e6);
  assert.equal(a.runner.invocations.length, 0);

  const b = replay('l2-schema', ONE_TASK({ 'plan#0': [oa('schema-violation')] }, {}));
  drive(b);
  assert.equal(b.cp.state().status, 'BLOCKED');
  assert.match(b.cp.state().next_safe_action, /^NEEDS_HUMAN: handoff missing field: why/);
  assert.equal(b.runner.invocations.length, 0);

  const c = replay('l2-worker-prose', ONE_TASK({ 'plan#0': [oa('plan-0-task1')] }, { 'CO-SIM-001': [cc('prose-result')] }));
  drive(c);
  blockedWith(c, 'agent_output', 'INVALID_OUTPUT');
  near(ledger(c).spent_usd_today, 0.0058 + 0.099); // plan + the billed worker run
});

// ---- 4. max_tokens / incomplete ----------------------------------------------------------------------
test('4 incomplete response (max_output_tokens) -> BLOCKED, no retry, tokens billed', () => {
  const s = replay('l2-incomplete', ONE_TASK({ 'plan#0': [oa('incomplete-max-output-tokens')] }, {}));
  drive(s);
  blockedWith(s, 'agent_output', 'INCOMPLETE_MAX_OUTPUT_TOKENS');
  assert.equal(s.transport.requests.length, 1);
  near(ledger(s).spent_usd_today, (1500 * 2 + 2000 * 8) / 1e6);
});

// ---- 5. refusal ---------------------------------------------------------------------------------------
test('5 refusal -> BLOCKED (REFUSAL), billed, nothing dispatched', () => {
  const s = replay('l2-refusal', ONE_TASK({ 'plan#0': [oa('refusal')] }, {}));
  drive(s);
  blockedWith(s, 'agent_output', 'REFUSAL');
  assert.equal(s.runner.invocations.length, 0);
});

// ---- 6. 429 + retry-after -------------------------------------------------------------------------------
test('6 429 + retry-after: waits exactly retry-after and retries; beyond our cap it halts without waiting', () => {
  const ok = replay('l2-429', { ...HAPPY, planner: { ...HAPPY.planner, 'plan#0': [oa('error-429-retry-after-2'), oa('plan-0-task1')] } });
  assert.equal(drive(ok).state.status, 'COMPLETE');
  assert.deepEqual(ok.sleeps, [2000]);
  assert.equal(ok.transport.requests.filter((q) => q.body.metadata.co_key === 'plan#0').length, 2);
  assert.equal(ledger(ok).calls['planner:plan#0'], 1); // one logical call, one budget unit

  const long = replay('l2-429-long', ONE_TASK({ 'plan#0': [oa('error-429-retry-after-3600')] }, {}));
  drive(long);
  blockedWith(long, 'agent_transport', 'RATE_LIMITED');
  assert.deepEqual(long.sleeps, []);
});

// ---- 7. 5xx / timeout --------------------------------------------------------------------------------
test('7 5xx and timeout: bounded retries with backoff, then halt; recovery works; 401 never retried', () => {
  const down = replay('l2-5xx', ONE_TASK({ 'plan#0': [oa('error-500'), { throw: 'ETIMEDOUT' }, oa('error-503')] }, {}));
  drive(down);
  blockedWith(down, 'agent_transport', 'UPSTREAM_UNAVAILABLE');
  assert.equal(down.transport.requests.length, 3); // 1 + max_retries (2)
  assert.deepEqual(down.sleeps, [1000, 2000]);
  const l = ledger(down);
  assert.ok(l.entries.some((e) => /^FAILED/.test(e.note || '')), 'failed call noted, reservation kept');
  assert.ok(l.spent_usd_today > 0);

  const recover = replay('l2-recover', { ...HAPPY, planner: { ...HAPPY.planner, 'plan#0': [oa('error-503'), oa('plan-0-task1')] } });
  assert.equal(drive(recover).state.status, 'COMPLETE');

  const auth = replay('l2-401', ONE_TASK({ 'plan#0': [oa('error-401')] }, {}));
  drive(auth);
  blockedWith(auth, 'agent_transport', 'CLIENT_ERROR_401');
  assert.equal(auth.transport.requests.length, 1);

  const slow = replay('l2-worker-timeout', ONE_TASK({ 'plan#0': [oa('plan-0-task1')] }, { 'CO-SIM-001': [{ throw: 'ETIMEDOUT' }] }));
  drive(slow);
  blockedWith(slow, 'agent_transport', 'WORKER_TIMEOUT');
});

test('7b worker errors: is_error / subtype error_max_turns and error_during_execution -> BLOCKED, cost booked', () => {
  for (const [fixture, code, cost] of [['error-max-turns', 'WORKER_ERROR_MAX_TURNS', 0.311], ['error-during-execution', 'WORKER_ERROR_DURING_EXECUTION', 0.0275]]) {
    const s = replay(`l2-${fixture}`, ONE_TASK({ 'plan#0': [oa('plan-0-task1')] }, { 'CO-SIM-001': [cc(fixture)] }));
    drive(s);
    blockedWith(s, 'agent_output', code);
    near(ledger(s).spent_usd_today, 0.0058 + cost);
  }
});

test('7c cost unknown: worker without total_cost_usd -> halt COST_UNKNOWN, reservation kept', () => {
  const s = replay('l2-nocost', ONE_TASK({ 'plan#0': [oa('plan-0-task1')] }, { 'CO-SIM-001': [cc('missing-cost')] }));
  drive(s);
  blockedWith(s, 'spend_guard', 'COST_UNKNOWN');
  near(ledger(s).spent_usd_today, 0.0058 + LIMITS.per_call_max_usd); // worst-case reservation stays booked
});

// ---- 8. spend cap in the middle of the loop ------------------------------------------------------------
test('8 spend cap reached mid-loop -> stops before the next call, reason recorded', () => {
  const s = replay('l2-cap', HAPPY, { limits: limitsWith({ daily_spend_cap_usd: 0.6 }) });
  const r = drive(s);
  assert.equal(r.state.status, 'BLOCKED');
  assert.deepEqual(r.state.completed_tasks, ['CO-SIM-001']); // task 1 finished, task 2's worker refused
  const e = blockedWith(s, 'spend_guard', 'DAILY_SPEND_CAP');
  assert.equal(e.task_id, 'CO-SIM-002');
  assert.match(e.reason, /\+ estimated 0\.500000 USD > daily cap 0\.6/);
  assert.equal(s.runner.invocations.length, 1); // the refused worker run never started
  assert.ok(ledger(s).spent_usd_today <= 0.6);
});

// ---- 9. loop detector ---------------------------------------------------------------------------------
test('9 loop detector: identical worker output twice -> halt (breaker tripped)', () => {
  const s = replay('l2-loop', ONE_TASK({ 'plan#0': [oa('plan-0-task1'), oa('plan-0-task1')] }, { 'CO-SIM-001': [cc('work-task1-fail'), cc('work-task1-fail')] }));
  const r = drive(s);
  blockedWith(s, 'loop_detected', 'REPEATED_OUTPUT');
  assert.equal(s.runner.invocations.length, 2);
  assert.equal(r.state.failure_count, POLICY.breaker_threshold); // breaker tripped (1 real FAIL + the loop)
});

// ---- 10. token accounting -------------------------------------------------------------------------------
test('10 token accounting: usage x FAKE price table and reported total_cost_usd = expected spend', () => {
  assert.equal(LIMITS._PRICING_NOTE, FAKE_PRICING_NOTE);
  const s = replay('l2-accounting', HAPPY);
  drive(s);
  const l = ledger(s);
  const price = LIMITS.pricing_usd_per_mtok[`openai/${MODEL}`];
  for (const e of l.entries) {
    if (e.model === `openai/${MODEL}`) near(e.cost_usd, (e.input_tokens * price.input + e.output_tokens * price.output) / 1e6);
  }
  const worker = l.entries.filter((e) => e.key.startsWith('worker:')).map((e) => e.cost_usd);
  assert.deepEqual(worker, [0.2134, 0.1876]); // exactly the reported total_cost_usd
  const plan = (1500 * 2 + 350 * 8) / 1e6; // 0.0058
  const done = (1500 * 2 + 12 * 8) / 1e6;
  const review = (900 * 2 + 40 * 8) / 1e6; // 0.00212
  near(l.spent_usd_today, 2 * plan + done + 2 * review + 0.2134 + 0.1876);
  near(l.spent_usd_total, l.spent_usd_today);
});

// ---- 11. orchestrator trigger filter (evidence, not a live test) -----------------------------------------
test('11 only a push to co/** can drive the loop: the three filter layers, quoted from the files', (t) => {
  const lines = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n');
  const find = (f, re) => { const ls = lines(f); const i = ls.findIndex((l) => re.test(l)); assert.ok(i >= 0, `${f}: ${re}`); return `${f}:${i + 1}: ${ls[i].trim()}`; };
  const quotes = [
    find('.github/workflows/ci.yml', /^\s+branches: \['co\/\*\*'\]$/),
    find('.github/workflows/ci.yml', /^\s+pull_request:$/),
    find('.github/workflows/orchestrator.yml', /^\s+workflows: \[CI\]$/),
    find('.github/workflows/orchestrator.yml', /vars\.ORCHESTRATOR_ENABLED == 'true' &&$/),
    find('.github/workflows/orchestrator.yml', /github\.event\.workflow_run\.event == 'push' &&$/),
    find('.github/workflows/orchestrator.yml', /head_repository\.full_name == github\.repository$/),
    find('.github/workflows/orchestrator.yml', /^\s+group: clubOrchestra$/),
    find('src/adapters/github.js', /startsWith\(POLICY\.task_branch_prefix\)\)/),
  ];
  for (const q of quotes) t.diagnostic(q);
});

// ---- 12. spend survives a restart ---------------------------------------------------------------------
test('12 spend survives restarts: every step in a fresh instance (like separate Actions runs) still stops at the cap', () => {
  const s = replay('l2-restart', HAPPY, { limits: limitsWith({ daily_spend_cap_usd: 0.6 }) });
  drive(s, { freshEachStep: true });
  blockedWith(s, 'spend_guard', 'DAILY_SPEND_CAP');
  assert.deepEqual(s.cp.state().completed_tasks, ['CO-SIM-001']);
  // And a brand-new guard on the same ledger refuses straight away.
  const g = new SpendGuard({ limits: limitsWith({ daily_spend_cap_usd: 0.6 }), ledgerPath: path.join(s.dir, 'spend', 'ledger.json'), now: s.clock });
  assert.throws(() => g.check({ role: 'worker', key: 'CO-SIM-002', provider: 'anthropic', model: 'claude-code-headless', replay: true }),
    (err) => err instanceof SpendBlockedError && err.code === 'DAILY_SPEND_CAP');
});

// ---- 13. concurrent spenders --------------------------------------------------------------------------
test('13 concurrent processes cannot jointly overshoot the cap (ledger lock + reservation)', async () => {
  const dir = tmpDir('l2-race');
  const limitsPath = path.join(dir, 'limits.json');
  fs.writeFileSync(limitsPath, JSON.stringify({ ...JSON.parse(JSON.stringify(LIMITS)), daily_spend_cap_usd: 1.0 }));
  const ledgerPath = path.join(dir, 'ledger.json');
  const script = path.join(FIX, 'spend-racer.js');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ledgerPath, limitsPath, `T-${i}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(JSON.parse(out)));
  })));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 3, JSON.stringify(results)); // 3 x 0.30 <= 1.00 < 4 x 0.30
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'DAILY_SPEND_CAP'));
  const l = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  near(l.spent_usd_today, 0.9);
  assert.ok(!fs.existsSync(`${ledgerPath}.lock`));
});

// ---- Q3: UTC day ---------------------------------------------------------------------------------------
test('Q3 the daily cap resets at 00:00 UTC, whatever offset the clock uses', () => {
  assert.equal(utcDay('2026-10-05T23:59:59Z'), '2026-10-05');
  assert.equal(utcDay('2026-10-06T00:00:00Z'), '2026-10-06');
  assert.equal(utcDay('2026-10-05T23:30:00-02:00'), '2026-10-06'); // 01:30 UTC
  assert.equal(utcDay('2026-10-06T01:30:00+02:00'), '2026-10-05'); // 23:30 UTC
  const dir = tmpDir('l2-utc');
  let now = '2026-10-05T23:59:59Z';
  const g = new SpendGuard({ limits: limitsWith({ daily_spend_cap_usd: 0.5 }), ledgerPath: path.join(dir, 'l.json'), now: () => now });
  const call = { role: 'worker', provider: 'anthropic', model: 'claude-code-headless', replay: true };
  g.check({ ...call, key: 'A' });
  assert.throws(() => g.check({ ...call, key: 'B' }), (e) => e.code === 'DAILY_SPEND_CAP');
  now = '2026-10-06T00:00:00Z';
  assert.equal(g.check({ ...call, key: 'B' }).call_no, 1);
});

// ---- safety: live mode banned, keys never read, no network ---------------------------------------------
test('live mode is impossible: a non-replay transport or runner is refused before any call', () => {
  let calls = 0;
  const live = () => { calls++; return { status: 200, headers: {}, body: '{}' }; }; // no .replay flag
  const s = replay('l2-live', {});
  s.make = () => Object.assign(s, instance(s.dir, { ...s, transport: live }));
  s.make();
  drive(s);
  blockedWith(s, 'spend_guard', 'REAL_AGENTS_DISABLED');
  assert.equal(calls, 0);

  const mockMode = new SpendGuard({ limits: loadLimits(), ledgerPath: path.join(s.dir, 'x.json') }); // default config: mock
  assert.throws(() => mockMode.check({ role: 'planner', key: 'k', provider: 'openai', model: MODEL, replay: true }), (e) => e.code === 'REAL_AGENTS_DISABLED');
  assert.match(validateLimits({ ...JSON.parse(JSON.stringify(LIMITS)), mode: 'real' }).join(), /real agents are not enabled/);
  const { _PRICING_NOTE, ...unmarked } = JSON.parse(JSON.stringify(LIMITS));
  assert.match(validateLimits(unmarked).join(), /FAKE — not real pricing/);
});

test('API keys are never read or sent, even when present in the environment', () => {
  const canary = { OPENAI_API_KEY: 'sk-canary-openai-0000', ANTHROPIC_API_KEY: 'sk-ant-canary-0000' };
  const saved = Object.fromEntries(Object.keys(canary).map((k) => [k, process.env[k]]));
  Object.assign(process.env, canary);
  try {
    const s = replay('l2-keys', HAPPY);
    assert.equal(drive(s).state.status, 'COMPLETE');
    const everything = JSON.stringify([s.transport.requests, s.runner.invocations, ledger(s), s.cp.store.readAudit()]);
    for (const v of Object.values(canary)) assert.ok(!everything.includes(v), 'canary key leaked');
    for (const q of s.transport.requests) assert.ok(!Object.keys(q.headers).some((h) => h.toLowerCase() === 'authorization'));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('network trap is armed: any network call fails the run', () => {
  assert.throws(() => globalThis.fetch('https://api.openai.com/v1/responses'), /NETWORK_FORBIDDEN/);
  assert.throws(() => require('node:https').request('https://api.anthropic.com'), /NETWORK_FORBIDDEN/);
  assert.throws(() => require('node:net').connect(443, 'example.com'), /NETWORK_FORBIDDEN/);
  globalThis.__networkAttempts.length = 0; // these three were deliberate
});
