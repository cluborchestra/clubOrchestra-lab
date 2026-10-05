'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Loads and validates agent limits (config/agent-limits.json by default). Anything missing,
// malformed or out of range is an error (fail closed): agents never run on guessed limits.
//
// Modes: 'sim'    sim stubs only
//        'mock'   mock model client only (provider 'mock')
//        'replay' real API request/response shapes, served by a replay transport/runner (Lot 2)
//        'real'   live agents: refused until P3 Lot 3 is approved
const DEFAULT_LIMITS_PATH = path.join(__dirname, '..', '..', 'config', 'agent-limits.json');
const ALLOWED_MODES = Object.freeze(['sim', 'mock', 'replay']);
const ROLES = Object.freeze(['planner', 'worker']);
const FAKE_PRICING_NOTE = 'FAKE — not real pricing';

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

  const t = l.transport;
  if (!t || !Number.isSafeInteger(t.max_retries) || t.max_retries < 0 || t.max_retries > 5) errors.push('transport.max_retries must be an integer 0..5');
  if (!t || !nonNegative(t.max_retry_after_s) || t.max_retry_after_s > 300) errors.push('transport.max_retry_after_s must be 0..300');
  if (!t || !nonNegative(t.backoff_ms) || t.backoff_ms > 60000) errors.push('transport.backoff_ms must be 0..60000');
  const cc = l.claude_code;
  if (!cc || !posInt(cc.max_turns) || cc.max_turns > 50) errors.push('claude_code.max_turns must be an integer 1..50');
  if (!cc || !Array.isArray(cc.allowed_tools) || cc.allowed_tools.length === 0 || !cc.allowed_tools.every((x) => typeof x === 'string' && x.length > 0)) {
    errors.push('claude_code.allowed_tools must be a non-empty list of tool names');
  }

  // Prices: { input, output } USD per million tokens, or { reported_cost: true } for an agent that
  // reports its own cost (Claude Code headless: total_cost_usd). A model without an entry is refused.
  const p = l.pricing_usd_per_mtok;
  let nonMockPrices = false;
  if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push('pricing_usd_per_mtok must be an object');
  else for (const [model, price] of Object.entries(p)) {
    if (!model.startsWith('mock/')) nonMockPrices = true;
    const tokenPriced = price && nonNegative(price.input) && nonNegative(price.output);
    const reported = price && price.reported_cost === true && Object.keys(price).length === 1;
    if (!tokenPriced && !reported) errors.push(`pricing_usd_per_mtok.${model} needs input/output >= 0, or reported_cost: true`);
  }
  // Until real agents are approved, any non-mock price must be explicitly marked as fake.
  if (nonMockPrices && l.mode !== 'real' && l._PRICING_NOTE !== FAKE_PRICING_NOTE) {
    errors.push(`non-mock prices require "_PRICING_NOTE": "${FAKE_PRICING_NOTE}"`);
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

module.exports = { loadLimits, validateLimits, DEFAULT_LIMITS_PATH, ALLOWED_MODES, FAKE_PRICING_NOTE };
