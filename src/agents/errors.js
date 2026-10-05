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

// A spend/rate limit would be exceeded. Raised BEFORE the model call is made.
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

// The agent's output is not valid for the handoff schema (malformed, wrong shape, wrong task).
class AgentOutputError extends AgentHaltError {
  constructor(message, details) {
    super('agent_output', 'INVALID_OUTPUT', message, details);
    this.name = 'AgentOutputError';
  }
}

module.exports = { AgentHaltError, SpendBlockedError, LoopDetectedError, AgentOutputError };
