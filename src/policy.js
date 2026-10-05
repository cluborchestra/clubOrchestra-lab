'use strict';

// Control policy lives in code, never in event/handoff content (spec §4.11).
// Nothing a planner, worker or event payload says can change these values at runtime.
const POLICY = Object.freeze({
  schema_version: 1,
  breaker_threshold: 3,
  // Actions a task may carry. Anything else -> fail closed (BLOCKED).
  allowed_actions: Object.freeze(['implement', 'test', 'docs', 'deploy', 'enable_api_keys', 'spend']),
  // Actions that always require an approved approvals/<id>.json before dispatch.
  approval_required_actions: Object.freeze(['deploy', 'enable_api_keys', 'spend']),
  // Each task's work lives on branch <prefix><task_id>; CI results map back to tasks by branch.
  task_branch_prefix: 'co/',
  // Only workflow_run results from these workflows are turned into events.
  ci_workflows: Object.freeze(['CI']),
});

function taskBranch(taskId) {
  return `${POLICY.task_branch_prefix}${taskId}`;
}

module.exports = { POLICY, taskBranch };
