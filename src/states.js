'use strict';

// State machine for the control plane (spec §4.4). Only the edges listed here are legal.
const STATES = Object.freeze([
  'IDLE', 'RUNNING', 'WAITING_EVENT', 'WAITING_APPROVAL', 'BLOCKED', 'FAILED', 'COMPLETE',
]);

const TRANSITIONS = Object.freeze({
  IDLE: ['RUNNING', 'BLOCKED'],
  RUNNING: ['WAITING_EVENT', 'WAITING_APPROVAL', 'COMPLETE', 'BLOCKED'],
  WAITING_EVENT: ['RUNNING', 'FAILED', 'BLOCKED'],
  WAITING_APPROVAL: ['RUNNING', 'BLOCKED'],
  FAILED: ['RUNNING', 'BLOCKED'],
  BLOCKED: ['IDLE'], // only via explicit human reset
  COMPLETE: [], // terminal
});

function isLegalTransition(from, to) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

class IllegalTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

module.exports = { STATES, TRANSITIONS, isLegalTransition, IllegalTransitionError };
