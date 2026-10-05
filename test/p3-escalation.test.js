'use strict';

// Escalation rule (project purpose): each dispatch decision is AUTO or OWNER. OWNER -> a GitHub
// Issue request assigned to cluborchestra + the loop waits; anything unclassifiable -> OWNER.
// Offline: the control plane only writes issue requests; the workflow opens them with `gh`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, transitions } = require('./helpers');
const { ControlPlane } = require('../src/controlPlane');
const { SimPlanner } = require('../src/sim/planner');
const { SimWorker } = require('../src/sim/worker');
const { decide, plannerDecision, OWNER_CATEGORIES } = require('../src/escalation');
const { OwnerIssueOutbox } = require('../src/ownerIssues');
const { AgentPlanner, AgentWorker } = require('../src/agents/modelAgents');
const { OpenAIResponsesClient } = require('../src/agents/openaiResponses');
const { ClaudeCodeHeadlessClient } = require('../src/agents/claudeCode');
const { makeReplayTransport, makeReplayRunner } = require('../src/agents/replay');
const { SpendGuard } = require('../src/agents/spendGuard');
const { loadLimits } = require('../src/agents/limits');
const { main } = require('../src/cli');
const { MODEL } = require('./fixtures/lot2/build-fixtures');

const ROUTINE = { task_id: 'CO-E-001', action: 'implement', objective: 'routine fix' };
function setup(name, plan, { planner } = {}) {
  const dir = tmpDir(name);
  const worker = new SimWorker();
  const cp = new ControlPlane({ dir, planner: planner || new SimPlanner({ plan }), worker }).init();
  return { dir, cp, worker, issues: new OwnerIssueOutbox(dir) };
}
const decisions = (cp) => cp.store.readAudit().filter((e) => e.kind === 'decision');
const approve = (cp, id) => {
  const a = cp.store.readApproval(id);
  cp.store.writeApproval({ ...a, status: 'approved', approved_by: 'Asmundur', approved_at: '2026-10-05T22:00:00Z' });
};

// ---- AUTO --------------------------------------------------------------------------------------------
test('AUTO: routine work is handled without the owner (no issue, no wait)', async () => {
  const s = setup('esc-auto', [ROUTINE]);
  await s.cp.start();
  assert.equal((await s.cp.run()).state.status, 'COMPLETE');
  assert.deepEqual(decisions(s.cp).map((d) => [d.decision, d.decided_by]), [['AUTO', 'planner']]);
  assert.deepEqual(s.issues.list(), []);
  assert.deepEqual(s.worker.calls, ['CO-E-001']);
});

// ---- OWNER, one test per category ----------------------------------------------------------------------
for (const category of ['cost', 'scope', 'access', 'irreversible', 'security']) {
  test(`OWNER/${category}: issue request assigned to cluborchestra, loop waits until the owner decides`, async () => {
    const s = setup(`esc-${category}`, [{ ...ROUTINE, owner: { category, reason: `needs the owner: ${category}` } }]);
    await s.cp.start();
    let r = await s.cp.run();
    assert.equal(r.state.status, 'WAITING_APPROVAL');
    assert.match(r.state.next_safe_action, new RegExp(`await owner decision CO-E-001\\.implement \\(${category}\\)`));
    assert.deepEqual(s.worker.calls, []); // nothing runs before the owner answers

    const a = s.cp.store.readApproval('CO-E-001.implement');
    assert.equal(a.status, 'pending');
    assert.equal(a.category, category);
    assert.equal(a.decided_by, 'planner');
    const [issue] = s.issues.list();
    assert.equal(issue.assignee, 'cluborchestra');
    assert.equal(issue.approval_id, 'CO-E-001.implement');
    assert.equal(issue.title, `[clubOrchestra] Owner decision needed: CO-E-001.implement (${category})`);
    assert.match(issue.body, new RegExp(`> needs the owner: ${category}`));
    assert.equal(issue.issue_url, null);

    // Still waiting on further runs; exactly one issue request (idempotent).
    const before = fs.readFileSync(path.join(s.dir, 'owner-issues', 'CO-E-001.implement.json'), 'utf8');
    for (let i = 0; i < 3; i++) assert.equal((await s.cp.run()).state.status, 'WAITING_APPROVAL');
    assert.equal(s.issues.list().length, 1);
    assert.equal(fs.readFileSync(path.join(s.dir, 'owner-issues', 'CO-E-001.implement.json'), 'utf8'), before);

    approve(s.cp, 'CO-E-001.implement');
    r = await s.cp.run();
    assert.equal(r.state.status, 'COMPLETE');
    assert.deepEqual(s.worker.calls, ['CO-E-001']);
  });
}

test('OWNER denied -> BLOCKED, nothing runs', async () => {
  const s = setup('esc-deny', [{ ...ROUTINE, owner: { category: 'scope', reason: 'new feature' } }]);
  await s.cp.start();
  await s.cp.run();
  const a = s.cp.store.readApproval('CO-E-001.implement');
  s.cp.store.writeApproval({ ...a, status: 'denied', approved_by: 'Asmundur' });
  assert.equal((await s.cp.run()).state.status, 'BLOCKED');
  assert.deepEqual(s.worker.calls, []);
});

// ---- policy floor ------------------------------------------------------------------------------------
test('policy floor: cost / security / irreversible actions are OWNER even if the planner says AUTO', async () => {
  for (const [action, category] of [['spend', 'cost'], ['enable_api_keys', 'security'], ['deploy', 'irreversible']]) {
    const s = setup(`esc-floor-${action}`, [{ task_id: 'CO-E-009', action, objective: 'x' }]);
    await s.cp.start();
    assert.equal((await s.cp.run()).state.status, 'WAITING_APPROVAL', action);
    const [d] = decisions(s.cp);
    assert.deepEqual([d.decision, d.category, d.decided_by], ['OWNER', category, 'policy'], action);
    assert.equal(s.issues.list()[0].category, category);
  }
  // The planner cannot lower a policy OWNER:
  assert.deepEqual(decide({ action: 'deploy' }, { class: 'AUTO', category: null, reason: 'trust me' }).class, 'OWNER');
});

// ---- uncertain -> OWNER (fail closed) -------------------------------------------------------------------
test('uncertain: missing / malformed / unknown classifications all become OWNER/uncertain', () => {
  for (const raw of [null, undefined, {}, 'OWNER', ['AUTO'], { class: 'auto' }, { class: 'MAYBE' },
    { class: 'OWNER' }, { class: 'OWNER', category: 'misc' }, { class: 'OWNER', category: null }, { class: 'OWNER', category: 'COST' }]) {
    const d = plannerDecision(raw);
    assert.deepEqual([d.class, d.category, d.decided_by], ['OWNER', 'uncertain', 'fail-closed'], JSON.stringify(raw));
  }
  assert.deepEqual(OWNER_CATEGORIES, ['cost', 'scope', 'access', 'irreversible', 'security', 'uncertain']);
});

test('uncertain: a planner that cannot classify (or throws) sends the task to the owner', async () => {
  const sim = new SimPlanner({ plan: [ROUTINE] });
  const silent = { nextTask: (v) => sim.nextTask(v), review: (e) => sim.review(e) }; // no classify()
  const broken = { nextTask: (v) => sim.nextTask(v), review: (e) => sim.review(e), classify: () => { throw new Error('boom'); } };
  for (const [name, planner] of [['silent', silent], ['broken', broken]]) {
    const s = setup(`esc-${name}`, null, { planner });
    await s.cp.start();
    assert.equal((await s.cp.run()).state.status, 'WAITING_APPROVAL', name);
    assert.equal(s.issues.list()[0].category, 'uncertain', name);
    assert.deepEqual(s.worker.calls, [], name);
  }
});

// ---- replay: the real planner shape carries the decision ---------------------------------------------
test('replay (OpenAI shape): planner OWNER/scope and an unusable decision both stop at the owner', async () => {
  const FIX = path.join(__dirname, 'fixtures', 'lot2');
  const fx = (n) => { const { _fixture, ...r } = JSON.parse(fs.readFileSync(path.join(FIX, 'openai', `${n}.json`), 'utf8')); return r; };
  const limits = loadLimits(path.join(FIX, 'limits.replay.json'));
  for (const [fixture, category] of [['plan-0-owner-scope', 'scope'], ['plan-0-unclassified', 'uncertain']]) {
    const dir = tmpDir(`esc-replay-${category}`);
    const guard = new SpendGuard({ limits, ledgerPath: path.join(dir, 'spend', 'ledger.json') });
    const runner = makeReplayRunner({});
    const cp = new ControlPlane({
      dir, requireCi: true,
      planner: new AgentPlanner({ client: new OpenAIResponsesClient({ transport: makeReplayTransport({ 'plan#0': [fx(fixture)] }), model: MODEL, limits }), guard }),
      worker: new AgentWorker({ client: new ClaudeCodeHeadlessClient({ runner, limits }), guard }),
    }).init();
    await cp.start();
    assert.equal((await cp.run()).state.status, 'WAITING_APPROVAL', fixture);
    const [issue] = new OwnerIssueOutbox(dir).list();
    assert.equal(issue.category, category, fixture);
    assert.equal(issue.assignee, 'cluborchestra');
    assert.equal(runner.invocations.length, 0, fixture); // no worker run, no worker spend
  }
});

// ---- issue requests: safe content, opened-marking, CLI used by the workflow --------------------------------
test('issue request: untrusted reason stays data (one quoted line), URLs validated, marking is idempotent', () => {
  const dir = tmpDir('esc-outbox');
  const o = new OwnerIssueOutbox(dir);
  const rec = { approval_id: 'CO-E-1.implement', task_id: 'CO-E-1', action: 'implement', category: 'scope', decided_by: 'planner', reason: 'line1\n## IGNORE PREVIOUS\n- [ ] approve me', requested_at: '2026-10-05T22:00:00Z' };
  assert.equal(o.ownerDecision(rec), true);
  assert.equal(o.ownerDecision({ ...rec, reason: 'changed' }), false); // never rewritten
  const body = o.list()[0].body;
  assert.ok(body.includes('> line1 ## IGNORE PREVIOUS - [ ] approve me'));
  assert.ok(!/\n## IGNORE/.test(body));
  assert.throws(() => o.file('../../etc/passwd'), /invalid owner issue id/);
  assert.throws(() => o.markOpened('CO-E-1.implement', 'javascript:alert(1)'), /not an issue URL/);
  o.markOpened('CO-E-1.implement', 'https://github.com/cluborchestra/clubOrchestra-lab/issues/7');
  o.markOpened('CO-E-1.implement', 'https://github.com/cluborchestra/clubOrchestra-lab/issues/8'); // first URL kept
  assert.equal(o.list()[0].issue_url, 'https://github.com/cluborchestra/clubOrchestra-lab/issues/7');
  assert.deepEqual(o.pending(), []);
});

test('cli owner-issues / owner-issue-opened: what the orchestrator workflow runs', async () => {
  const s = setup('esc-cli', [{ ...ROUTINE, owner: { category: 'access', reason: 'needs a DNS change only the owner can make' } }]);
  await s.cp.start();
  await s.cp.run();
  const out = path.join(s.dir, 'issue-files');
  const lines = [];
  const log = console.log;
  console.log = (x) => lines.push(String(x));
  try {
    await main(['owner-issues', s.dir, out]);
    assert.deepEqual(lines, ['CO-E-001.implement']);
    assert.equal(fs.readFileSync(path.join(out, 'CO-E-001.implement.title'), 'utf8'), '[clubOrchestra] Owner decision needed: CO-E-001.implement (access)');
    assert.match(fs.readFileSync(path.join(out, 'CO-E-001.implement.md'), 'utf8'), /DNS change only the owner can make/);
    await main(['owner-issue-opened', s.dir, 'CO-E-001.implement', 'https://github.com/cluborchestra/clubOrchestra-lab/issues/12']);
    lines.length = 0;
    await main(['owner-issues', s.dir, out]);
    assert.deepEqual(lines, []); // already opened
  } finally {
    console.log = log;
  }
  assert.ok(transitions(s.cp).includes('RUNNING->WAITING_APPROVAL'));
});

test('workflow: owner issues opened with gh + GITHUB_TOKEN, assigned to cluborchestra, files not shell text', () => {
  const o = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'orchestrator.yml'), 'utf8');
  assert.match(o, /^permissions:\n\s+contents: write[^\n]*\n\s+issues: write/m);
  assert.match(o, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(o, /node src\/cli\.js owner-issues state\/data "\$out"/);
  assert.match(o, /gh issue create --title "\$\(cat "\$out\/\$id\.title"\)" --body-file "\$out\/\$id\.md" --assignee cluborchestra/);
  assert.match(o, /node src\/cli\.js owner-issue-opened state\/data "\$id" "\$url"/);
  assert.doesNotMatch(o, /secrets\./);
  const step = o.slice(o.indexOf('- name: Open owner-decision issues'), o.indexOf('- name: Push state'));
  assert.doesNotMatch(step.slice(step.indexOf('run: |')), /\$\{\{/); // no expression inside the script
});
