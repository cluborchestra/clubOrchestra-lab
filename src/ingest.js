'use strict';

const { workflowRunToEvent } = require('./adapters/github');

// GitHub workflow_run delivery -> adapter -> control-plane intake. Shared by the CLI `ingest`
// command (what the orchestrator workflow runs) and the local harness.
function ingestWorkflowRun(cp, gh, { repo_full_name = null } = {}) {
  const out = workflowRunToEvent(gh, { project_id: cp.state().project_id, repo_full_name });
  if (out.ignored) {
    cp.audit({ kind: 'ingest_ignored', actor: 'github-adapter', reason: out.reason });
    return out;
  }
  cp.intake(out.event);
  return out;
}

module.exports = { ingestWorkflowRun };
