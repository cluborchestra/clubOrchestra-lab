#!/usr/bin/env node
'use strict';

// Offline CLI for the P1 control plane with simulated planner + worker.
//   node src/cli.js demo [dir]                 happy path: 2 tasks -> COMPLETE, prints audit
//   node src/cli.js demo-approval [dir]        stops at WAITING_APPROVAL (approve, then `run`)
//   node src/cli.js init <dir>
//   node src/cli.js run <dir> [--plan approval]
//   node src/cli.js status <dir>
//   node src/cli.js approve <dir> <approval_id> --by <name>
//   node src/cli.js deny <dir> <approval_id> --by <name>
//   node src/cli.js reset <dir> --by <name>     human reset BLOCKED -> IDLE
//   node src/cli.js owner-issues <dir> <outDir>        write <id>.title/<id>.md per unopened owner issue; print ids
//   node src/cli.js owner-issue-opened <dir> <id> <url> record the opened issue URL (idempotent)
//   node src/cli.js ingest <dir> <workflow_run.json> --git-dir <path> [--repo owner/name]
//       P2 entry point used by .github/workflows/orchestrator.yml: GitHub workflow_run payload ->
//       adapter -> intake -> control plane steps (CI-gated, head read from --git-dir).

const fs = require('node:fs');
const path = require('node:path');
const { ControlPlane } = require('./controlPlane');
const { SimPlanner, DEFAULT_PLAN } = require('./sim/planner');
const { SimWorker } = require('./sim/worker');
const { OutboxWorker } = require('./outboxWorker');
const { GitRefs } = require('./gitRefs');
const { ingestWorkflowRun } = require('./ingest');
const { OwnerIssueOutbox } = require('./ownerIssues');

const APPROVAL_PLAN = [DEFAULT_PLAN[0], { task_id: 'CO-SIM-003', action: 'deploy', objective: 'Simulated deploy (approval-gated)' }];

function makeCp(dir, planName) {
  return new ControlPlane({
    dir,
    planner: new SimPlanner({ plan: planName === 'approval' ? APPROVAL_PLAN : DEFAULT_PLAN }),
    worker: new SimWorker(),
  });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

function summary(cp) {
  const s = cp.state();
  return { status: s.status, version: s.version, completed_tasks: s.completed_tasks, last_verified_sha: s.last_verified_sha, failure_count: s.failure_count, next_safe_action: s.next_safe_action };
}

function decide(dir, id, by, status) {
  if (!by) throw new Error('--by <name> is required');
  const cp = makeCp(dir);
  const a = cp.store.readApproval(id);
  if (!a) throw new Error(`no approval request ${id}`);
  cp.store.writeApproval({ ...a, status, approved_by: by, approved_at: new Date().toISOString() });
  cp.audit({ kind: `approval_${status}`, approval_id: id, task_id: a.task_id, actor: `human:${by}` });
  console.log(`${id} -> ${status} by ${by}`);
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'demo': {
      const dir = freshDir(args[0] || path.join('runs', 'demo'));
      const cp = makeCp(dir).init();
      await cp.start();
      const r = await cp.run();
      console.log(JSON.stringify({ stopped: r.stopped, steps: r.steps, ...summary(cp) }, null, 2));
      console.log('\n--- audit.jsonl ---');
      process.stdout.write(fs.readFileSync(cp.store.p.audit, 'utf8'));
      return r.state.status === 'COMPLETE' ? 0 : 1;
    }
    case 'demo-approval': {
      const dir = freshDir(args[0] || path.join('runs', 'demo-approval'));
      const cp = makeCp(dir, 'approval').init();
      await cp.start();
      const r = await cp.run();
      console.log(JSON.stringify({ stopped: r.stopped, ...summary(cp) }, null, 2));
      console.log(`\nApprove with:  node src/cli.js approve ${dir} CO-SIM-003.deploy --by <name>`);
      console.log(`Then resume:   node src/cli.js run ${dir} --plan approval`);
      return 0;
    }
    case 'init':
      makeCp(args[0]).init();
      console.log(`initialized ${args[0]}`);
      return 0;
    case 'run': {
      const cp = makeCp(args[0], flag(args, '--plan'));
      if (cp.state().status === 'IDLE') await cp.start();
      const r = await cp.run();
      console.log(JSON.stringify({ stopped: r.stopped, steps: r.steps, ...summary(cp) }, null, 2));
      return 0;
    }
    case 'status':
      console.log(JSON.stringify(makeCp(args[0]).state(), null, 2));
      return 0;
    case 'approve':
      decide(args[0], args[1], flag(args, '--by'), 'approved');
      return 0;
    case 'deny':
      decide(args[0], args[1], flag(args, '--by'), 'denied');
      return 0;
    case 'ingest': {
      const [dir, file] = args;
      const gitDir = flag(args, '--git-dir');
      if (!dir || !file || !gitDir) throw new Error('usage: ingest <dir> <workflow_run.json> --git-dir <path> [--repo owner/name]');
      const cp = new ControlPlane({
        dir, planner: new SimPlanner(), worker: new OutboxWorker(dir), requireCi: true, repo: new GitRefs(gitDir),
      });
      const raw = fs.readFileSync(file, 'utf8');
      let gh;
      try { gh = JSON.parse(raw); } catch { gh = undefined; }
      if (gh === undefined) {
        cp.intake(raw); // unparseable: let the control plane reject it and fail closed
      } else {
        const out = ingestWorkflowRun(cp, gh, { repo_full_name: flag(args, '--repo') || null });
        if (out.ignored) {
          console.log(JSON.stringify({ ignored: true, reason: out.reason }));
          return 0;
        }
      }
      const r = await cp.run();
      console.log(JSON.stringify({ stopped: r.stopped, steps: r.steps, ...summary(cp) }, null, 2));
      return 0;
    }
    case 'owner-issues': {
      const [dir, outDir] = args;
      if (!dir || !outDir) throw new Error('usage: owner-issues <dir> <outDir>');
      fs.mkdirSync(outDir, { recursive: true });
      for (const r of new OwnerIssueOutbox(dir).pending()) {
        fs.writeFileSync(path.join(outDir, `${r.approval_id}.title`), r.title);
        fs.writeFileSync(path.join(outDir, `${r.approval_id}.md`), `${r.body}\n`);
        console.log(r.approval_id);
      }
      return 0;
    }
    case 'owner-issue-opened': {
      const [dir, id, url] = args;
      new OwnerIssueOutbox(dir).markOpened(id, url);
      return 0;
    }
    case 'reset': {
      const by = flag(args, '--by');
      await makeCp(args[0]).humanReset({ by });
      console.log('reset to IDLE');
      return 0;
    }
    default:
      console.error('usage: node src/cli.js <demo|demo-approval|init|run|status|approve|deny|reset|ingest|owner-issues|owner-issue-opened> ...');
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 1; });
}

module.exports = { main };
