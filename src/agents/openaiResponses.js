'use strict';

// Planner client for the OpenAI Responses API (POST /v1/responses, Structured Outputs).
// Zero-dependency: it builds the HTTP request itself and hands it to an INJECTED transport
//   transport(url, { method, headers, body }) -> { status, headers, body }   (synchronous)
// so this module never opens a socket, never reads an environment variable and never sees a key.
// In Lot 2 the transport is a replay transport (src/agents/replay.js, marked .replay = true).
// In Lot 3 a single live-transport file adds the Authorization header and does the I/O.
//
// Response handling (fail closed):
//   200 completed + output_text   -> text, usage
//   200 completed + refusal       -> billed; halt REFUSAL
//   200 incomplete (reason)       -> billed; halt INCOMPLETE_<REASON>
//   200 failed / other / unparsable -> halt
//   429                           -> wait retry-after (if <= max_retry_after_s) and retry, bounded
//   5xx, timeout/connection error -> backoff and retry, bounded; then halt UPSTREAM_UNAVAILABLE
//   other 4xx                     -> halt immediately (no retry)
const { AgentOutputError, AgentTransportError } = require('./errors');
const { SCHEMA_BY_PURPOSE } = require('./schemas');
const { isPlainObject } = require('../events');

const API_URL = 'https://api.openai.com/v1/responses';
const TRANSIENT_ERRORS = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'];

// Conservative token estimate for the pre-call spend check: ~3 bytes per token (JSON is token-dense),
// rounded up, plus a fixed allowance for message framing. Real usage replaces it after the call.
function estimateTokens(...parts) {
  const bytes = parts.reduce((n, p) => n + Buffer.byteLength(typeof p === 'string' ? p : JSON.stringify(p), 'utf8'), 0);
  return Math.ceil(bytes / 3) + 32;
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function header(headers, name) {
  if (!headers) return undefined;
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return k === undefined ? undefined : String(headers[k]);
}

function retryAfterMs(headers) {
  const ms = Number(header(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const s = header(headers, 'retry-after');
  if (s === undefined) return null;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null; // HTTP-date form: treated as unknown -> no retry
}

class OpenAIResponsesClient {
  constructor({ transport, model, limits, sleep = sleepSync, url = API_URL }) {
    if (typeof transport !== 'function') throw new TypeError('transport must be a function');
    if (typeof model !== 'string' || !model) throw new TypeError('model is required');
    Object.assign(this, { transport, model, limits, sleep, url, provider: 'openai', replay: transport.replay === true });
  }

  buildBody(request) {
    const fmt = SCHEMA_BY_PURPOSE[request.purpose];
    if (!fmt) throw new AgentOutputError(`openai: no schema for purpose ${request.purpose}`);
    return {
      model: this.model,
      instructions: request.system,
      input: JSON.stringify(request.input),
      max_output_tokens: request.max_output_tokens,
      store: false,
      metadata: { co_purpose: request.purpose, co_key: request.key },
      text: { format: { type: 'json_schema', name: fmt[0], strict: true, schema: fmt[1] } },
    };
  }

  buildRequest(request) {
    return {
      url: this.url,
      init: { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(this.buildBody(request)) },
    };
  }

  estimate(request) {
    return { input_tokens: estimateTokens(request.system, JSON.stringify(request.input)) };
  }

  complete(request) {
    const { url, init } = this.buildRequest(request);
    const t = this.limits.transport;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= t.max_retries;
      let res;
      try {
        res = this.transport(url, init);
      } catch (err) {
        if (!TRANSIENT_ERRORS.includes(err.code)) throw new AgentTransportError('TRANSPORT_ERROR', `openai: transport failed: ${err.code || err.message}`);
        if (last) throw new AgentTransportError('UPSTREAM_UNAVAILABLE', `openai: ${err.code} after ${attempt + 1} attempts`);
        this.sleep(t.backoff_ms * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        const wait = retryAfterMs(res.headers);
        if (wait === null || wait > t.max_retry_after_s * 1000) throw new AgentTransportError('RATE_LIMITED', `openai: 429, retry-after ${header(res.headers, 'retry-after')} exceeds ${t.max_retry_after_s}s or is missing`);
        if (last) throw new AgentTransportError('RATE_LIMITED', `openai: 429 after ${attempt + 1} attempts`);
        this.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        if (last) throw new AgentTransportError('UPSTREAM_UNAVAILABLE', `openai: HTTP ${res.status} after ${attempt + 1} attempts`);
        this.sleep(t.backoff_ms * 2 ** attempt);
        continue;
      }
      if (res.status !== 200) throw new AgentTransportError(`CLIENT_ERROR_${res.status}`, `openai: HTTP ${res.status} (not retried)`);
      return this._parse(res.body);
    }
  }

  // Maps a 200 body to { text, usage } or a billed { error }.
  _parse(bodyText) {
    let r;
    try { r = JSON.parse(bodyText); } catch { throw new AgentTransportError('BAD_RESPONSE', 'openai: response body is not JSON'); }
    if (!isPlainObject(r) || r.object !== 'response') throw new AgentTransportError('BAD_RESPONSE', 'openai: not a response object');
    const usage = isPlainObject(r.usage) ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens } : null;
    const billed = (code, message) => ({ text: null, usage, error: new AgentOutputError(`openai: ${message}`, {}, code) });
    const content = (Array.isArray(r.output) ? r.output : []).filter((o) => o && o.type === 'message').flatMap((o) => (Array.isArray(o.content) ? o.content : []));
    if (r.status === 'incomplete') {
      const reason = (r.incomplete_details && r.incomplete_details.reason) || 'unknown';
      return billed(`INCOMPLETE_${String(reason).toUpperCase()}`, `response incomplete (${reason})`);
    }
    if (r.status !== 'completed') return billed('UPSTREAM_FAILED', `response status ${r.status}${r.error ? `: ${r.error.code}` : ''}`);
    const refusal = content.find((c) => c.type === 'refusal');
    if (refusal) return billed('REFUSAL', `model refused: ${String(refusal.refusal).slice(0, 200)}`);
    const text = content.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    if (!text) return billed('EMPTY_OUTPUT', 'no output_text');
    return { text, usage };
  }
}

module.exports = { OpenAIResponsesClient, estimateTokens, retryAfterMs, API_URL };
