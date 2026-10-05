'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('../store');
const { SpendBlockedError, LoopDetectedError } = require('./errors');

// Spend/rate guard for agent model calls. Every call goes:
//   check()  BEFORE the call: refuses (SpendBlockedError) if the provider is not enabled, the model
//            has no price, the task's call budget is used up, or the estimated cost would break the
//            per-call or daily cap. A permitted call is counted immediately, so a call that fails
//            half-way still counts.
//   record() AFTER the call: books the actual cost and, when asked (worker output), checks for a
//            loop: the same output for the same task seen loop_detect_repeats times -> LoopDetectedError.
// The ledger is a JSON file in the control-plane state dir, so limits hold across processes and
// orchestrator runs. It records counts, token usage, cost and output hashes, never prompts or outputs.
const MAX_ENTRIES = 200;

function today(nowIso) {
  return nowIso.slice(0, 10);
}

function outputHash(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

class SpendGuard {
  constructor({ limits, ledgerPath, now = () => new Date().toISOString() }) {
    if (!limits) throw new Error('SpendGuard requires limits');
    if (!ledgerPath) throw new Error('SpendGuard requires ledgerPath');
    this.limits = limits;
    this.ledgerPath = path.resolve(ledgerPath);
    this.now = now;
  }

  ledger() {
    let l;
    try { l = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT') throw err; // unreadable/corrupt ledger: fail closed
      l = { schema_version: 1, day: null, spent_usd_today: 0, spent_usd_total: 0, calls: {}, outputs: {}, entries: [] };
    }
    const d = today(this.now());
    if (l.day !== d) Object.assign(l, { day: d, spent_usd_today: 0 }); // daily cap resets; call budgets do not
    return l;
  }

  _save(l) {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    writeJsonAtomic(this.ledgerPath, l);
  }

  _price(provider, model) {
    const p = this.limits.pricing_usd_per_mtok[`${provider}/${model}`];
    return p || null;
  }

  // Returns the estimated cost; throws SpendBlockedError (nothing is called) if any limit would break.
  check({ role, key, provider, model, input_tokens, max_output_tokens }) {
    const block = (code, message) => { throw new SpendBlockedError(code, message, { role, key, provider, model }); };
    if (provider !== 'mock' && this.limits.mode !== 'real') block('REAL_AGENTS_DISABLED', `provider ${provider} not enabled (mode ${this.limits.mode})`);
    const price = this._price(provider, model);
    if (!price) block('PRICING_UNKNOWN', `no price configured for ${provider}/${model}`);
    const l = this.ledger();
    const callKey = `${role}:${key}`;
    const used = l.calls[callKey] || 0;
    const max = this.limits.max_calls_per_task[role];
    if (used >= max) block('MAX_CALLS_PER_TASK', `${callKey} already used ${used}/${max} calls`);
    const estimate = (input_tokens * price.input + max_output_tokens * price.output) / 1e6;
    if (estimate > this.limits.per_call_max_usd) block('PER_CALL_CAP', `estimated ${estimate.toFixed(6)} USD > per-call cap ${this.limits.per_call_max_usd}`);
    if (l.spent_usd_today + estimate > this.limits.daily_spend_cap_usd) {
      block('DAILY_SPEND_CAP', `spent ${l.spent_usd_today.toFixed(6)} + estimated ${estimate.toFixed(6)} USD > daily cap ${this.limits.daily_spend_cap_usd}`);
    }
    l.calls[callKey] = used + 1;
    this._save(l);
    return { estimate_usd: estimate, call_no: used + 1 };
  }

  record({ role, key, provider, model, usage, text, detectLoop = true }) {
    const price = this._price(provider, model);
    const cost = (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6;
    const l = this.ledger();
    const callKey = `${role}:${key}`;
    l.spent_usd_today += cost;
    l.spent_usd_total += cost;
    const h = outputHash(text);
    const seen = (l.outputs[callKey] = l.outputs[callKey] || []);
    seen.push(h);
    l.entries.push({ ts: this.now(), key: callKey, model: `${provider}/${model}`, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: cost, output_sha256: h });
    if (l.entries.length > MAX_ENTRIES) l.entries.splice(0, l.entries.length - MAX_ENTRIES);
    this._save(l);
    const repeats = seen.filter((x) => x === h).length;
    if (detectLoop && repeats >= this.limits.loop_detect_repeats) {
      throw new LoopDetectedError(`${callKey} produced the same output ${repeats} times`, { key: callKey, output_sha256: h, repeats });
    }
    return { cost_usd: cost };
  }
}

module.exports = { SpendGuard, outputHash };
