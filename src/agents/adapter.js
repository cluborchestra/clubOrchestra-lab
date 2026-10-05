'use strict';

// AgentAdapter boundary. Every planner and worker the control plane talks to implements one of
// these: the deterministic sims (P1/P2), the mock model agents (P3 Lot 1/2), and the real agents
// (P3 Lot 3). They exchange exactly the existing handoff schema (src/handoff.js).
//
//   PlannerAdapter.nextTask(view)  -> to-worker handoff | null (no more tasks)
//   PlannerAdapter.review(evidence) -> { verdict: 'ACCEPT' | anything else }
//   PlannerAdapter.classify(handoff) -> { class: 'AUTO'|'OWNER', category, reason } | null
//     (escalation rule; null or anything unclear means OWNER, see src/escalation.js)
//   WorkerAdapter.execute(handoff) -> task.completed event | null (result arrives later)
//
// Adapters may throw an AgentHaltError (src/agents/errors.js) to stop the loop fail-closed.

class PlannerAdapter {
  get kind() { return 'planner'; }
  nextTask() { throw new Error(`${this.constructor.name}.nextTask not implemented`); }
  review() { throw new Error(`${this.constructor.name}.review not implemented`); }
  classify() { return null; } // no classification -> OWNER (fail closed)
}

class WorkerAdapter {
  get kind() { return 'worker'; }
  execute() { throw new Error(`${this.constructor.name}.execute not implemented`); }
}

function assertPlannerAdapter(p) {
  if (!p || typeof p.nextTask !== 'function' || typeof p.review !== 'function') {
    throw new TypeError('planner must implement PlannerAdapter (nextTask, review)');
  }
  return p;
}

function assertWorkerAdapter(w) {
  if (!w || typeof w.execute !== 'function') throw new TypeError('worker must implement WorkerAdapter (execute)');
  return w;
}

module.exports = { PlannerAdapter, WorkerAdapter, assertPlannerAdapter, assertWorkerAdapter };
