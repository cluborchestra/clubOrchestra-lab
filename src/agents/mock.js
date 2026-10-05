'use strict';

// Deterministic, offline mock model client + canned responders for the agent adapters.
// No network, no keys, no cost: it returns JSON text computed from the request.
const { SimPlanner } = require('../sim/planner');
const { fakeSha } = require('../sim/worker');

const tokens = (s) => Math.ceil(String(s).length / 4);

class MockModelClient {
  constructor({ responder, provider = 'mock', model = 'mock-1' }) {
    if (typeof responder !== 'function') throw new TypeError('responder must be a function');
    Object.assign(this, { responder, provider, model });
    this.calls = [];
  }

  estimate(request) {
    return { input_tokens: tokens(JSON.stringify({ system: request.system, input: request.input })) };
  }

  complete(request) {
    this.calls.push({ purpose: request.purpose, key: request.key });
    const text = this.responder(request);
    return { text, usage: { input_tokens: this.estimate(request).input_tokens, output_tokens: tokens(text) } };
  }
}

// Planner responses identical to the simulated planner's decisions (same plan, same handoffs,
// same review rule), serialised as model output.
function simPlannerResponder(opts = {}) {
  const sim = new SimPlanner(opts);
  return (req) => {
    if (req.purpose !== 'plan') return JSON.stringify(sim.review(req.input));
    const task = sim.nextTask(req.input);
    return JSON.stringify({ task, decision: task ? sim.classify(task) : null });
  };
}

// Worker responses: a from-worker result per attempt. script maps task_id -> ['PASS'|'FAIL', ...];
// a new attempt yields a new ending_sha unless `repeat` is set (same output every time).
function scriptedWorkerResponder({ script = {}, repeat = false } = {}) {
  const attempts = {};
  return (req) => {
    const h = req.input.handoff;
    const n = (attempts[h.task_id] = (attempts[h.task_id] || 0) + 1);
    const outcome = (script[h.task_id] || [])[n - 1] || 'PASS';
    const pass = outcome === 'PASS';
    const ending_sha = fakeSha(h.starting_sha, h.task_id, repeat ? 1 : n);
    return JSON.stringify({
      task_id: h.task_id, outcome, starting_sha: h.starting_sha, ending_sha,
      files_changed: [`sim/${h.task_id}.txt`], tests: [{ name: 'mock-unit', status: pass ? 'pass' : 'fail' }],
      ci: { status: pass ? 'success' : 'failure', simulated: true }, docs_synced: true,
      risks: [], blockers: [], next_recommendation: pass ? 'proceed' : 'retry',
    });
  };
}

module.exports = { MockModelClient, simPlannerResponder, scriptedWorkerResponder, tokens };
