'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Loads and validates config/agent-limits.json. Anything missing, malformed or out of range is an
// error (fail closed): agents never run on guessed limits.
const DEFAULT_LIMITS_PATH = path.join(__dirname, '..', '..', 'config', 'agent-limits.json');
const ALLOWED_MODES = Object.freeze(['sim', 'mock']); // 'real' arrives with P3 Lot 3 approval
const ROLES = Object.freeze(['planner', 'worker']);

const nonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const posInt = (v) => Number.isSafeInteger(v) && v >= 1;

function validateLimits(l) {
  const errors = [];
  if (!l || typeof l !== 'object' || Array.isArray(l)) return ['limits must be an object'];
  if (l.schema_version !== 1) errors.push('schema_version must be 1');
  if (!ALLOWED_MODES.includes(l.mode)) errors.push(`mode must be one of ${ALLOWED_MODES.join('|')} (real agents are not enabled)`);
  for (const key of ['max_calls_per_task', 'max_output_tokens']) {
    for (const role of ROLES) if (!posInt(l[key] && l[key][role])) errors.push(`${key}.${role} must be an integer >= 1`);
  }
  if (!Number.isSafeInteger(l.loop_detect_repeats) || l.loop_detect_repeats < 2) errors.push('loop_detect_repeats must be an integer >= 2');
  if (!nonNegative(l.daily_spend_cap_usd)) errors.push('daily_spend_cap_usd must be a number >= 0');
  if (!nonNegative(l.per_call_max_usd)) errors.push('per_call_max_usd must be a number >= 0');
  const p = l.pricing_usd_per_mtok;
  if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push('pricing_usd_per_mtok must be an object');
  else for (const [model, price] of Object.entries(p)) {
    if (!price || !nonNegative(price.input) || !nonNegative(price.output)) errors.push(`pricing_usd_per_mtok.${model} needs input/output >= 0`);
  }
  return errors;
}

function loadLimits(file = DEFAULT_LIMITS_PATH) {
  const limits = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateLimits(limits);
  if (errors.length) throw new Error(`invalid agent limits (${file}): ${errors.join('; ')}`);
  return deepFreeze(limits);
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

module.exports = { loadLimits, validateLimits, DEFAULT_LIMITS_PATH, ALLOWED_MODES };
