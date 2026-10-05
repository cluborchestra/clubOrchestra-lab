#!/usr/bin/env node
'use strict';

// Runs the whole P2 chain offline:
//   sim worker commits on co/<task> -> sim CI emits workflow_run (delivered twice) -> adapter ->
//   event -> control plane (exact-SHA + head gate) -> sim planner review -> next task -> COMPLETE.
//
//   node harness/run-local-loop.js            normal run
//   node harness/run-local-loop.js --crash    control plane "crashes" right after task 1's commit,
//                                             a new instance restarts, reconciles, and finishes
// Output goes to runs/local-loop/ (gitignored).
const path = require('node:path');
const { createLocalLoop, pump } = require('./localLoop');

const crash = process.argv.includes('--crash');
const root = path.join(__dirname, '..', 'runs', crash ? 'local-loop-crash' : 'local-loop');
const loop = createLocalLoop({ root, crashAfterCommit: crash ? ['CO-SIM-001'] : [] });

loop.cp.start();
let callsBeforeRestart = [];
try {
  pump(loop);
} catch (err) {
  console.log(`!! ${err.message} -- restarting control plane from durable state`);
  callsBeforeRestart = loop.worker.calls;
  loop.newControlPlane({ crash: [] });
  loop.cp.resume(); // drain inbox, reconcile against git head, continue
}
const r = pump(loop);

const first = loop.ci.delivered[0];
console.log('--- sample workflow_run payload (simulated GitHub delivery) ---');
console.log(JSON.stringify(first.payload, null, 2));
console.log('--- derived P1 event envelope ---');
console.log(JSON.stringify(first.event, null, 2));
console.log('--- audit trail ---');
for (const e of loop.cp.store.readAudit()) {
  const what = e.kind === 'transition' ? `${e.from} -> ${e.to}` : e.kind;
  console.log(`${e.ts}  ${what.padEnd(34)} task=${e.task_id || '-'}  event=${e.event_id || '-'}  ${e.reason || e.decision || ''}`);
}
console.log('--- result ---');
console.log(JSON.stringify({
  status: r.state.status,
  completed_tasks: r.state.completed_tasks,
  last_verified_sha: r.state.last_verified_sha,
  git_head_of_last_task_branch: loop.repo.git(['rev-parse', 'co/CO-SIM-002']),
  worker_executions: [...callsBeforeRestart, ...loop.worker.calls],
  restarted: crash,
  ci_runs_delivered: loop.ci.delivered.length,
  human_continue_used: false,
}, null, 2));
process.exitCode = r.state.status === 'COMPLETE' ? 0 : 1;
