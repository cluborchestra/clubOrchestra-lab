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
});

module.exports = { POLICY };
