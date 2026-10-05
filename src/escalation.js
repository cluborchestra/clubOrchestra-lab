'use strict';

// Escalation rule (project purpose): every dispatch decision is AUTO or OWNER.
//   OWNER (goes to the owner, Ási): cost, scope changes, access/actions agents cannot take,
//   irreversible actions, security/keys, and ANYTHING uncertain (fail closed).
//   AUTO (white noise, handled without the owner): code fixes, tests, retries, CI failures,
//   refactors within scope.
//
// Two sources, and the stricter one wins:
//   1. policy floor (code, not the planner): some actions are always OWNER;
//   2. the planner's classification of the task.
// A planner can raise AUTO to OWNER, never lower a policy OWNER to AUTO. A classification that is
// missing, malformed or uses an unknown class/category becomes OWNER / 'uncertain'.
const { POLICY } = require('./policy');
const { isPlainObject } = require('./events');

const CLASSES = Object.freeze(['AUTO', 'OWNER']);
const OWNER_CATEGORIES = Object.freeze(['cost', 'scope', 'access', 'irreversible', 'security', 'uncertain']);

// Policy floor: action -> owner category. Mirrors POLICY.approval_required_actions.
const POLICY_OWNER_ACTIONS = Object.freeze({ spend: 'cost', enable_api_keys: 'security', deploy: 'irreversible' });

function policyFloor(handoff) {
  if (!POLICY.approval_required_actions.includes(handoff.action)) return null;
  const category = POLICY_OWNER_ACTIONS[handoff.action] || 'uncertain';
  return { class: 'OWNER', category, reason: `policy: action '${handoff.action}' always needs the owner`, decided_by: 'policy' };
}

// Normalises whatever the planner said into a decision; anything not clearly valid -> OWNER/uncertain.
function plannerDecision(raw) {
  const uncertain = (why) => ({ class: 'OWNER', category: 'uncertain', reason: `unclassifiable planner decision: ${why}`, decided_by: 'fail-closed' });
  if (!isPlainObject(raw)) return uncertain('missing');
  if (!CLASSES.includes(raw.class)) return uncertain(`class ${JSON.stringify(raw.class)}`);
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '';
  if (raw.class === 'AUTO') return { class: 'AUTO', category: null, reason, decided_by: 'planner' };
  if (!OWNER_CATEGORIES.includes(raw.category)) return uncertain(`OWNER with category ${JSON.stringify(raw.category)}`);
  return { class: 'OWNER', category: raw.category, reason, decided_by: 'planner' };
}

function decide(handoff, rawPlannerDecision) {
  const floor = policyFloor(handoff);
  const planner = plannerDecision(rawPlannerDecision);
  if (floor) return planner.class === 'OWNER' && planner.decided_by === 'planner' ? { ...floor, reason: `${floor.reason}; planner: ${planner.category}: ${planner.reason}` } : floor;
  return planner;
}

module.exports = { decide, policyFloor, plannerDecision, CLASSES, OWNER_CATEGORIES, POLICY_OWNER_ACTIONS };
