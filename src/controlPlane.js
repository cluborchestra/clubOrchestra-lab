'use strict';

const { Store } = require('./store');
const { POLICY, taskBranch } = require('./policy');
const { isLegalTransition, IllegalTransitionError } = require('./states');
const { validateEvent, verifyEvidence, isPlainObject } = require('./events');
const { HANDOFF_REQUIRED } = require('./handoff');
const { assertPlannerAdapter, assertWorkerAdapter } = require('./agents/adapter');
const { AgentHaltError } = require('./agents/errors');
const ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NEEDS_HUMAN = 'NEEDS_HUMAN';

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function approvalIdFor(handoff) {
  return `${handoff.task_id}.${handoff.action}`;
}

// The control plane. Each step(): read state -> decide -> optimistic commit -> audit -> side effects.
// Decisions depend only on state + POLICY + validated envelope fields. Payload / handoff content is
// data: it is validated and compared, never used to pick a transition or bypass a gate.
//
// requireCi (P2): a verified worker result is not enough; the task completes only after a
// ci.completed event for that exact sha passes, the branch head (read from `repo`) still equals
// that sha, and the planner's review accepts it.
class ControlPlane {
  constructor({ dir, planner, worker, actor = 'control-plane', breakerThreshold = POLICY.breaker_threshold, now = () => new Date().toISOString(), leaseMs, requireCi = false, repo = null } = {}) {
    if (!dir) throw new Error('dir is required');
    this.store = new Store(dir, { leaseMs });
    this.planner = assertPlannerAdapter(planner);
    this.worker = assertWorkerAdapter(worker);
    this.actor = actor;
    this.breakerThreshold = breakerThreshold;
    this.now = now;
    this.requireCi = requireCi;
    this.repo = repo;
  }

  init(opts) {
    this.store.init(opts);
    return this;
  }

  state() {
    return this.store.readState();
  }

  // Event intake: append the raw (untrusted) event to the inbox. Never processed inline.
  intake(event) {
    this.store.appendInbox(typeof event === 'string' ? event : JSON.stringify(event));
  }

  audit(entry) {
    this.store.appendAudit({ ts: this.now(), actor: this.actor, event_id: null, task_id: null, ...entry });
  }

  // ---- generic transactional step -----------------------------------------------------------
  // fn(s, tx, ctx) mutates the draft state s; tx(to, info) performs a checked transition.
  _transact(fn) {
    const before = this.store.readState();
    const s = clone(before);
    const pendingAudit = [];
    const ctx = { afterCommit: [], processedEventId: null, result: { progressed: true, reason: null } };

    const tx = (to, info = {}) => {
      if (!isLegalTransition(s.status, to)) {
        this.audit({ kind: 'illegal_transition_rejected', from: s.status, to, task_id: s.current_task_id, event_id: info.event_id || null, actor: info.actor || this.actor, reason: info.reason || null });
        throw new IllegalTransitionError(s.status, to);
      }
      pendingAudit.push({
        kind: 'transition', from: s.status, to,
        event_id: info.event_id || null,
        task_id: info.task_id !== undefined ? info.task_id : s.current_task_id,
        actor: info.actor || this.actor,
        reason: info.reason || null,
      });
      s.status = to;
    };
    const note = (entry) => pendingAudit.push(entry);

    try {
      fn(s, tx, ctx, note);
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { progressed: false, reason: 'illegal_transition', error: err.message };
      throw err;
    }
    if (ctx.result.progressed === false && pendingAudit.length === 0 && ctx.processedEventId === null) return ctx.result;

    const r = this.store.commit(this.actor, before.version, s, { processedEventId: ctx.processedEventId });
    if (!r.ok) {
      this.audit({ kind: 'write_rejected', reason: r.reason, task_id: before.current_task_id });
      return { progressed: false, reason: r.reason };
    }
    for (const e of pendingAudit) this.audit(e);
    for (const f of ctx.afterCommit) f();
    return ctx.result;
  }

  // ---- public operations ----------------------------------------------------------------------
  start({ actor = 'human' } = {}) {
    return this._transact((s, tx) => {
      s.current_owner = 'planner';
      tx('RUNNING', { actor, reason: 'start' });
    });
  }

  // Direct transition request (used by humans / tests). Illegal ones are rejected and logged.
  transition(to, { actor = 'human', reason = null } = {}) {
    const r = this._transact((s, tx) => tx(to, { actor, reason }));
    if (r.reason === 'illegal_transition') throw new IllegalTransitionError(this.state().status, to);
    return r;
  }

  // Human-only recovery from BLOCKED back to IDLE.
  humanReset({ by }) {
    if (!by) throw new Error('humanReset requires `by`');
    return this._transact((s, tx) => {
      tx('IDLE', { actor: `human:${by}`, reason: 'human reset' });
      Object.assign(s, { failure_count: 0, current_task_id: null, current_task: null, expected_sha: null, current_owner: null, next_safe_action: null, awaiting: null, pending_ci_sha: null });
    });
  }

  // After a restart: compare durable state with the real repo (branch head) and resolve without
  // repeating work. Never re-dispatches a worker. Only acts once the durable inbox is drained.
  reconcile({ actor = 'reconciler' } = {}) {
    if (!this.repo) throw new Error('reconcile requires a repo (GitRefs)');
    const pending = this.store.readInbox().length - (this.state().inbox_cursor || 0);
    if (pending > 0) {
      this.audit({ kind: 'reconcile', actor, decision: 'inbox_pending', reason: `${pending} unprocessed event(s); run() first` });
      return { decision: 'inbox_pending' };
    }
    let decision = null;
    const r = this._transact((s, tx, ctx, note) => {
      const record = (d, reason, extra = {}) => {
        decision = d;
        note({ kind: 'reconcile', actor, task_id: s.current_task_id, decision: d, reason, ...extra });
      };
      if (s.status !== 'WAITING_EVENT') {
        record('nothing_to_reconcile', `status ${s.status} is resumed by step()`);
        return;
      }
      const head = this.repo.head(taskBranch(s.current_task_id));
      if (s.awaiting === 'ci') {
        if (head === s.pending_ci_sha) return record('consistent', `branch head is pending_ci_sha; waiting for CI`, { head });
        s.next_safe_action = `${NEEDS_HUMAN}: branch ${taskBranch(s.current_task_id)} is at ${head} but CI is pending for ${s.pending_ci_sha}`;
        record('branch_moved', 'branch head differs from the sha awaiting CI (unexpected writer)', { head });
        tx('BLOCKED', { actor, reason: 'reconcile: branch head moved while awaiting CI' });
        return;
      }
      // awaiting the worker
      if (head === null || head === s.expected_sha) {
        s.next_safe_action = `no commit on ${taskBranch(s.current_task_id)} yet; keep waiting (watchdog/human may re-dispatch)`;
        return record('no_commit_yet', 'worker has not committed; not re-dispatching');
      }
      // The worker committed but its result event was lost: adopt the commit and let CI judge it.
      Object.assign(s, { awaiting: 'ci', pending_ci_sha: head, next_safe_action: `await ci.completed for ${head}` });
      record('adopt_commit', 'worker commit found on task branch; awaiting CI on it instead of re-running the task', { head });
    });
    return { decision, ...r };
  }

  // Restart entry point: drain durable inbox, reconcile against the repo, continue.
  resume({ maxSteps } = {}) {
    this.run({ maxSteps });
    if (this.repo) this.reconcile();
    return this.run({ maxSteps });
  }

  run({ maxSteps = 100 } = {}) {
    const trace = [];
    for (let i = 0; i < maxSteps; i++) {
      const r = this.step();
      trace.push(r);
      if (!r.progressed) return { state: this.state(), steps: i + 1, stopped: r.reason, trace };
    }
    this.audit({ kind: 'max_steps_reached', reason: `stopped after ${maxSteps} steps` });
    return { state: this.state(), steps: maxSteps, stopped: 'max_steps', trace };
  }

  step() {
    return this._transact((s, tx, ctx, note) => {
      switch (s.status) {
        case 'RUNNING': return this._stepRunning(s, tx, ctx, note);
        case 'WAITING_APPROVAL': return this._stepWaitingApproval(s, tx, ctx, note);
        case 'WAITING_EVENT': return this._stepWaitingEvent(s, tx, ctx, note);
        case 'FAILED':
          // Retry the same task (planner re-issues it). Breaker already decided we may retry.
          Object.assign(s, { current_task_id: null, current_task: null, expected_sha: null, current_owner: 'planner', awaiting: null, pending_ci_sha: null });
          tx('RUNNING', { reason: `retry after failure ${s.failure_count}/${this.breakerThreshold}` });
          return undefined;
        default: // IDLE, BLOCKED, COMPLETE: nothing to do without a human
          ctx.result = { progressed: false, reason: s.status.toLowerCase() };
          return undefined;
      }
    });
  }

  // ---- RUNNING: ask planner, apply policy, dispatch or gate ----------------------------------
  _stepRunning(s, tx, ctx, note) {
    const view = Object.freeze({ completed_tasks: [...s.completed_tasks], last_verified_sha: s.last_verified_sha });
    let raw;
    try {
      raw = this.planner.nextTask(view);
    } catch (err) {
      if (err instanceof AgentHaltError) return this._halt(s, tx, ctx, note, err, { task_id: null, role: 'planner' });
      throw err;
    }
    if (raw === null) {
      Object.assign(s, { current_task_id: null, current_task: null, current_owner: null, next_safe_action: null });
      tx('COMPLETE', { task_id: null, reason: 'planner has no further tasks' });
      return;
    }
    const handoff = isPlainObject(raw) ? clone(raw) : raw;
    const problem = this._checkHandoff(handoff, s);
    if (problem) {
      s.next_safe_action = `${NEEDS_HUMAN}: ${problem}`;
      tx('BLOCKED', { task_id: isPlainObject(handoff) && typeof handoff.task_id === 'string' ? handoff.task_id : null, reason: `handoff rejected: ${problem}` });
      return;
    }

    // Approval requirement comes from POLICY by action, never from the handoff's own fields.
    if (POLICY.approval_required_actions.includes(handoff.action)) {
      const id = approvalIdFor(handoff);
      const approval = this.store.readApproval(id);
      const decision = this._approvalDecision(approval, handoff);
      if (decision === 'denied') {
        s.next_safe_action = `${NEEDS_HUMAN}: approval ${id} denied`;
        tx('BLOCKED', { task_id: handoff.task_id, reason: `approval ${id} denied` });
        return;
      }
      if (decision !== 'approved') {
        Object.assign(s, { current_task_id: handoff.task_id, current_task: handoff, current_owner: 'human', next_safe_action: `await approval ${id}` });
        tx('WAITING_APPROVAL', { task_id: handoff.task_id, reason: `action '${handoff.action}' requires approval ${id}` });
        if (!approval) {
          const record = {
            approval_id: id, task_id: handoff.task_id, action: handoff.action,
            reason: `Policy requires approval for action '${handoff.action}'`,
            requested_at: this.now(), requested_by: 'planner',
            status: 'pending', approved_by: null, approved_at: null,
          };
          ctx.afterCommit.push(() => this.store.writeApproval(record));
          note({ kind: 'approval_requested', approval_id: id, task_id: handoff.task_id, actor: this.actor });
        }
        return;
      }
    }

    this._dispatch(s, tx, ctx, note, handoff);
  }

  _checkHandoff(h, s) {
    if (!isPlainObject(h)) return 'handoff is not an object';
    for (const f of HANDOFF_REQUIRED) {
      if (h[f] === undefined || h[f] === null || h[f] === '') return `handoff missing field: ${f}`;
    }
    if (typeof h.task_id !== 'string' || !ID_RE.test(h.task_id)) return 'invalid task_id';
    if (!POLICY.allowed_actions.includes(h.action)) return `action not allowed by policy: ${String(h.action)}`;
    if (h.starting_sha !== s.last_verified_sha) return 'handoff starting_sha is not last_verified_sha (stale plan)';
    return null;
  }

  // Only an exact, well-formed approval counts. Anything else is "not approved" (fail closed).
  _approvalDecision(a, handoff) {
    if (!isPlainObject(a)) return 'pending';
    if (a.task_id !== handoff.task_id || a.action !== handoff.action) return 'pending';
    if (a.status === 'denied') return 'denied';
    if (a.status === 'approved' && typeof a.approved_by === 'string' && a.approved_by.length > 0) return 'approved';
    return 'pending';
  }

  _dispatch(s, tx, ctx, note, handoff) {
    Object.assign(s, {
      current_task_id: handoff.task_id, current_task: handoff, current_owner: 'worker',
      expected_sha: s.last_verified_sha, next_safe_action: `await task.completed for ${handoff.task_id}`,
      awaiting: 'worker', pending_ci_sha: null,
    });
    tx('WAITING_EVENT', { task_id: handoff.task_id, reason: `dispatched ${handoff.task_id} to worker` });
    note({ kind: 'task_dispatched', task_id: handoff.task_id, actor: this.actor, starting_sha: s.expected_sha });
    // The worker reports back through the intake. A worker may return its result event directly
    // (simulated) or nothing (the result arrives later as a separate event).
    ctx.afterCommit.push(() => {
      let ev;
      try {
        ev = this.worker.execute(clone(handoff));
      } catch (err) {
        if (!(err instanceof AgentHaltError)) throw err;
        // The dispatch is already committed; stop in a follow-up transaction (WAITING_EVENT -> BLOCKED).
        this._transact((s2, tx2, ctx2, note2) => this._halt(s2, tx2, ctx2, note2, err, { task_id: handoff.task_id, role: 'worker' }));
        return;
      }
      if (ev !== undefined && ev !== null) this.intake(ev);
    });
  }

  // ---- WAITING_APPROVAL ------------------------------------------------------------------------
  _stepWaitingApproval(s, tx, ctx) {
    const handoff = s.current_task;
    const id = approvalIdFor(handoff);
    const decision = this._approvalDecision(this.store.readApproval(id), handoff);
    if (decision === 'approved') {
      const a = this.store.readApproval(id);
      Object.assign(s, { current_task_id: null, current_task: null, current_owner: 'planner', next_safe_action: null });
      tx('RUNNING', { task_id: handoff.task_id, reason: `approval ${id} granted by ${a.approved_by}` });
    } else if (decision === 'denied') {
      s.next_safe_action = `${NEEDS_HUMAN}: approval ${id} denied`;
      tx('BLOCKED', { task_id: handoff.task_id, reason: `approval ${id} denied` });
    } else {
      ctx.result = { progressed: false, reason: 'awaiting_approval' };
    }
  }

  // ---- WAITING_EVENT: consume one inbox event ---------------------------------------------------
  _stepWaitingEvent(s, tx, ctx, note) {
    const lines = this.store.readInbox();
    if (s.inbox_cursor >= lines.length) {
      ctx.result = { progressed: false, reason: 'waiting_event' };
      return;
    }
    const line = lines[s.inbox_cursor];
    s.inbox_cursor += 1;

    let ev;
    try { ev = JSON.parse(line); } catch { ev = undefined; }
    const eventId = isPlainObject(ev) && typeof ev.event_id === 'string' && ev.event_id ? ev.event_id : null;
    const taskId = isPlainObject(ev) && typeof ev.task_id === 'string' ? ev.task_id : null;

    // Idempotency: an event_id seen before is a no-op (only the cursor moves).
    if (eventId && this.store.readProcessed().has(eventId)) {
      note({ kind: 'duplicate_event_ignored', event_id: eventId, task_id: taskId, actor: this.actor });
      return;
    }
    if (eventId) ctx.processedEventId = eventId;

    // Fail closed on anything that does not validate.
    const v = ev === undefined ? { ok: false, errors: ['unparseable JSON'] } : validateEvent(ev, { project_id: s.project_id });
    if (!v.ok) {
      note({ kind: 'event_rejected', event_id: eventId, task_id: taskId, actor: this.actor, errors: v.errors });
      s.next_safe_action = `${NEEDS_HUMAN}: invalid event (${v.errors.join('; ')})`;
      tx('BLOCKED', { event_id: eventId, reason: 'invalid event envelope (fail closed)' });
      return;
    }
    s.last_event_id = ev.event_id;

    if (ev.type === 'task.completed') return this._onWorkerResult(s, tx, ctx, note, ev);
    if (ev.type === 'ci.completed' && this.requireCi) return this._onCiResult(s, tx, ctx, note, ev);
    note({ kind: 'event_ignored', event_id: ev.event_id, task_id: ev.task_id, actor: this.actor, reason: `type ${ev.type} not handled in this mode` });
  }

  _stale(note, ev, reason) {
    note({ kind: 'event_stale', event_id: ev.event_id, task_id: ev.task_id, actor: this.actor, reason });
  }

  _onWorkerResult(s, tx, ctx, note, ev) {
    if (this.requireCi && s.awaiting !== 'worker') return this._stale(note, ev, 'not awaiting a worker result');
    const check = verifyEvidence(ev, s);
    if (check.stale) return this._stale(note, ev, check.errors.join('; '));
    if (check.errors.length > 0) return this._fail(s, tx, ctx, note, ev, check.errors);
    if (!this.requireCi) return this._completeTask(s, tx, ev, `evidence verified at ${ev.sha}`);
    // P2: worker evidence is necessary but not sufficient; wait for CI on this exact sha.
    Object.assign(s, { awaiting: 'ci', pending_ci_sha: ev.sha, next_safe_action: `await ci.completed for ${ev.sha}` });
    note({ kind: 'worker_evidence_accepted', event_id: ev.event_id, task_id: ev.task_id, actor: this.actor, sha: ev.sha, reason: 'awaiting CI on exact sha' });
  }

  _onCiResult(s, tx, ctx, note, ev) {
    if (s.awaiting !== 'ci') return this._stale(note, ev, 'not awaiting a CI result');
    if (ev.task_id !== s.current_task_id) return this._stale(note, ev, 'task_id is not the current task');
    // Exact-SHA gate: CI must be for the very commit we are waiting on ...
    if (ev.sha !== s.pending_ci_sha) return this._stale(note, ev, `sha ${ev.sha} is not pending_ci_sha ${s.pending_ci_sha}`);
    // ... and that commit must still be the branch head in the real repo.
    if (this.repo) {
      const head = this.repo.head(taskBranch(s.current_task_id));
      if (head === null) {
        s.next_safe_action = `${NEEDS_HUMAN}: cannot read head of ${taskBranch(s.current_task_id)}`;
        tx('BLOCKED', { event_id: ev.event_id, task_id: ev.task_id, reason: 'branch head unreadable (fail closed)' });
        return;
      }
      if (head !== ev.sha) return this._stale(note, ev, `branch head moved to ${head}`);
    }
    if (ev.status !== 'success') return this._fail(s, tx, ctx, note, ev, ['CI did not succeed']);
    let rejection;
    try {
      rejection = this._plannerReview(ev);
    } catch (err) {
      if (err instanceof AgentHaltError) return this._halt(s, tx, ctx, note, err, { task_id: ev.task_id, event_id: ev.event_id, role: 'planner' });
      throw err;
    }
    if (rejection) return this._fail(s, tx, ctx, note, ev, [`planner review: ${rejection}`]);
    note({ kind: 'planner_review', event_id: ev.event_id, task_id: ev.task_id, actor: 'planner', verdict: 'ACCEPT' });
    this._completeTask(s, tx, ev, `CI passed and planner accepted at ${ev.sha}`);
  }

  // Planner evaluates evidence (spec §4.6). Only an exact { verdict: 'ACCEPT' } accepts.
  _plannerReview(ev) {
    if (typeof this.planner.review !== 'function') return 'planner has no review()';
    let out;
    try {
      out = this.planner.review(Object.freeze(clone({ task_id: ev.task_id, sha: ev.sha, ci_status: ev.status, evidence_refs: ev.evidence_refs || [] })));
    } catch (err) {
      if (err instanceof AgentHaltError) throw err; // spend/loop/output halts stop the loop, not retry it
      return `review threw: ${err.message}`;
    }
    return isPlainObject(out) && out.verdict === 'ACCEPT' ? null : `verdict ${isPlainObject(out) ? String(out.verdict) : 'missing'}`;
  }

  _completeTask(s, tx, ev, reason) {
    s.completed_tasks.push(ev.task_id);
    Object.assign(s, {
      last_verified_sha: ev.sha, expected_sha: null, failure_count: 0, awaiting: null, pending_ci_sha: null,
      current_task_id: null, current_task: null, current_owner: 'planner', next_safe_action: 'plan next task',
    });
    tx('RUNNING', { event_id: ev.event_id, task_id: ev.task_id, reason });
  }

  // Failure path + circuit breaker.
  _fail(s, tx, ctx, note, ev, errors) {
    s.failure_count += 1;
    Object.assign(s, { awaiting: null, pending_ci_sha: null });
    tx('FAILED', { event_id: ev.event_id, task_id: ev.task_id, reason: `evidence rejected: ${errors.join('; ')}` });
    if (s.failure_count >= this.breakerThreshold) {
      this._escalate(s, tx, ctx, note, {
        tag: 'breaker', kind: 'circuit_breaker', task_id: ev.task_id, event_id: ev.event_id,
        reason: `${s.failure_count} consecutive failures (threshold ${this.breakerThreshold})`,
        errors, headline: 'circuit breaker tripped',
      });
    }
  }

  // An agent adapter refused to continue (spend/rate limit, loop, invalid output): fail closed.
  // A detected loop also trips the circuit breaker (failure_count raised to the threshold).
  _halt(s, tx, ctx, note, err, { task_id, event_id = null, role }) {
    if (err.kind === 'loop_detected') s.failure_count = Math.max(s.failure_count + 1, this.breakerThreshold);
    Object.assign(s, { awaiting: null, pending_ci_sha: null });
    this._escalate(s, tx, ctx, note, {
      tag: err.kind === 'loop_detected' ? 'loop' : err.kind === 'spend_guard' ? 'spend' : 'agent',
      kind: err.kind, task_id, event_id,
      reason: `${role} halted: ${err.code}: ${err.message}`,
      errors: [err.message], headline: `${role} halted (${err.code})`, code: err.code,
    });
  }

  _escalate(s, tx, ctx, note, { tag, kind, task_id, event_id, reason, errors, headline, code }) {
    const escalation = {
      escalation_id: `${task_id || 'planner'}.${tag}.${s.version + 1}`,
      task_id, kind, ...(code ? { code } : {}),
      reason, last_errors: errors, last_event_id: event_id,
      created_at: this.now(), status: 'open', assigned_to: 'human',
    };
    s.next_safe_action = `${NEEDS_HUMAN}: ${headline}, see escalations/${escalation.escalation_id}.json`;
    tx('BLOCKED', { event_id, task_id, reason });
    note({ kind: 'escalation', event_id, task_id, actor: this.actor, escalation_id: escalation.escalation_id });
    ctx.afterCommit.push(() => this.store.writeEscalation(escalation));
  }
}

module.exports = { ControlPlane, approvalIdFor, NEEDS_HUMAN };
