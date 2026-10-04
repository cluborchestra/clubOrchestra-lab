'use strict';

const crypto = require('node:crypto');

// Deterministic, offline worker stub (stands in for Claude Code headless in P3).
// Given a handoff, returns a canned task.completed event carrying a from-worker result (§4.6).
// `script` maps task_id -> list of outcomes consumed per attempt ('PASS' | 'FAIL'); default PASS.

function fakeSha(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

class SimWorker {
  constructor({ script = {}, project_id = 'clubOrchestra-lab', branch = 'main', clock = () => new Date().toISOString(), payloadExtra = {} } = {}) {
    this.script = script;
    this.project_id = project_id;
    this.branch = branch;
    this.clock = clock;
    this.payloadExtra = payloadExtra;
    this.attempts = {};
    this.calls = [];
  }

  execute(handoff) {
    const attempt = (this.attempts[handoff.task_id] = (this.attempts[handoff.task_id] || 0) + 1);
    this.calls.push(handoff.task_id);
    const planned = (this.script[handoff.task_id] || [])[attempt - 1] || 'PASS';
    const pass = planned === 'PASS';
    const ending_sha = fakeSha(handoff.starting_sha, handoff.task_id, attempt);
    return {
      schema_version: 1,
      event_id: `evt-${fakeSha('event', handoff.task_id, attempt).slice(0, 12)}`,
      type: 'task.completed',
      created_at: this.clock(),
      producer: 'worker',
      project_id: this.project_id,
      repo: handoff.repo,
      branch: this.branch,
      sha: ending_sha,
      task_id: handoff.task_id,
      status: pass ? 'success' : 'failure',
      payload: {
        task_id: handoff.task_id,
        outcome: pass ? 'PASS' : 'FAIL',
        starting_sha: handoff.starting_sha,
        ending_sha,
        files_changed: [`sim/${handoff.task_id}.txt`],
        tests: [{ name: 'sim-unit', status: pass ? 'pass' : 'fail' }],
        ci: { status: pass ? 'success' : 'failure', simulated: true },
        docs_synced: true,
        risks: [],
        blockers: [],
        next_recommendation: pass ? 'proceed' : 'retry',
        ...this.payloadExtra,
      },
      evidence_refs: [`sim://${handoff.task_id}/attempt-${attempt}`],
    };
  }
}

module.exports = { SimWorker, fakeSha };
