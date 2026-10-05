'use strict';

// The handoff schema (spec §4.6), shared by the control plane and every agent adapter.
// to-worker: what a planner emits. from-worker: what a worker returns. Unchanged since P1.
const { isPlainObject, SHA_RE } = require('./events');

const HANDOFF_REQUIRED = Object.freeze([
  'task_id', 'action', 'objective', 'why', 'repo', 'branch_policy', 'starting_sha', 'allowed_scope',
  'forbidden_scope', 'acceptance_criteria', 'required_tests', 'security_boundaries',
  'documentation_requirements', 'evidence_required', 'return_format',
]);

const WORKER_RESULT_FIELDS = Object.freeze([
  'task_id', 'outcome', 'starting_sha', 'ending_sha', 'files_changed', 'tests', 'ci',
  'docs_synced', 'risks', 'blockers', 'next_recommendation',
]);
const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'BLOCKED']);

// Copies only the named keys: anything else an agent adds is dropped, never acted on.
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function validateWorkerResult(r) {
  const errors = [];
  if (!isPlainObject(r)) return ['result is not an object'];
  for (const f of WORKER_RESULT_FIELDS) if (r[f] === undefined) errors.push(`missing field: ${f}`);
  if (errors.length) return errors;
  if (typeof r.task_id !== 'string') errors.push('task_id must be a string');
  if (!OUTCOMES.includes(r.outcome)) errors.push(`outcome must be one of ${OUTCOMES.join('|')}`);
  for (const f of ['starting_sha', 'ending_sha']) if (typeof r[f] !== 'string' || !SHA_RE.test(r[f])) errors.push(`${f} must be a 40-char sha`);
  for (const f of ['files_changed', 'tests', 'risks', 'blockers']) if (!Array.isArray(r[f])) errors.push(`${f} must be an array`);
  if (!isPlainObject(r.ci)) errors.push('ci must be an object');
  if (typeof r.docs_synced !== 'boolean') errors.push('docs_synced must be a boolean');
  if (typeof r.next_recommendation !== 'string') errors.push('next_recommendation must be a string');
  return errors;
}

module.exports = { HANDOFF_REQUIRED, WORKER_RESULT_FIELDS, OUTCOMES, pick, validateWorkerResult };
