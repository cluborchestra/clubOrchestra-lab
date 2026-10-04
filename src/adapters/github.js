'use strict';

// Maps a GitHub `workflow_run` webhook payload into the P1 event envelope (type ci.completed).
// The GitHub payload is UNTRUSTED. The adapter only copies/derives envelope fields; it never
// decides anything. Missing or malformed fields are left out, so the control plane's envelope
// validation rejects the event and fails closed.
//
// event_id = gh-run-<run.id>-<run.run_attempt>: GitHub redelivering the same webhook yields the
// same event_id (-> duplicate no-op). A deliberate re-run gets a new run_attempt -> a new event.
const { POLICY } = require('../policy');
const { isPlainObject } = require('../events');

const TASK_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

function posInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function taskIdFromBranch(branch) {
  if (typeof branch !== 'string' || !branch.startsWith(POLICY.task_branch_prefix)) return undefined;
  const id = branch.slice(POLICY.task_branch_prefix.length);
  return TASK_ID_RE.test(id) ? id : undefined;
}

// Returns { ignored: true, reason } for deliveries that are not ours to handle,
// otherwise { event } (which may be incomplete -> rejected downstream).
function workflowRunToEvent(gh, { project_id, repo_full_name = null, workflows = POLICY.ci_workflows }) {
  if (!isPlainObject(gh) || !isPlainObject(gh.workflow_run)) {
    return { event: { schema_version: 1, type: 'ci.completed', producer: 'github', project_id } };
  }
  const run = gh.workflow_run;
  if (gh.action !== 'completed') return { ignored: true, reason: `action ${String(gh.action)} is not completed` };
  if (!workflows.includes(run.name)) return { ignored: true, reason: `workflow ${String(run.name)} is not a CI workflow` };
  const fullName = isPlainObject(gh.repository) ? gh.repository.full_name : undefined;
  if (repo_full_name !== null && fullName !== repo_full_name) return { ignored: true, reason: 'foreign repository' };

  const event = {
    schema_version: 1,
    event_id: posInt(run.id) && posInt(run.run_attempt) ? `gh-run-${run.id}-${run.run_attempt}` : undefined,
    type: 'ci.completed',
    created_at: run.updated_at,
    producer: 'github',
    project_id, // from our config, never from the payload
    repo: fullName,
    branch: run.head_branch,
    sha: run.head_sha,
    task_id: taskIdFromBranch(run.head_branch),
    // Anything but an explicit "success" conclusion is a failure (fail closed).
    status: run.conclusion === 'success' ? 'success' : 'failure',
    payload: {
      source: 'github.workflow_run',
      workflow: run.name,
      run_id: run.id,
      run_attempt: run.run_attempt,
      conclusion: run.conclusion === undefined ? null : run.conclusion,
    },
    evidence_refs: posInt(run.id) ? [`github-run:${run.id}/attempt-${run.run_attempt}`] : [],
  };
  for (const k of Object.keys(event)) if (event[k] === undefined) delete event[k];
  return { event };
}

module.exports = { workflowRunToEvent, taskIdFromBranch };
