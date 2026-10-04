'use strict';

// Event envelope validation (spec §4.5). Anything that does not validate is rejected and the
// control plane fails closed. Payload is opaque, untrusted data: it is never interpreted here.
const EVENT_TYPES = Object.freeze(['task.ready', 'task.completed', 'ci.completed', 'approval.required']);
const PRODUCERS = Object.freeze(['github', 'planner', 'worker']);
const EVENT_STATUSES = Object.freeze(['success', 'failure']);
const REQUIRED_FIELDS = Object.freeze([
  'schema_version', 'event_id', 'type', 'created_at', 'producer', 'project_id',
  'repo', 'branch', 'sha', 'task_id', 'status',
]);
const SHA_RE = /^[0-9a-f]{40}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateEvent(ev, { project_id }) {
  const errors = [];
  if (!isPlainObject(ev)) return { ok: false, errors: ['event is not an object'] };

  for (const f of REQUIRED_FIELDS) {
    if (ev[f] === undefined || ev[f] === null || ev[f] === '') errors.push(`missing required field: ${f}`);
  }
  if (errors.length) return { ok: false, errors };

  if (ev.schema_version !== 1) errors.push('unsupported schema_version');
  if (typeof ev.event_id !== 'string') errors.push('event_id must be a string');
  if (!EVENT_TYPES.includes(ev.type)) errors.push(`unknown type: ${String(ev.type)}`);
  if (!PRODUCERS.includes(ev.producer)) errors.push(`unknown producer: ${String(ev.producer)}`);
  if (!EVENT_STATUSES.includes(ev.status)) errors.push(`unknown status: ${String(ev.status)}`);
  if (ev.project_id !== project_id) errors.push('project_id mismatch');
  if (typeof ev.sha !== 'string' || !SHA_RE.test(ev.sha)) errors.push('sha must be a 40-char lowercase hex string');
  if (typeof ev.task_id !== 'string') errors.push('task_id must be a string');
  if (typeof ev.created_at !== 'string' || Number.isNaN(Date.parse(ev.created_at))) errors.push('created_at must be an ISO timestamp');
  if (ev.payload !== undefined && !isPlainObject(ev.payload)) errors.push('payload must be an object');
  if (ev.evidence_refs !== undefined && !Array.isArray(ev.evidence_refs)) errors.push('evidence_refs must be an array');

  return { ok: errors.length === 0, errors };
}

// Checks a worker result (from-worker handoff, spec §4.6) against what the control plane itself
// expects. The payload is only compared against control-plane-held values; it never steers flow.
// Returns { stale, errors }: stale = event is not about the current dispatch (no work, no failure).
function verifyEvidence(ev, state) {
  const r = isPlainObject(ev.payload) ? ev.payload : {};
  if (ev.task_id !== state.current_task_id) return { stale: true, errors: ['task_id is not the current task'] };
  if (r.starting_sha !== state.expected_sha) return { stale: true, errors: ['starting_sha does not match expected_sha'] };

  const errors = [];
  if (ev.status !== 'success') errors.push(`event status is ${ev.status}`);
  if (r.task_id !== ev.task_id) errors.push('result.task_id does not match event.task_id');
  if (r.outcome !== 'PASS') errors.push(`outcome is ${String(r.outcome)}`);
  if (typeof r.ending_sha !== 'string' || !SHA_RE.test(r.ending_sha)) errors.push('ending_sha invalid');
  else if (r.ending_sha !== ev.sha) errors.push('ending_sha does not match event.sha (exact-SHA check)');
  if (r.ending_sha === state.expected_sha) errors.push('ending_sha equals starting_sha (no change)');
  if (!Array.isArray(r.tests) || r.tests.length === 0) errors.push('no test evidence');
  else if (!r.tests.every((t) => isPlainObject(t) && t.status === 'pass')) errors.push('not all tests pass');
  if (r.docs_synced !== true) errors.push('docs_synced is not true');
  return { stale: false, errors };
}

module.exports = { EVENT_TYPES, PRODUCERS, REQUIRED_FIELDS, SHA_RE, validateEvent, verifyEvidence, isPlainObject };
