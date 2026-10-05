'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, transitions } = require('./helpers');
const { ControlPlane } = require('../src/controlPlane');
const { SimPlanner } = require('../src/sim/planner');
const { SimWorker } = require('../src/sim/worker');
const { OutboxWorker } = require('../src/outboxWorker');
const { validateEvent, verifyEvidence } = require('../src/events');
const { HANDOFF_REQUIRED, WORKER_RESULT_FIELDS, validateWorkerResult } = require('../src/handoff');
const { PlannerAdapter, WorkerAdapter, assertPlannerAdapter, assertWorkerAdapter } = require('../src/agents/adapter');
const { AgentPlanner, AgentWorker, PLANNER_SYSTEM } = require('../src/agents/modelAgents');
const { MockModelClient, simPlannerResponder, scriptedWorkerResponder } = require('../src/agents/mock');
const { SpendGuard } = require('../src/agents/spendGuard');
const { SpendBlockedError } = require('../src/agents/errors');
const { loadLimits, validateLimits } = require('../src/agents/limits');
const { createLocalLoop, pump, GitWorker } = require('../harness/localLoop');

const DEFAULTS = loadLimits();
const limitsWith = (over) => {
  const l = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...over };
  assert.deepEqual(validateLimits(l), []);
  return l;
};
const ZERO = '0'.repeat(40);
const clockFrom = (iso) => { let t = 0; return () => new Date(Date.parse(iso) + 1000 * t++).toISOString(); };

// Mock model agents wired with a guard whose ledger lives in the control-plane state dir.
function agents(dir, { limits = DEFAULTS, plan, script, repeat, plannerResponder, workerResponder, plannerClient, now } = {}) {
  const clock = now || clockFrom('2026-10-05T12:00:00Z');
  const guard = new SpendGuard({ limits, ledgerPath: path.join(dir, 'spend', 'ledger.json'), now: clock });
  const pClient = plannerClient || new MockModelClient({ responder: plannerResponder || simPlannerResponder(plan ? { plan } : {}) });
  const wClient = new MockModelClient({ responder: workerResponder || scriptedWorkerResponder({ script, repeat }) });
  return {
    guard, pClient, wClient, clock,
    planner: new AgentPlanner({ client: pClient, guard }),
    worker: new AgentWorker({ client: wClient, guard, clock }),
  };
}

function cpWith(name, opts = {}) {
  const dir = tmpDir(name);
  const a = agents(dir, opts);
  const cp = new ControlPlane({ dir, planner: a.planner, worker: a.worker, now: a.clock, breakerThreshold: opts.breakerThreshold }).init();
  return { dir, cp, ...a };
}

const ledger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'spend', 'ledger.json'), 'utf8'));
const escalation = (cp) => cp.store.listEscalations()[0];

// ---- 1. adapter contract ----------------------------------------------------------------------------
test('contract: sims, outbox/git workers and mock model agents all implement the adapter interface', () => {
  const dir = tmpDir('contract');
  const a = agents(dir);
  for (const p of [new SimPlanner(), a.planner]) {
    assert.ok(p instanceof PlannerAdapter);
    assert.equal(assertPlannerAdapter(p), p);
  }
  for (const w of [new SimWorker(), new OutboxWorker(dir), a.worker]) {
    assert.ok(w instanceof WorkerAdapter);
    assert.equal(assertWorkerAdapter(w), w);
  }
  assert.ok(GitWorker.prototype instanceof WorkerAdapter);
  assert.throws(() => new ControlPlane({ dir, planner: {}, worker: new SimWorker() }), /PlannerAdapter/);
  assert.throws(() => new ControlPlane({ dir, planner: new SimPlanner(), worker: {} }), /WorkerAdapter/);
  assert.throws(() => new AgentPlanner({ client: a.pClient }), /SpendGuard is required/);
});

test('contract: mock planner in -> exactly the existing to-worker handoff out (same as the sim)', () => {
  const dir = tmpDir('contract-plan');
  const { planner } = agents(dir);
  const view = { completed_tasks: [], last_verified_sha: ZERO };
  const h = planner.nextTask(view);
  assert.deepEqual(Object.keys(h).sort(), [...HANDOFF_REQUIRED].sort());
  assert.deepEqual(h, new SimPlanner().nextTask(view));
  const cp = new ControlPlane({ dir, planner, worker: new SimWorker() }).init();
  assert.equal(cp._checkHandoff(h, { last_verified_sha: ZERO }), null);
  assert.equal(planner.nextTask({ completed_tasks: ['CO-SIM-001', 'CO-SIM-002'], last_verified_sha: ZERO }), null);
  assert.deepEqual(planner.review({ task_id: 'CO-SIM-001', sha: ZERO, ci_status: 'success', evidence_refs: [] }), { verdict: 'ACCEPT', reason: null });
});

test('contract: mock worker in -> valid task.completed envelope + from-worker result out', () => {
  const dir = tmpDir('contract-work');
  const { worker } = agents(dir);
  const h = new SimPlanner().nextTask({ completed_tasks: [], last_verified_sha: ZERO });
  const ev = worker.execute(h);
  assert.deepEqual(validateEvent(ev, { project_id: 'clubOrchestra-lab' }), { ok: true, errors: [] });
  assert.equal(ev.type, 'task.completed');
  assert.equal(ev.event_id, 'evt-agent-CO-SIM-001-1');
  assert.deepEqual(validateWorkerResult(ev.payload), []);
  assert.deepEqual(Object.keys(ev.payload).sort(), [...WORKER_RESULT_FIELDS].sort());
  assert.deepEqual(verifyEvidence(ev, { current_task_id: 'CO-SIM-001', expected_sha: ZERO }), { stale: false, errors: [] });
});

test('contract: extra fields in model output are dropped (never reach the control plane)', () => {
  const dir = tmpDir('contract-strip');
  const sim = new SimPlanner();
  const { planner, worker } = agents(dir, {
    plannerResponder: (req) => JSON.stringify({ task: { ...sim.nextTask(req.input), requires_approval: false, status: 'COMPLETE' }, approve_all: true }),
    workerResponder: (req) => JSON.stringify({ ...JSON.parse(scriptedWorkerResponder()(req)), next_status: 'COMPLETE', approve: 'deploy' }),
  });
  const h = planner.nextTask({ completed_tasks: [], last_verified_sha: ZERO });
  assert.ok(!('requires_approval' in h) && !('status' in h));
  const ev = worker.execute(h);
  assert.ok(!('next_status' in ev.payload) && !('approve' in ev.payload));
});

// ---- no behaviour change with mock adapters ----------------------------------------------------------
test('mock agents drive the P1 loop exactly like the sims: 2 tasks -> COMPLETE, no "continue"', () => {
  const { cp, dir, pClient, wClient } = cpWith('mock-p1');
  cp.start();
  const r = cp.run();
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(r.state.completed_tasks, ['CO-SIM-001', 'CO-SIM-002']);
  assert.deepEqual(transitions(cp), [
    'IDLE->RUNNING', 'RUNNING->WAITING_EVENT', 'WAITING_EVENT->RUNNING',
    'RUNNING->WAITING_EVENT', 'WAITING_EVENT->RUNNING', 'RUNNING->COMPLETE',
  ]);
  assert.equal(pClient.calls.length, 3); // plan#0, plan#1, plan#2 (-> null)
  assert.equal(wClient.calls.length, 2);
  const l = ledger(dir);
  assert.deepEqual(l.calls, { 'planner:plan#0': 1, 'worker:CO-SIM-001': 1, 'planner:plan#1': 1, 'worker:CO-SIM-002': 1, 'planner:plan#2': 1 });
  assert.equal(l.spent_usd_today, 0); // mock is free under the default config
});

test('mock planner in the P2 local GitHub loop gives the identical result as the sim planner', () => {
  const sim = createLocalLoop({ root: tmpDir('p2-sim') });
  sim.cp.start();
  const rs = pump(sim);

  const loop = createLocalLoop({
    root: tmpDir('p2-mock'),
    makePlanner: ({ repo, controlDir }) => agents(controlDir, { plannerResponder: simPlannerResponder({ repo }) }).planner,
  });
  loop.cp.start();
  const rm = pump(loop);

  assert.equal(rm.state.status, 'COMPLETE');
  assert.equal(rm.state.last_verified_sha, rs.state.last_verified_sha);
  assert.deepEqual(transitions(loop.cp), transitions(sim.cp));
  assert.equal(ledger(loop.controlDir).calls['planner:review:CO-SIM-001'], 1); // review went through the guard
});

// ---- 2. spend / rate controls (fail closed, before the call) -------------------------------------------
test('max_calls_per_task: the worker budget blocks the next call BEFORE it is made -> BLOCKED + escalation', () => {
  const { cp, wClient } = cpWith('max-calls', {
    limits: limitsWith({ max_calls_per_task: { planner: 5, worker: 2 } }),
    script: { 'CO-SIM-001': ['FAIL', 'FAIL', 'FAIL', 'FAIL'] },
  });
  cp.start();
  const r = cp.run();
  assert.equal(r.state.status, 'BLOCKED');
  assert.equal(wClient.calls.length, 2); // the 3rd worker call was never made
  assert.equal(r.state.failure_count, 2); // stopped by the budget, before the breaker's 3rd failure
  const e = escalation(cp);
  assert.equal(e.kind, 'spend_guard');
  assert.equal(e.code, 'MAX_CALLS_PER_TASK');
  assert.match(r.state.next_safe_action, /^NEEDS_HUMAN: worker halted \(MAX_CALLS_PER_TASK\)/);
  assert.equal(cp.run().stopped, 'blocked'); // stays stopped
  assert.equal(wClient.calls.length, 2);
});

test('daily_spend_cap: blocks the call that would exceed the cap; spend never passes the cap', () => {
  // input priced so that estimates equal actual cost: 100 USD per million input tokens.
  const limits = limitsWith({ daily_spend_cap_usd: 0.05, per_call_max_usd: 1, pricing_usd_per_mtok: { 'mock/mock-1': { input: 100, output: 0 } } });
  const { cp, dir, pClient, wClient } = cpWith('daily-cap', { limits });
  cp.start();
  const r = cp.run();
  assert.equal(r.state.status, 'BLOCKED');
  const e = escalation(cp);
  assert.equal(e.code, 'DAILY_SPEND_CAP');
  const l = ledger(dir);
  assert.ok(l.spent_usd_today > 0 && l.spent_usd_today <= 0.05, String(l.spent_usd_today));
  const permitted = Object.values(l.calls).reduce((a, b) => a + b, 0);
  assert.equal(pClient.calls.length + wClient.calls.length, permitted); // the blocked call was not made
});

test('daily_spend_cap: the ledger persists across processes and resets the next day', () => {
  const dir = tmpDir('ledger');
  const limits = limitsWith({ daily_spend_cap_usd: 0.01, per_call_max_usd: 1, pricing_usd_per_mtok: { 'mock/mock-1': { input: 0, output: 1000 } } });
  const call = { role: 'worker', key: 'T-1', provider: 'mock', model: 'mock-1', input_tokens: 0, max_output_tokens: 5 }; // 0.005 USD
  let day = '2026-10-05T10:00:00Z';
  const g1 = new SpendGuard({ limits, ledgerPath: path.join(dir, 'ledger.json'), now: () => day });
  g1.record(g1.check(call), { usage: { input_tokens: 0, output_tokens: 5 }, text: 'a' });
  g1.record(g1.check({ ...call, key: 'T-2' }), { usage: { input_tokens: 0, output_tokens: 5 }, text: 'b' });
  assert.equal(g1.ledger().spent_usd_today, 0.01); // reservations replaced by actual cost, not added to it

  const g2 = new SpendGuard({ limits, ledgerPath: path.join(dir, 'ledger.json'), now: () => day }); // "new process"
  assert.throws(() => g2.check({ ...call, key: 'T-3' }), (err) => err instanceof SpendBlockedError && err.code === 'DAILY_SPEND_CAP');
  day = '2026-10-06T00:00:01Z';
  assert.equal(g2.check({ ...call, key: 'T-3' }).call_no, 1); // new day: cap resets
});

test('per-call cap, unpriced model and real providers are refused before any call (fail closed)', () => {
  const dir = tmpDir('refuse');
  const call = { role: 'planner', key: 'k', input_tokens: 10, max_output_tokens: 10 };
  const g = (limits) => new SpendGuard({ limits, ledgerPath: path.join(dir, `${Math.random()}.json`) });
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'ALLOWED'; };
  assert.equal(code(() => g(DEFAULTS).check({ ...call, provider: 'openai', model: 'any' })), 'REAL_AGENTS_DISABLED');
  assert.equal(code(() => g(DEFAULTS).check({ ...call, provider: 'anthropic', model: 'any' })), 'REAL_AGENTS_DISABLED');
  assert.equal(code(() => g(DEFAULTS).check({ ...call, provider: 'mock', model: 'mock-unpriced' })), 'PRICING_UNKNOWN');
  const priced = limitsWith({ per_call_max_usd: 0.0001, daily_spend_cap_usd: 10, pricing_usd_per_mtok: { 'mock/mock-1': { input: 1000, output: 0 } } });
  assert.equal(code(() => g(priced).check({ ...call, provider: 'mock', model: 'mock-1' })), 'PER_CALL_CAP'); // 0.01 > 0.0001
  assert.equal(code(() => g(DEFAULTS).check({ ...call, provider: 'mock', model: 'mock-1' })), 'ALLOWED'); // free mock under defaults

  // Through the control plane: a planner on an unpriced/real model never gets called; loop BLOCKED.
  const client = new MockModelClient({ responder: simPlannerResponder(), provider: 'openai', model: 'gpt-anything' });
  const { cp } = cpWith('refuse-cp', { plannerClient: client });
  cp.start();
  assert.equal(cp.run().state.status, 'BLOCKED');
  assert.equal(client.calls.length, 0);
  assert.equal(escalation(cp).code, 'REAL_AGENTS_DISABLED');
  assert.equal(escalation(cp).escalation_id.startsWith('planner.spend.'), true);
});

// ---- 3. loop detector -----------------------------------------------------------------------------
test('loop detector: identical worker output for the same task trips the circuit breaker', () => {
  const { cp, wClient } = cpWith('loop', { script: { 'CO-SIM-001': ['FAIL', 'FAIL', 'FAIL'] }, repeat: true });
  cp.start();
  const r = cp.run();
  assert.equal(r.state.status, 'BLOCKED');
  assert.equal(wClient.calls.length, 2); // stopped at the first repeat, not after 3 failures
  assert.ok(r.state.failure_count >= 3, 'breaker count raised to the threshold');
  const e = escalation(cp);
  assert.equal(e.kind, 'loop_detected');
  assert.equal(e.code, 'REPEATED_OUTPUT');
  assert.ok(transitions(cp).includes('WAITING_EVENT->BLOCKED'));
});

test('loop detector: different outputs on retry are not a loop (normal FAIL -> retry -> PASS)', () => {
  const { cp, wClient } = cpWith('no-loop', { script: { 'CO-SIM-001': ['FAIL', 'PASS'] } });
  cp.start();
  assert.equal(cp.run().state.status, 'COMPLETE');
  assert.equal(wClient.calls.length, 3);
});

// ---- 4. config ------------------------------------------------------------------------------------
test('config: defaults are conservative and frozen; invalid or "real" configs are refused', () => {
  assert.equal(DEFAULTS.mode, 'mock');
  assert.equal(DEFAULTS.daily_spend_cap_usd, 0);
  assert.equal(DEFAULTS.per_call_max_usd, 0);
  assert.deepEqual(Object.keys(DEFAULTS.pricing_usd_per_mtok), ['mock/mock-1']);
  assert.ok(Object.isFrozen(DEFAULTS.max_calls_per_task));
  assert.ok('_PRODUCT_OWNER_SETS_IN_LOT3' in DEFAULTS);

  const bad = (over) => validateLimits({ ...JSON.parse(JSON.stringify(DEFAULTS)), ...over });
  assert.match(bad({ mode: 'real' }).join(), /real agents are not enabled/);
  assert.match(bad({ daily_spend_cap_usd: -1 }).join(), /daily_spend_cap_usd/);
  assert.match(bad({ per_call_max_usd: 'lots' }).join(), /per_call_max_usd/);
  assert.match(bad({ max_calls_per_task: { planner: 3 } }).join(), /max_calls_per_task.worker/);
  assert.match(bad({ loop_detect_repeats: 1 }).join(), /loop_detect_repeats/);
  assert.match(bad({ pricing_usd_per_mtok: { 'openai/x': { input: null, output: 1 } } }).join(), /openai\/x/);

  const file = path.join(tmpDir('cfg'), 'limits.json');
  fs.writeFileSync(file, JSON.stringify({ ...DEFAULTS, mode: 'real' }));
  assert.throws(() => loadLimits(file), /invalid agent limits/);
});

// ---- untrusted model output ---------------------------------------------------------------------------
test('untrusted output: malformed planner/worker output fails closed; review needs an exact ACCEPT', () => {
  const p = cpWith('bad-plan', { plannerResponder: () => 'Sure! Here is the plan: {"task": ...}' });
  p.cp.start();
  assert.equal(p.cp.run().state.status, 'BLOCKED');
  assert.equal(escalation(p.cp).kind, 'agent_output');
  assert.equal(p.wClient.calls.length, 0);

  const w = cpWith('bad-work', { workerResponder: (req) => JSON.stringify({ ...JSON.parse(scriptedWorkerResponder()(req)), task_id: 'OTHER-1' }) });
  w.cp.start();
  assert.equal(w.cp.run().state.status, 'BLOCKED');
  assert.match(escalation(w.cp).reason, /different task/);

  // Near-miss verdicts never accept: each review counts as a failure until the breaker trips.
  const sim = new SimPlanner();
  for (const verdict of ['ACCEPT ', 'accept', 'ACCEPTED']) {
    const responder = (req) => JSON.stringify(req.purpose === 'plan' ? { task: sim.nextTask(req.input) } : { verdict });
    const loop = createLocalLoop({ root: tmpDir('review'), makePlanner: ({ controlDir }) => agents(controlDir, { plannerResponder: responder }).planner });
    loop.cp.start();
    const r = pump(loop);
    assert.equal(r.state.status, 'BLOCKED', verdict);
    assert.deepEqual(r.state.completed_tasks, [], verdict);
    assert.equal(escalation(loop.cp).kind, 'circuit_breaker', verdict);
  }
});

test('untrusted output: a planned "deploy" still stops at the approval gate whatever the model says', () => {
  const sim = new SimPlanner({ plan: [{ task_id: 'CO-SIM-009', action: 'deploy', objective: 'gated' }] });
  const { cp, wClient } = cpWith('gate', {
    plannerResponder: (req) => JSON.stringify(req.purpose === 'plan'
      ? { task: { ...sim.nextTask(req.input), requires_approval: false, approved: true }, approval: 'granted' }
      : { verdict: 'ACCEPT' }),
  });
  cp.start();
  assert.equal(cp.run().state.status, 'WAITING_APPROVAL');
  assert.equal(wClient.calls.length, 0);
});

test('ledger records usage, cost and hashes only, never prompts or outputs', () => {
  const { cp, dir } = cpWith('ledger-privacy');
  cp.start();
  cp.run();
  const raw = fs.readFileSync(path.join(dir, 'spend', 'ledger.json'), 'utf8');
  assert.ok(!raw.includes(PLANNER_SYSTEM.slice(0, 30)));
  assert.ok(!raw.includes('Add greeting module'));
  const e = JSON.parse(raw).entries[0];
  assert.deepEqual(Object.keys(e).sort(), ['cost_usd', 'input_tokens', 'key', 'model', 'output_sha256', 'output_tokens', 'reserved_usd', 'ts']);
});
