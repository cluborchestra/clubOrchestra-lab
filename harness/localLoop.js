'use strict';

// Local stand-in for the GitHub loop (P2a): a scratch git repo, a worker that makes real commits,
// and a simulated CI that emits GitHub-shaped workflow_run payloads. Offline: the only external
// program used is the local `git` binary, run with system/global config disabled so nothing
// outside the scratch repo is read or written. Commit dates are fixed, so SHAs are deterministic.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ControlPlane } = require('../src/controlPlane');
const { GitRefs } = require('../src/gitRefs');
const { SimPlanner } = require('../src/sim/planner');
const { taskBranch } = require('../src/policy');
const { ingestWorkflowRun } = require('../src/ingest');

const REPO_FULL_NAME = 'local/clubOrchestra-lab';
const FIXED_DATE = '2026-10-04T12:00:00Z';

class ScratchRepo {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.gitDir = path.join(this.dir, '.git');
    this.emptyConfig = path.join(this.dir, '.sim-empty-gitconfig');
  }

  git(args) {
    return execFileSync('git', args, {
      cwd: this.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot, // required by git on Windows
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: this.emptyConfig,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'sim-worker', GIT_AUTHOR_EMAIL: 'sim-worker@cluborchestra.invalid', GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_NAME: 'sim-worker', GIT_COMMITTER_EMAIL: 'sim-worker@cluborchestra.invalid', GIT_COMMITTER_DATE: FIXED_DATE,
      },
    }).trim();
  }

  init() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.emptyConfig, '');
    this.git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(this.dir, 'README.md'), '# sim target repo\n');
    this.git(['add', 'README.md']);
    this.git(['commit', '-q', '-m', 'base']);
    this.baseSha = this.git(['rev-parse', 'HEAD']);
    return this;
  }

  // Branch from startSha (resetting the branch if it exists), write one file, commit.
  commitOnBranch(branch, startSha, file, content, message) {
    this.git(['checkout', '-q', '-B', branch, startSha]);
    fs.mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, file), content);
    this.git(['add', file]);
    this.git(['commit', '-q', '-m', message]);
    return this.git(['rev-parse', 'HEAD']);
  }

  countCommits(from, to) {
    return Number(this.git(['rev-list', '--count', `${from}..${to}`]));
  }
}

// GitHub-shaped workflow_run webhook payload (only the fields the adapter reads).
function makeWorkflowRun({ id, attempt = 1, branch, sha, conclusion, updated_at, name = 'CI', repo = REPO_FULL_NAME, action = 'completed' }) {
  return {
    action,
    workflow_run: { id, run_attempt: attempt, name, head_branch: branch, head_sha: sha, status: 'completed', conclusion, updated_at },
    repository: { full_name: repo },
  };
}

class SimCI {
  constructor({ clock, script = {}, redeliver = true } = {}) {
    this.clock = clock;
    this.script = script; // task_id -> list of conclusions per run ('success' default)
    this.redeliver = redeliver; // deliver every webhook twice, like a GitHub retry
    this.queue = [];
    this.runs = 0;
    this.byTask = {};
    this.delivered = [];
  }

  onPush(branch, sha) {
    this.queue.push({ branch, sha });
  }

  pending() {
    return this.queue.length > 0;
  }

  deliverNext(cp) {
    const { branch, sha } = this.queue.shift();
    const taskId = branch.split('/').pop();
    const n = (this.byTask[taskId] = (this.byTask[taskId] || 0) + 1);
    const conclusion = (this.script[taskId] || [])[n - 1] || 'success';
    const payload = makeWorkflowRun({ id: 7000 + ++this.runs, branch, sha, conclusion, updated_at: this.clock() });
    const out = ingestWorkflowRun(cp, payload, { repo_full_name: REPO_FULL_NAME });
    if (this.redeliver) ingestWorkflowRun(cp, payload, { repo_full_name: REPO_FULL_NAME });
    this.delivered.push({ payload, event: out.event });
    return out;
  }
}

class GitWorker {
  constructor({ repo, ci, clock, crashAfterCommit = [] }) {
    this.repo = repo;
    this.ci = ci;
    this.clock = clock;
    this.crashAfterCommit = new Set(crashAfterCommit); // task_ids: crash once after committing
    this.attempts = {};
    this.calls = [];
  }

  execute(h) {
    const attempt = (this.attempts[h.task_id] = (this.attempts[h.task_id] || 0) + 1);
    this.calls.push(h.task_id);
    const branch = taskBranch(h.task_id);
    const sha = this.repo.commitOnBranch(branch, h.starting_sha, `work/${h.task_id}.txt`,
      `${h.task_id} attempt ${attempt}\n`, `${h.task_id}: ${h.objective} (attempt ${attempt})`);
    this.ci.onPush(branch, sha); // the push triggers CI on GitHub's side, whatever happens to us next
    if (this.crashAfterCommit.delete(h.task_id)) throw new Error(`simulated crash after commit ${sha}`);
    return {
      schema_version: 1, event_id: `evt-worker-${h.task_id}-${sha.slice(0, 12)}`, type: 'task.completed',
      created_at: this.clock(), producer: 'worker', project_id: 'clubOrchestra-lab',
      repo: REPO_FULL_NAME, branch, sha, task_id: h.task_id, status: 'success',
      payload: {
        task_id: h.task_id, outcome: 'PASS', starting_sha: h.starting_sha, ending_sha: sha,
        files_changed: [`work/${h.task_id}.txt`], tests: [{ name: 'sim-unit', status: 'pass' }],
        ci: { status: 'pending' }, docs_synced: true, risks: [], blockers: [], next_recommendation: 'await CI',
      },
      evidence_refs: [`git:${sha}`],
    };
  }
}

function makeClock() {
  let t = 0;
  return () => new Date(Date.parse(FIXED_DATE) + 1000 * t++).toISOString();
}

// Wire everything for a run rooted at `root` (inside the repo, gitignored).
function createLocalLoop({ root, plan, ciScript, redeliver = true, crashAfterCommit = [], rejectReviews = [] }) {
  const clock = makeClock();
  const repo = new ScratchRepo(path.join(root, 'repo')).init();
  const ci = new SimCI({ clock, script: ciScript, redeliver });
  const controlDir = path.join(root, 'control');
  fs.rmSync(controlDir, { recursive: true, force: true });
  const loop = { root, clock, repo, ci, controlDir };
  loop.newControlPlane = ({ crash = crashAfterCommit } = {}) => {
    loop.planner = new SimPlanner({ ...(plan ? { plan } : {}), repo: REPO_FULL_NAME, rejectReviews });
    loop.worker = new GitWorker({ repo, ci, clock, crashAfterCommit: crash });
    loop.cp = new ControlPlane({
      dir: controlDir, planner: loop.planner, worker: loop.worker, now: clock,
      requireCi: true, repo: new GitRefs(repo.gitDir),
    }).init({ repo: REPO_FULL_NAME, base_sha: repo.baseSha });
    return loop.cp;
  };
  loop.newControlPlane();
  return loop;
}

// Event pump = simulated GitHub: run the control plane until it waits, then deliver the next CI
// webhook. There is no human input anywhere in this loop.
function pump(loop, { maxRounds = 100 } = {}) {
  let r;
  for (let i = 0; i < maxRounds; i++) {
    r = loop.cp.run();
    if (r.stopped === 'waiting_event' && loop.ci.pending()) {
      loop.ci.deliverNext(loop.cp);
      continue;
    }
    return r;
  }
  return r;
}

module.exports = { ScratchRepo, SimCI, GitWorker, makeWorkflowRun, createLocalLoop, pump, REPO_FULL_NAME };
