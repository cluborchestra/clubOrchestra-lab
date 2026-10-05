'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, transitions } = require('./helpers');
const { workflowRunToEvent } = require('../src/adapters/github');
const { validateEvent } = require('../src/events');
const { ControlPlane } = require('../src/controlPlane');
const { GitRefs } = require('../src/gitRefs');
const { OutboxWorker } = require('../src/outboxWorker');
const { SimPlanner } = require('../src/sim/planner');
const { ingestWorkflowRun } = require('../src/ingest');
const { main } = require('../src/cli');
const { createLocalLoop, pump, makeWorkflowRun, ScratchRepo, REPO_FULL_NAME } = require('../harness/localLoop');

const PROJECT = 'clubOrchestra-lab';
const SHA = 'c'.repeat(40);
const run = (over = {}) => makeWorkflowRun({ id: 4242, branch: 'co/CO-SIM-001', sha: SHA, conclusion: 'success', updated_at: '2026-10-04T12:00:00Z', ...over });
const kinds = (cp, kind) => cp.store.readAudit().filter((e) => e.kind === kind);

// Run the loop until the control plane is waiting on CI for task 1 (worker result accepted).
async function untilAwaitingCi(loop) {
  await loop.cp.start();
  await loop.cp.run();
  assert.equal(loop.cp.state().awaiting, 'ci');
  return loop.cp.state();
}

// ---- 1. adapter --------------------------------------------------------------------------------
test('adapter: workflow_run -> valid ci.completed envelope', async () => {
  const { event } = workflowRunToEvent(run(), { project_id: PROJECT, repo_full_name: REPO_FULL_NAME });
  assert.deepEqual(validateEvent(event, { project_id: PROJECT }), { ok: true, errors: [] });
  assert.equal(event.event_id, 'gh-run-4242-1');
  assert.equal(event.type, 'ci.completed');
  assert.equal(event.producer, 'github');
  assert.equal(event.sha, SHA);
  assert.equal(event.task_id, 'CO-SIM-001');
  assert.equal(event.branch, 'co/CO-SIM-001');
  assert.equal(event.status, 'success');
  assert.equal(event.payload.conclusion, 'success');
});

test('adapter: only an explicit "success" conclusion maps to success (fail closed)', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', null, undefined, 'SUCCESS']) {
    const { event } = workflowRunToEvent(run({ conclusion }), { project_id: PROJECT });
    assert.equal(event.status, 'failure', String(conclusion));
  }
});

test('adapter: project_id comes from config; payload cannot set it', async () => {
  const gh = { ...run(), project_id: 'evil', workflow_run: { ...run().workflow_run, project_id: 'evil' } };
  assert.equal(workflowRunToEvent(gh, { project_id: PROJECT }).event.project_id, PROJECT);
});

test('adapter: not-ours deliveries are ignored; malformed ones yield an invalid envelope', async () => {
  const opts = { project_id: PROJECT, repo_full_name: REPO_FULL_NAME };
  assert.ok(workflowRunToEvent(run({ action: 'requested' }), opts).ignored);
  assert.ok(workflowRunToEvent(run({ name: 'Deploy' }), opts).ignored);
  assert.ok(workflowRunToEvent(run({ repo: 'someone/else' }), opts).ignored);
  assert.ok(workflowRunToEvent(run({ branch: 'main' }), opts).ignored);

  for (const bad of [run({ branch: undefined }), run({ branch: 'co/../x' }), run({ branch: 'co/' }), run({ sha: 'nothex' }), run({ id: -1 }), run({ updated_at: undefined }), 'garbage', null]) {
    const { event } = workflowRunToEvent(bad, opts);
    assert.equal(validateEvent(event, { project_id: PROJECT }).ok, false, JSON.stringify(bad));
  }
});

// ---- 2. idempotency across the adapter ----------------------------------------------------------
test('adapter idempotency: redelivery derives the SAME event_id (runId:runAttempt); re-run attempt is new', async () => {
  const a = workflowRunToEvent(run(), { project_id: PROJECT }).event.event_id;
  const b = workflowRunToEvent(JSON.parse(JSON.stringify(run())), { project_id: PROJECT }).event.event_id;
  const c = workflowRunToEvent(run({ attempt: 2 }), { project_id: PROJECT }).event.event_id;
  assert.equal(a, b);
  assert.equal(a, 'gh-run-4242-1');
  assert.equal(c, 'gh-run-4242-2');
});

test('adapter idempotency: same webhook delivered 3x -> processed once, the rest are no-ops', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-idem'), redeliver: false });
  const s = await untilAwaitingCi(loop);
  const payload = run({ sha: s.pending_ci_sha });
  for (let i = 0; i < 3; i++) ingestWorkflowRun(loop.cp, payload, { repo_full_name: REPO_FULL_NAME });
  loop.ci.queue.length = 0; // we delivered task 1's CI by hand

  const r = await pump(loop);
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(r.state.completed_tasks, ['CO-SIM-001', 'CO-SIM-002']);
  assert.deepEqual(loop.worker.calls, ['CO-SIM-001', 'CO-SIM-002']); // no double dispatch
  assert.deepEqual(loop.planner.reviews, ['CO-SIM-001', 'CO-SIM-002']); // reviewed once each
  const dups = kinds(loop.cp, 'duplicate_event_ignored').filter((e) => e.event_id === 'gh-run-4242-1');
  assert.equal(dups.length, 2);
});

// ---- 3. exact-SHA gate ---------------------------------------------------------------------------
test('exact-SHA: CI result for a sha other than the pending one -> no work, logged stale', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-stale'), redeliver: false });
  const s = await untilAwaitingCi(loop);
  ingestWorkflowRun(loop.cp, run({ id: 1, sha: 'd'.repeat(40) }), { repo_full_name: REPO_FULL_NAME });
  await loop.cp.run();
  const after = loop.cp.state();
  assert.equal(after.status, 'WAITING_EVENT');
  assert.equal(after.awaiting, 'ci');
  assert.equal(after.pending_ci_sha, s.pending_ci_sha);
  assert.equal(after.failure_count, 0);
  assert.deepEqual(after.completed_tasks, []);
  assert.deepEqual(loop.planner.reviews, []);
  const stale = kinds(loop.cp, 'event_stale').find((e) => e.event_id === 'gh-run-1-1');
  assert.match(stale.reason, /is not pending_ci_sha/);
  // The genuine CI result still completes the loop afterwards.
  assert.equal((await pump(loop)).state.status, 'COMPLETE');
});

test('exact-SHA: branch head moved after the commit -> CI result is stale; reconcile blocks', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-head'), redeliver: false });
  const s = await untilAwaitingCi(loop);
  // Someone else pushes on top of the worker's commit before CI reports.
  loop.repo.commitOnBranch('co/CO-SIM-001', s.pending_ci_sha, 'intruder.txt', 'x\n', 'unexpected writer');
  loop.ci.deliverNext(loop.cp); // CI for the worker's (now superseded) sha
  await loop.cp.run();
  assert.equal(loop.cp.state().status, 'WAITING_EVENT');
  assert.deepEqual(loop.cp.state().completed_tasks, []);
  assert.match(kinds(loop.cp, 'event_stale').pop().reason, /branch head moved/);

  assert.equal((await loop.cp.reconcile()).decision, 'branch_moved');
  assert.equal(loop.cp.state().status, 'BLOCKED');
  assert.match(loop.cp.state().next_safe_action, /^NEEDS_HUMAN/);
});

test('exact-SHA: CI result arriving before the worker result is stale (not awaiting CI)', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-early'), redeliver: false });
  await loop.cp.start();
  await loop.cp.step(); // dispatch: worker committed, its event is in the inbox, CI queued
  const lines = loop.cp.store.readInbox();
  loop.ci.deliverNext(loop.cp); // CI event appended after the worker event...
  const all = loop.cp.store.readInbox();
  fs.writeFileSync(loop.cp.store.p.inbox, [all[all.length - 1], ...lines].join('\n') + '\n'); // ...reorder: CI first
  await loop.cp.step();
  assert.match(kinds(loop.cp, 'event_stale').pop().reason, /not awaiting a CI result/);
  assert.equal(loop.cp.state().awaiting, 'worker');
});

// ---- CI failure / planner review ------------------------------------------------------------------
test('CI failure -> FAILED -> retry with a fresh commit -> COMPLETE; 3 CI failures trip the breaker', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-cifail'), ciScript: { 'CO-SIM-001': ['failure'] } });
  await loop.cp.start();
  const r = await pump(loop);
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(loop.worker.calls, ['CO-SIM-001', 'CO-SIM-001', 'CO-SIM-002']);
  assert.ok(transitions(loop.cp).includes('WAITING_EVENT->FAILED'));

  const loop2 = createLocalLoop({ root: tmpDir('p2a-breaker'), ciScript: { 'CO-SIM-001': ['failure', 'failure', 'failure', 'success'] } });
  await loop2.cp.start();
  const r2 = await pump(loop2);
  assert.equal(r2.state.status, 'BLOCKED');
  assert.equal(r2.state.failure_count, 3);
  assert.equal(loop2.worker.calls.length, 3);
  assert.equal(loop2.cp.store.listEscalations().length, 1);
});

test('planner review REJECT counts as a failure even when CI is green', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-review'), rejectReviews: ['CO-SIM-001'] });
  await loop.cp.start();
  const r = await pump(loop);
  assert.equal(r.state.status, 'BLOCKED'); // rejected 3x -> breaker
  assert.deepEqual(r.state.completed_tasks, []);
  assert.match(loop.cp.store.listEscalations()[0].last_errors[0], /planner review: verdict REJECT/);
});

// ---- 4. reconcile after restart ------------------------------------------------------------------
test('reconcile: crash after the worker committed (result lost) -> restart adopts commit, no repeated work', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-crash'), crashAfterCommit: ['CO-SIM-001'] });
  await loop.cp.start();
  await assert.rejects(async () => await pump(loop), /simulated crash after commit/);
  const crashed = loop.cp.state();
  assert.equal(crashed.status, 'WAITING_EVENT');
  assert.equal(crashed.awaiting, 'worker');
  assert.equal(loop.cp.store.readInbox().length, 0); // the worker's result never arrived
  const commitSha = loop.repo.git(['rev-parse', 'co/CO-SIM-001']);

  // Restart: brand-new control plane, planner and worker objects; only durable files + git remain.
  loop.newControlPlane({ crash: [] });
  await loop.cp.resume();
  const rec = kinds(loop.cp, 'reconcile').pop();
  assert.equal(rec.decision, 'adopt_commit');
  assert.equal(rec.head, commitSha);
  assert.equal(loop.cp.state().pending_ci_sha, commitSha);

  // CI for the adopted commit was triggered by the push before the crash; the pump delivers it.
  assert.deepEqual(loop.ci.queue, [{ branch: 'co/CO-SIM-001', sha: commitSha }]);
  const r = await pump(loop);
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(loop.worker.calls, ['CO-SIM-002']); // task 1 was NOT re-executed after restart
  assert.equal(loop.repo.countCommits(loop.repo.baseSha, 'co/CO-SIM-001'), 1); // exactly one commit for task 1
});

test('reconcile: crash after CI event was received -> restart processes durable inbox, no re-dispatch', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-crash2'), redeliver: false });
  await untilAwaitingCi(loop);
  loop.ci.deliverNext(loop.cp); // CI event durable in inbox, not processed yet ("crash" now)

  loop.newControlPlane({ crash: [] });
  assert.equal((await loop.cp.reconcile()).decision, 'inbox_pending'); // never acts with unprocessed events
  const r = (await loop.cp.resume(), await pump(loop));
  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(loop.worker.calls, ['CO-SIM-002']); // the new instance only ran task 2
  assert.equal(loop.repo.countCommits(loop.repo.baseSha, 'co/CO-SIM-001'), 1);
});

test('reconcile: awaiting worker with no commit -> waits, never re-dispatches', async () => {
  const root = tmpDir('p2a-nocommit');
  const repo = new ScratchRepo(path.join(root, 'repo')).init();
  const dir = path.join(root, 'control');
  const cp = new ControlPlane({ dir, planner: new SimPlanner(), worker: new OutboxWorker(dir), requireCi: true, repo: new GitRefs(repo.gitDir) })
    .init({ base_sha: repo.baseSha });
  await cp.start();
  await cp.run();
  assert.equal(cp.state().awaiting, 'worker');
  assert.equal((await cp.reconcile()).decision, 'no_commit_yet');
  assert.equal(cp.state().status, 'WAITING_EVENT');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'outbox')), ['CO-SIM-001.json']); // dispatched exactly once
});

test('reconcile: consistent state while awaiting CI is a no-op', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-consistent'), redeliver: false });
  const s = await untilAwaitingCi(loop);
  assert.equal((await loop.cp.reconcile()).decision, 'consistent');
  assert.equal(loop.cp.state().status, 'WAITING_EVENT');
  assert.equal(loop.cp.state().pending_ci_sha, s.pending_ci_sha);
});

// ---- 6. full local chain ---------------------------------------------------------------------------
test('full local chain: workflow_run -> adapter -> control plane -> review -> next task -> COMPLETE, no "continue"', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-chain') });
  await loop.cp.start();
  const r = await pump(loop); // one call; the pump only delivers simulated webhooks

  assert.equal(r.state.status, 'COMPLETE');
  assert.deepEqual(r.state.completed_tasks, ['CO-SIM-001', 'CO-SIM-002']);
  assert.equal(r.state.last_verified_sha, loop.repo.git(['rev-parse', 'co/CO-SIM-002']));
  assert.equal(loop.repo.git(['rev-parse', 'co/CO-SIM-002^']), loop.repo.git(['rev-parse', 'co/CO-SIM-001'])); // task 2 built on task 1
  assert.deepEqual(loop.planner.reviews, ['CO-SIM-001', 'CO-SIM-002']);
  assert.equal(kinds(loop.cp, 'duplicate_event_ignored').length, 1); // task 1's redelivery (task 2's arrives after COMPLETE)
  assert.deepEqual(transitions(loop.cp), [
    'IDLE->RUNNING',
    'RUNNING->WAITING_EVENT', 'WAITING_EVENT->RUNNING',
    'RUNNING->WAITING_EVENT', 'WAITING_EVENT->RUNNING',
    'RUNNING->COMPLETE',
  ]);
  // Completing transitions are caused by the GitHub-derived CI events.
  const done = loop.cp.store.readAudit().filter((e) => e.kind === 'transition' && e.from === 'WAITING_EVENT');
  assert.deepEqual(done.map((e) => e.event_id), ['gh-run-7001-1', 'gh-run-7002-1']);
});

test('deterministic: two runs produce identical SHAs and event ids', async () => {
  const pick = async (name) => {
    const loop = createLocalLoop({ root: tmpDir(name) });
    await loop.cp.start();
    const r = await pump(loop);
    return [r.state.last_verified_sha, loop.ci.delivered.map((d) => d.event.event_id)];
  };
  assert.deepEqual(await pick('p2a-det-a'), await pick('p2a-det-b'));
});

// ---- CLI ingest (what orchestrator.yml runs) ---------------------------------------------------------
test('cli ingest: workflow_run file -> control plane step -> next task written to outbox', async () => {
  const loop = createLocalLoop({ root: tmpDir('p2a-cli'), redeliver: false });
  const s = await untilAwaitingCi(loop);
  const file = path.join(loop.root, 'event.json');
  const log = console.log;
  console.log = () => {};
  try {
    fs.writeFileSync(file, JSON.stringify(run({ id: 99, sha: s.pending_ci_sha, action: 'requested' })));
    await main(['ingest', loop.controlDir, file, '--git-dir', loop.repo.gitDir, '--repo', REPO_FULL_NAME]);
    assert.equal(loop.cp.state().version, s.version); // ignored: nothing changed

    fs.writeFileSync(file, JSON.stringify(run({ id: 99, sha: s.pending_ci_sha })));
    await main(['ingest', loop.controlDir, file, '--git-dir', loop.repo.gitDir, '--repo', REPO_FULL_NAME]);
  } finally {
    console.log = log;
  }
  const after = loop.cp.state();
  assert.deepEqual(after.completed_tasks, ['CO-SIM-001']);
  assert.equal(after.current_task_id, 'CO-SIM-002');
  assert.ok(fs.existsSync(path.join(loop.controlDir, 'outbox', 'CO-SIM-002.json')));
  assert.ok(kinds(loop.cp, 'ingest_ignored').length === 1);
});

// ---- 8. offline guard ------------------------------------------------------------------------------------
test('offline: harness uses no network modules and only spawns the local git binary', async () => {
  const dir = path.join(__dirname, '..', 'harness');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /require\(['"](node:)?(http|https|net|dgram|tls|dns|http2)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket/, f);
    for (const m of text.matchAll(/\b(?:execFile|execFileSync|spawnSync)\(\s*([^,]+),/g)) assert.equal(m[1].trim(), "'git'", f);
    assert.doesNotMatch(text, /\b(spawn|exec|execSync|fork)\(/, f);
  }
});
