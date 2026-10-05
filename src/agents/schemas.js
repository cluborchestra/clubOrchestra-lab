'use strict';

// JSON Schemas for the planner's Structured Outputs (OpenAI Responses API, strict mode).
// They describe the existing handoff schema (src/handoff.js); our own validation still runs on
// every response, so the schemas constrain the model but are never trusted on their own.
const { HANDOFF_REQUIRED } = require('../handoff');

const STRING_FIELDS = ['task_id', 'action', 'objective', 'why', 'repo', 'branch_policy', 'starting_sha', 'return_format'];
const handoffProperties = Object.fromEntries(HANDOFF_REQUIRED.map((f) => [f,
  STRING_FIELDS.includes(f) ? { type: 'string' } : { type: 'array', items: { type: 'string' } }]));

const HANDOFF_SCHEMA = Object.freeze({
  type: 'object',
  properties: handoffProperties,
  required: [...HANDOFF_REQUIRED],
  additionalProperties: false,
});

// Escalation rule: every planned task carries an AUTO/OWNER classification (src/escalation.js).
const DECISION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    class: { type: 'string', enum: ['AUTO', 'OWNER'] },
    category: { anyOf: [{ type: 'string', enum: ['cost', 'scope', 'access', 'irreversible', 'security', 'uncertain'] }, { type: 'null' }] },
    reason: { type: 'string' },
  },
  required: ['class', 'category', 'reason'],
  additionalProperties: false,
});

const PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: { task: { anyOf: [HANDOFF_SCHEMA, { type: 'null' }] }, decision: { anyOf: [DECISION_SCHEMA, { type: 'null' }] } },
  required: ['task', 'decision'],
  additionalProperties: false,
});

const REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['ACCEPT', 'REJECT'] }, reason: { type: 'string' } },
  required: ['verdict', 'reason'],
  additionalProperties: false,
});

const SCHEMA_BY_PURPOSE = Object.freeze({ plan: ['co_plan', PLAN_SCHEMA], review: ['co_review', REVIEW_SCHEMA] });

module.exports = { HANDOFF_SCHEMA, DECISION_SCHEMA, PLAN_SCHEMA, REVIEW_SCHEMA, SCHEMA_BY_PURPOSE };
