'use strict';

// Errors an agent adapter raises to make the control plane stop (fail closed).
// The control plane turns any AgentHaltError into BLOCKED + an escalation record.
class AgentHaltError extends Error {
  constructor(kind, code, message, details = {}) {
    super(message);
    this.name = 'AgentHaltError';
    this.kind = kind; // escalation kind
    this.code = code; // machine-readable reason
    this.details = details;
  }
}

// A spend/rate limit would be exceeded, or the cost of a call cannot be established.
// Limits are checked BEFORE the model call is made.
class SpendBlockedError extends AgentHaltError {
  constructor(code, message, details) {
    super('spend_guard', code, message, details);
    this.name = 'SpendBlockedError';
  }
}

// The agent produced the same output again for the same task: retrying is not making progress.
class LoopDetectedError extends AgentHaltError {
  constructor(message, details) {
    super('loop_detected', 'REPEATED_OUTPUT', message, details);
    this.name = 'LoopDetectedError';
  }
}

// The agent's output is not usable: malformed, wrong shape, wrong task, refused, truncated, or the
// agent run itself reported an error.
class AgentOutputError extends AgentHaltError {
  constructor(message, details, code = 'INVALID_OUTPUT') {
    super('agent_output', code, message, details);
    this.name = 'AgentOutputError';
  }
}

// The provider could not be reached or kept refusing (rate limit, 5xx, timeout) after the bounded
// retries, or answered with a non-retryable client error.
class AgentTransportError extends AgentHaltError {
  constructor(code, message, details) {
    super('agent_transport', code, message, details);
    this.name = 'AgentTransportError';
  }
}

// Free path (CLI on a subscription): name the two failures the owner must act on, so the run can stop
// with a clear message instead of a generic exit code. The CLI texts are NOT verified against a live
// run (none was allowed); anything that does not match still fails closed with the generic code.
const QUOTA_RE = /usage limit|rate[ -]?limit|quota|limit reached|too many requests|429/i;
const AUTH_RE = /not logged in|log ?in required|please (?:run )?S*s*login|unauthori[sz]ed|401|invalid api key|authentication (?:failed|required|error)/i;

function classifyCliFailure(text) {
  const t = String(text || '');
  if (QUOTA_RE.test(t)) return 'QUOTA_EXHAUSTED';
  if (AUTH_RE.test(t)) return 'AUTH_REQUIRED';
  return null;
}

module.exports = { AgentHaltError, SpendBlockedError, LoopDetectedError, AgentOutputError, AgentTransportError, classifyCliFailure };
