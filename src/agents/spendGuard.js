'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('../store');
const { withFileLock } = require('../fileLock');
const { SpendBlockedError, LoopDetectedError } = require('./errors');

// Spend/rate guard for agent model calls. Every call goes:
//   check()  BEFORE the call, under a ledger lock. Refuses (SpendBlockedError, nothing is called) if:
//            - the provider is not enabled for the mode (replay: replay transport only;
//              local-subscription: subscription-priced models only);
//            - the model has no price;
//            - the task's call budget is used up;
//            - the estimate breaks the per-call cap;
//            - spent + estimate breaks the daily cap.
//            A permitted call is counted and its estimate RESERVED in spent_usd_today immediately.
//            So concurrent callers can never jointly overshoot the cap, and a call that fails
//            half-way stays booked at its estimate.
//   record() AFTER the call: replaces the reservation with the actual cost. The actual cost is
//            usage x price, or the cost the agent reported (total_cost_usd). If neither is
//            available it keeps the reservation and halts (COST_UNKNOWN). For worker output it also
//            runs the loop detector: the same output for the same task seen loop_detect_repeats
//            times -> LoopDetectedError.
//   fail()   the call errored (transport/HTTP): the reservation is kept (conservative) and noted.
// The day is the UTC calendar day; the daily cap resets at 00:00 UTC. Call budgets do not reset.
// The ledger is a JSON file in the control-plane state dir (on GitHub: orchestra-state, committed by
// the orchestrator), so limits hold across processes and Actions runs. It records counts, tokens,
// cost and output hashes, never prompts or outputs.
const MAX_ENTRIES = 200;

function utcDay(nowIso) {
  return new Date(nowIso).toISOString().slice(0, 10);
}

function outputHash(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

const isCost = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round = (v) => Math.round(v * 1e9) / 1e9;

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
    const d = utcDay(this.now());
    if (l.day !== d) Object.assign(l, { day: d, spent_usd_today: 0 });
    return l;
  }

  _locked(fn) {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const r = withFileLock(`${this.ledgerPath}.lock`, {}, () => {
      const l = this.ledger();
      const out = fn(l);
      writeJsonAtomic(this.ledgerPath, l);
      return out;
    });
    if (!r.ok) throw new SpendBlockedError('LEDGER_BUSY', 'could not lock the spend ledger', { ledger: this.ledgerPath });
    return r.value;
  }

  _price(provider, model) {
    return this.limits.pricing_usd_per_mtok[`${provider}/${model}`] || null;
  }

  // Returns a ticket for record()/fail(); throws SpendBlockedError (nothing is called) if any limit would break.
  check({ role, key, provider, model, input_tokens = 0, max_output_tokens = 0, estimate_usd, replay = false }) {
    const block = (code, message) => { throw new SpendBlockedError(code, message, { role, key, provider, model }); };
    const price = this._price(provider, model);
    if (provider !== 'mock') {
      if (this.limits.mode === 'replay') {
        if (replay !== true) block('REAL_AGENTS_DISABLED', `mode replay requires a replay transport (provider ${provider})`);
      } else if (this.limits.mode === 'local-subscription') {
        // Free path: a live CLI, but only on a flat-rate subscription entry (never a paid price).
        if (!price || price.subscription !== true) block('REAL_AGENTS_DISABLED', `mode local-subscription allows only subscription models (${provider}/${model})`);
      } else block('REAL_AGENTS_DISABLED', `provider ${provider} not enabled (mode ${this.limits.mode})`);
    }
    if (!price) block('PRICING_UNKNOWN', `no price configured for ${provider}/${model}`);
    let estimate = estimate_usd;
    if (!isCost(estimate)) {
      estimate = price.subscription ? 0
        : price.reported_cost ? this.limits.per_call_max_usd
          : (input_tokens * price.input + max_output_tokens * price.output) / 1e6;
    }
    if (estimate > this.limits.per_call_max_usd) block('PER_CALL_CAP', `estimated ${estimate.toFixed(6)} USD > per-call cap ${this.limits.per_call_max_usd}`);
    const callKey = `${role}:${key}`;
    return this._locked((l) => {
      const used = l.calls[callKey] || 0;
      const max = this.limits.max_calls_per_task[role];
      if (used >= max) block('MAX_CALLS_PER_TASK', `${callKey} already used ${used}/${max} calls`);
      if (l.spent_usd_today + estimate > this.limits.daily_spend_cap_usd + 1e-12) {
        block('DAILY_SPEND_CAP', `spent ${l.spent_usd_today.toFixed(6)} + estimated ${estimate.toFixed(6)} USD > daily cap ${this.limits.daily_spend_cap_usd}`);
      }
      l.calls[callKey] = used + 1;
      l.spent_usd_today = round(l.spent_usd_today + estimate);
      return { call_no: used + 1, reserved_usd: estimate, day: l.day, callKey, provider, model, estimate_usd: estimate };
    });
  }

  // Books the actual cost of a completed call. `cost_usd` is the agent-reported cost (used when the
  // model is priced as reported_cost); otherwise cost = usage x price.
  record(ticket, { usage, cost_usd, text, detectLoop = true }) {
    const price = this._price(ticket.provider, ticket.model);
    let actual = null;
    if (price.subscription) actual = 0; // flat-rate plan: no per-call cost (the call is still counted)
    else if (price.reported_cost) actual = isCost(cost_usd) ? cost_usd : null;
    else if (usage && isCost(usage.input_tokens) && isCost(usage.output_tokens)) actual = (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6;
    const h = text === null || text === undefined ? null : outputHash(text);
    const repeats = this._locked((l) => {
      const entry = {
        ts: this.now(), key: ticket.callKey, model: `${ticket.provider}/${ticket.model}`,
        input_tokens: usage && isCost(usage.input_tokens) ? usage.input_tokens : null,
        output_tokens: usage && isCost(usage.output_tokens) ? usage.output_tokens : null,
        reserved_usd: ticket.reserved_usd, cost_usd: actual, output_sha256: h,
      };
      if (actual === null) {
        entry.note = 'COST_UNKNOWN: reservation kept';
        this._push(l, entry);
        return null;
      }
      const reserved = ticket.day === l.day ? ticket.reserved_usd : 0; // a reservation from yesterday is gone with yesterday
      l.spent_usd_today = round(Math.max(0, l.spent_usd_today - reserved + actual));
      l.spent_usd_total = round(l.spent_usd_total + actual);
      this._push(l, entry);
      if (h === null) return 0;
      const seen = (l.outputs[ticket.callKey] = l.outputs[ticket.callKey] || []);
      seen.push(h);
      return seen.filter((x) => x === h).length;
    });
    if (repeats === null) {
      throw new SpendBlockedError('COST_UNKNOWN', `${ticket.callKey}: cost could not be established (no usage/price or reported cost); reservation ${ticket.reserved_usd} USD kept`, { key: ticket.callKey });
    }
    if (detectLoop && repeats >= this.limits.loop_detect_repeats) {
      throw new LoopDetectedError(`${ticket.callKey} produced the same output ${repeats} times`, { key: ticket.callKey, output_sha256: h, repeats });
    }
    return { cost_usd: actual };
  }

  // The call failed before producing a usable response; the reservation stays booked.
  fail(ticket, code) {
    this._locked((l) => this._push(l, { ts: this.now(), key: ticket.callKey, model: `${ticket.provider}/${ticket.model}`, reserved_usd: ticket.reserved_usd, cost_usd: null, note: `FAILED ${code}: reservation kept` }));
  }

  _push(l, entry) {
    l.entries.push(entry);
    if (l.entries.length > MAX_ENTRIES) l.entries.splice(0, l.entries.length - MAX_ENTRIES);
  }
}

module.exports = { SpendGuard, outputHash, utcDay };
