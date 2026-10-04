'use strict';

const { Store } = require('./store');
const { POLICY } = require('./policy');
const { isLegalTransition, IllegalTransitionError } = require('./states');
const { validateEvent, verifyEvidence, isPlainObject } = require('./events');

const HANDOFF_REQUIRED = Object.freeze([
  'task_id', 'action', 'objective', 'why', 'repo', 'branch_policy', 'starting_sha', 'allowed_scope',
  'forbidden_scope', 'acceptance_criteria', 'required_tests', 'security_boundaries',
  'documentation_requirements', 'evidence_required', 'return_format',
]);
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
class ControlPlane {
  constructor({ dir, planner, worker, actor = 'control-plane', breakerThreshold = POLICY.breaker_threshold, now = () => new Date().toISOString(), leaseMs } = {}) {
    if (!dir) throw new Error('dir is required');
    this.store = new Store(dir, { leaseMs });
    this.planner = planner;
    this.worker = worker;
    this.actor = actor;
    this.breakerThreshold = breakerThreshold;
    this.now = now;
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
      Object.assign(s, { failure_count: 0, current_task_id: null, current_task: null, expected_sha: null, current_owner: null, next_safe_action: null });
    });
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
          Object.assign(s, { current_task_id: null, current_task: null, expected_sha: null, current_owner: 'planner' });
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
    const raw = this.planner.nextTask(view);
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
    });
    tx('WAITING_EVENT', { task_id: handoff.task_id, reason: `dispatched ${handoff.task_id} to worker` });
    note({ kind: 'task_dispatched', task_id: handoff.task_id, actor: this.actor, starting_sha: s.expected_sha });
    // Simulated async worker: it emits its result as an event into the intake.
    ctx.afterCommit.push(() => this.intake(this.worker.execute(clone(handoff))));
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

    if (ev.type !== 'task.completed') {
      note({ kind: 'event_ignored', event_id: ev.event_id, task_id: ev.task_id, actor: this.actor, reason: `type ${ev.type} not handled in P1` });
      return;
    }

    const check = verifyEvidence(ev, s);
    if (check.stale) {
      note({ kind: 'event_stale', event_id: ev.event_id, task_id: ev.task_id, actor: this.actor, reason: check.errors.join('; ') });
      return;
    }

    if (check.errors.length === 0) {
      s.completed_tasks.push(ev.task_id);
      Object.assign(s, {
        last_verified_sha: ev.sha, expected_sha: null, failure_count: 0,
        current_task_id: null, current_task: null, current_owner: 'planner', next_safe_action: 'plan next task',
      });
      tx('RUNNING', { event_id: ev.event_id, task_id: ev.task_id, reason: `evidence verified at ${ev.sha}` });
      return;
    }

    // Failure path + circuit breaker.
    s.failure_count += 1;
    tx('FAILED', { event_id: ev.event_id, task_id: ev.task_id, reason: `evidence rejected: ${check.errors.join('; ')}` });
    if (s.failure_count >= this.breakerThreshold) {
      const escalation = {
        escalation_id: `${ev.task_id}.breaker.${s.version + 1}`,
        task_id: ev.task_id, kind: 'circuit_breaker',
        reason: `${s.failure_count} consecutive failures (threshold ${this.breakerThreshold})`,
        last_errors: check.errors, last_event_id: ev.event_id,
        created_at: this.now(), status: 'open', assigned_to: 'human',
      };
      s.next_safe_action = `${NEEDS_HUMAN}: circuit breaker tripped, see escalations/${escalation.escalation_id}.json`;
      tx('BLOCKED', { event_id: ev.event_id, task_id: ev.task_id, reason: escalation.reason });
      note({ kind: 'escalation', event_id: ev.event_id, task_id: ev.task_id, actor: this.actor, escalation_id: escalation.escalation_id });
      ctx.afterCommit.push(() => this.store.writeEscalation(escalation));
    }
  }
}

module.exports = { ControlPlane, approvalIdFor, NEEDS_HUMAN };
