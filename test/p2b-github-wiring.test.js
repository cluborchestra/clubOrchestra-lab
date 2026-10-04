'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { workflowRunToEvent } = require('../src/adapters/github');
const { ingestWorkflowRun } = require('../src/ingest');
const { createLocalLoop, pump, makeWorkflowRun, REPO_FULL_NAME } = require('../harness/localLoop');

const wf = (f) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8');
const PINNED = /uses: actions\/(checkout|setup-node)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

// ---- pre-merge adapter fix -----------------------------------------------------------------------
test('adapter: CI on a non-task branch (feature-branch PR) is ignored as "not ours"', () => {
  for (const branch of ['feat/co-p2b-001-github-wiring', 'main', 'orchestra-state', 'cox/CO-1']) {
    const out = workflowRunToEvent(makeWorkflowRun({ id: 1, branch, sha: 'a'.repeat(40), conclusion: 'success', updated_at: '2026-10-04T12:00:00Z' }), { project_id: 'clubOrchestra-lab' });
    assert.equal(out.ignored, true, branch);
    assert.match(out.reason, /not a task branch/);
  }
});

test('adapter: PR CI result arriving mid-loop does not block or change state; loop still completes', () => {
  const loop = createLocalLoop({ root: tmpDir('p2b-pr-ci'), redeliver: false });
  loop.cp.start();
  loop.cp.run(); // awaiting CI for task 1
  const before = loop.cp.state();
  const out = ingestWorkflowRun(loop.cp, makeWorkflowRun({
    id: 555, branch: 'feat/co-p2b-001-github-wiring', sha: 'b'.repeat(40), conclusion: 'failure', updated_at: '2026-10-04T12:00:00Z',
  }), { repo_full_name: REPO_FULL_NAME });
  assert.equal(out.ignored, true);
  loop.cp.run();
  const after = loop.cp.state();
  assert.equal(after.status, 'WAITING_EVENT');
  assert.equal(after.version, before.version); // nothing was taken in
  assert.equal(after.failure_count, 0);
  assert.equal(loop.cp.store.readInbox().length, before.inbox_cursor);
  assert.ok(loop.cp.store.readAudit().some((e) => e.kind === 'ingest_ignored' && /not a task branch/.test(e.reason)));
  assert.equal(pump(loop).state.status, 'COMPLETE');
});

// ---- orchestrator wiring -------------------------------------------------------------------------
test('orchestrator: disabled unless ORCHESTRATOR_ENABLED == "true"; only push-CI from this repo', () => {
  const o = wf('orchestrator.yml');
  const cond = o.match(/ {4}if: >-\n((?: {6}.*\n)+)/);
  assert.ok(cond, 'job-level if: present');
  const parts = cond[1].split('&&').map((p) => p.trim());
  assert.deepEqual(parts, [
    "vars.ORCHESTRATOR_ENABLED == 'true'",
    "github.event.workflow_run.event == 'push'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ]);
  assert.equal((o.match(/^ {2}\w[\w-]*:\n {4}if:/gm) || []).length, 1); // the only job, and it is gated
});

test('orchestrator: state-branch pattern; never pushes to main; single writer', () => {
  const o = wf('orchestrator.yml');
  assert.match(o, /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/);
  assert.match(o, /^concurrency:\n\s+group: clubOrchestra\n\s+cancel-in-progress: false$/m);
  assert.match(o, /ref: orchestra-state\n\s+path: state/);
  assert.match(o, /node src\/cli\.js ingest state\/data "\$GITHUB_EVENT_PATH" --git-dir \.git --repo "\$REPO"/);
  assert.match(o, /working-directory: state[\s\S]*git push origin HEAD:orchestra-state/);
  // Every git push is exactly the non-forced state-branch push.
  const pushes = o.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l.replace(/#.*$/, '')));
  assert.deepEqual(pushes.map((l) => l.trim()), ['git push origin HEAD:orchestra-state']);
  assert.match(o, /^permissions:\n\s+contents: write/m);
});

test('workflows: actions pinned to commit SHAs, no secrets, no script injection', () => {
  for (const f of ['ci.yml', 'orchestrator.yml']) {
    const text = wf(f);
    const uses = text.split('\n').filter((l) => /uses:/.test(l));
    assert.ok(uses.length > 0, f);
    for (const l of uses) assert.match(l.trim().replace(/^- /, ''), PINNED, `${f}: ${l}`);
    assert.doesNotMatch(text, /secrets\./, f);
    assert.match(text, /^permissions:/m, f);
    // no ${{ github.event... }} anywhere inside a run: block
    const runBlocks = text.match(/run: \|?[^\n]*(\n {10,}[^\n]*)*/g) || [];
    for (const b of runBlocks) assert.doesNotMatch(b, /\$\{\{/, `${f}: ${b}`);
  }
  const ci = wf('ci.yml');
  assert.match(ci, /^name: CI$/m);
  assert.match(ci, /branches: \['co\/\*\*'\]/);
  assert.match(ci, /permissions:\n\s+contents: read/);
});
