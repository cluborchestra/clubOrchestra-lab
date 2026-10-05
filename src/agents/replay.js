'use strict';

// Replay transport (planner) and replay runner (worker) for Lot 2 dry runs. They serve recorded-
// format fixtures and are the ONLY transports a 'replay' mode guard accepts (marked .replay = true).
// No network, no process: a request with nothing queued for it fails closed (REPLAY_MISS).
//
// Routing is by what the request is for, so scripts stay readable:
//   planner: body.metadata.co_key   (e.g. "plan#0", "review:CO-SIM-001")
//   worker:  meta.task_id           (e.g. "CO-SIM-001")
// Each route is a queue of entries: { status, headers, body } for HTTP, { stdout, exit_code } for the
// worker, or { throw: "ETIMEDOUT" } to simulate a timeout/connection error.
const { AgentTransportError } = require('./errors');

function queueFrom(routes) {
  const q = {};
  for (const [k, list] of Object.entries(routes)) q[k] = [...list];
  return q;
}

function thrown(code) {
  return Object.assign(new Error(`replayed ${code}`), { code });
}

function makeReplayTransport(routes) {
  const queues = queueFrom(routes);
  const transport = async (url, init) => {
    const body = JSON.parse(init.body);
    const key = body.metadata && body.metadata.co_key;
    transport.requests.push({ url, method: init.method, headers: { ...init.headers }, body });
    const queue = queues[key];
    if (!queue || queue.length === 0) throw new AgentTransportError('REPLAY_MISS', `replay: nothing queued for ${key}`);
    const e = queue.shift();
    if (e.throw) throw thrown(e.throw);
    return { status: e.status, headers: { ...(e.headers || {}) }, body: typeof e.body === 'string' ? e.body : JSON.stringify(e.body) };
  };
  transport.replay = true;
  transport.requests = [];
  transport.remaining = () => Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, v.length]));
  return transport;
}

function makeReplayRunner(routes) {
  const queues = queueFrom(routes);
  const runner = async (invocation) => {
    const key = invocation.meta.task_id;
    runner.invocations.push(invocation);
    const queue = queues[key];
    if (!queue || queue.length === 0) throw new AgentTransportError('REPLAY_MISS', `replay: nothing queued for worker ${key}`);
    const e = queue.shift();
    if (e.throw) throw thrown(e.throw);
    return { exit_code: e.exit_code === undefined ? 0 : e.exit_code, stdout: typeof e.stdout === 'string' ? e.stdout : JSON.stringify(e.stdout), stderr: '' };
  };
  runner.replay = true;
  runner.invocations = [];
  return runner;
}

module.exports = { makeReplayTransport, makeReplayRunner };
