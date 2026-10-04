'use strict';

// Deterministic, offline planner stub (stands in for the OpenAI Responses API planner in P3).
// Emits canned to-worker handoffs (spec §4.6) from a fixed plan: the first task not yet completed.

const DEFAULT_PLAN = Object.freeze([
  { task_id: 'CO-SIM-001', action: 'implement', objective: 'Add greeting module' },
  { task_id: 'CO-SIM-002', action: 'test', objective: 'Add tests for greeting module' },
]);

class SimPlanner {
  constructor({ plan = DEFAULT_PLAN, repo = 'clubOrchestra-lab', extra = {} } = {}) {
    this.plan = plan;
    this.repo = repo;
    this.extra = extra; // lets tests inject arbitrary (untrusted) fields into handoffs
    this.calls = 0;
  }

  nextTask(view) {
    this.calls++;
    const step = this.plan.find((t) => !view.completed_tasks.includes(t.task_id));
    if (!step) return null;
    return {
      task_id: step.task_id,
      action: step.action,
      objective: step.objective,
      why: `Step ${this.plan.indexOf(step) + 1} of ${this.plan.length} of the simulated plan`,
      repo: this.repo,
      branch_policy: 'feature branch -> PR; no direct main commits',
      starting_sha: view.last_verified_sha,
      allowed_scope: ['sim workspace'],
      forbidden_scope: ['network', 'secrets', 'other repos'],
      acceptance_criteria: [`${step.objective} is done`],
      required_tests: ['unit'],
      security_boundaries: ['offline', 'no secrets'],
      documentation_requirements: ['CURRENT_STATUS updated'],
      evidence_required: ['test output', 'ending_sha'],
      return_format: 'from-worker v1',
      ...this.extra,
    };
  }
}

module.exports = { SimPlanner, DEFAULT_PLAN };
