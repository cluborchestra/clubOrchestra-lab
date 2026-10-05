'use strict';

const fs = require('node:fs');
const path = require('node:path');

// File-backed store (spec D1: state + audit are plain files). Single writer is enforced by
//   1) a lease file (state.lock, owner + expires_at) created with O_EXCL, and
//   2) an optimistic version check: a commit must name the version it read; if another writer
//      committed first the commit is rejected with STALE_VERSION and the caller must re-read.

const ZERO_SHA = '0'.repeat(40);

function initialState({ project_id, repo, branch, base_sha }) {
  return {
    schema_version: 1,
    version: 0,
    project_id,
    status: 'IDLE',
    current_task_id: null,
    current_task: null,
    current_owner: null,
    awaiting: null, // 'worker' | 'ci' while WAITING_EVENT
    pending_ci_sha: null,
    lease_until: null,
    repo,
    branch,
    expected_sha: null,
    last_verified_sha: base_sha,
    last_event_id: null,
    failure_count: 0,
    next_safe_action: null,
    completed_tasks: [],
    inbox_cursor: 0,
  };
}

// Windows briefly refuses opens/renames while another process holds or replaces a file.
function retryTransient(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= 20 || (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  retryTransient(() => fs.renameSync(tmp, file));
}

function readJson(file) {
  return JSON.parse(retryTransient(() => fs.readFileSync(file, 'utf8')));
}

class Store {
  constructor(dir, { leaseMs = 30_000, now = () => Date.now() } = {}) {
    this.dir = path.resolve(dir);
    this.leaseMs = leaseMs;
    this.now = now;
    this.p = {
      state: path.join(this.dir, 'state.json'),
      lock: path.join(this.dir, 'state.lock'),
      processed: path.join(this.dir, 'processed_events.json'),
      inbox: path.join(this.dir, 'events', 'inbox.jsonl'),
      audit: path.join(this.dir, 'audit', 'audit.jsonl'),
      approvals: path.join(this.dir, 'approvals'),
      escalations: path.join(this.dir, 'escalations'),
    };
  }

  init({ project_id = 'clubOrchestra-lab', repo = 'clubOrchestra-lab', branch = 'main', base_sha = ZERO_SHA } = {}) {
    for (const d of [this.dir, path.dirname(this.p.inbox), path.dirname(this.p.audit), this.p.approvals, this.p.escalations]) {
      fs.mkdirSync(d, { recursive: true });
    }
    if (!fs.existsSync(this.p.state)) writeJsonAtomic(this.p.state, initialState({ project_id, repo, branch, base_sha }));
    if (!fs.existsSync(this.p.processed)) writeJsonAtomic(this.p.processed, { event_ids: [] });
    if (!fs.existsSync(this.p.inbox)) fs.writeFileSync(this.p.inbox, '');
    if (!fs.existsSync(this.p.audit)) fs.writeFileSync(this.p.audit, '');
    return this;
  }

  readState() {
    return readJson(this.p.state);
  }

  // ---- lease -------------------------------------------------------------------------------
  acquireLease(owner) {
    const body = JSON.stringify({ owner, expires_at: this.now() + this.leaseMs });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.p.lock, body, { flag: 'wx' }); // atomic create-or-fail
        return { ok: true };
      } catch (err) {
        // Windows reports EPERM/EACCES while another process's unlink of the lock is pending:
        // the lock is still in use, so treat it as held (fail closed).
        if (err.code === 'EPERM' || err.code === 'EACCES') return { ok: false, reason: 'LEASE_HELD', holder: 'unknown' };
        if (err.code !== 'EEXIST') throw err;
        let held = null;
        try { held = readJson(this.p.lock); } catch { /* unreadable lock: treat as held (fail closed) */ }
        const expired = held && typeof held.expires_at === 'number' && held.expires_at < this.now();
        if (!expired) return { ok: false, reason: 'LEASE_HELD', holder: held ? held.owner : 'unknown' };
        try { fs.unlinkSync(this.p.lock); } catch { /* someone else broke it first; retry once */ }
      }
    }
    return { ok: false, reason: 'LEASE_HELD', holder: 'unknown' };
  }

  releaseLease(owner) {
    try {
      const held = readJson(this.p.lock);
      if (held.owner === owner) fs.unlinkSync(this.p.lock);
    } catch { /* already gone */ }
  }

  // ---- optimistic commit -------------------------------------------------------------------
  // Writes nextState iff the stored version still equals expectedVersion. Exactly one of several
  // concurrent writers that read the same version can succeed; the rest get STALE_VERSION.
  commit(owner, expectedVersion, nextState, { processedEventId = null } = {}) {
    const lease = this.acquireLease(owner);
    if (!lease.ok) return lease;
    try {
      const current = this.readState();
      if (current.version !== expectedVersion) {
        return { ok: false, reason: 'STALE_VERSION', current_version: current.version };
      }
      const written = { ...nextState, version: expectedVersion + 1, lease_until: null };
      writeJsonAtomic(this.p.state, written);
      if (processedEventId !== null) this._addProcessed(processedEventId);
      return { ok: true, state: written };
    } finally {
      this.releaseLease(owner);
    }
  }

  // ---- idempotency -------------------------------------------------------------------------
  readProcessed() {
    return new Set(readJson(this.p.processed).event_ids);
  }

  _addProcessed(eventId) {
    const doc = readJson(this.p.processed);
    if (!doc.event_ids.includes(eventId)) doc.event_ids.push(eventId);
    writeJsonAtomic(this.p.processed, doc);
  }

  // ---- event intake (append-only JSONL) ----------------------------------------------------
  appendInbox(rawLine) {
    fs.appendFileSync(this.p.inbox, rawLine.replace(/\r?\n/g, ' ') + '\n');
  }

  readInbox() {
    return fs.readFileSync(this.p.inbox, 'utf8').split('\n').filter((l) => l.length > 0);
  }

  // ---- audit (append-only JSONL) -----------------------------------------------------------
  appendAudit(entry) {
    fs.appendFileSync(this.p.audit, JSON.stringify(entry) + '\n');
  }

  readAudit() {
    return fs.readFileSync(this.p.audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  // ---- approvals / escalations -------------------------------------------------------------
  approvalPath(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid approval id: ${id}`);
    return path.join(this.p.approvals, `${id}.json`);
  }

  readApproval(id) {
    try { return readJson(this.approvalPath(id)); } catch { return null; }
  }

  writeApproval(record) {
    writeJsonAtomic(this.approvalPath(record.approval_id), record);
  }

  writeEscalation(record) {
    if (!/^[A-Za-z0-9._-]+$/.test(record.escalation_id)) throw new Error('invalid escalation id');
    writeJsonAtomic(path.join(this.p.escalations, `${record.escalation_id}.json`), record);
  }

  listEscalations() {
    return fs.readdirSync(this.p.escalations).filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(this.p.escalations, f)));
  }
}

module.exports = { Store, ZERO_SHA, initialState };
