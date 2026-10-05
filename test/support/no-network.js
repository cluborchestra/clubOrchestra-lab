'use strict';

// Network trap for the test suite (loaded by test/helpers.js, so it covers every test file).
// Any attempt to open a network connection from inside a test process throws immediately and is
// recorded in globalThis.__networkAttempts. A test that triggers one fails at that point.
// Child processes are not covered: the only ones the suite starts are the local `git` binary and
// `node` running the single-writer race fixture, neither of which touches the network.
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');

if (!globalThis.__networkTrapInstalled) {
  globalThis.__networkTrapInstalled = true;
  globalThis.__networkAttempts = [];
  const trap = (what) => function forbidden() {
    globalThis.__networkAttempts.push(what);
    const err = new Error(`NETWORK_FORBIDDEN: ${what} called during tests`);
    err.code = 'NETWORK_FORBIDDEN';
    throw err;
  };
  globalThis.fetch = trap('fetch');
  for (const [mod, name, fns] of [
    [http, 'http', ['request', 'get']], [https, 'https', ['request', 'get']], [http2, 'http2', ['connect']],
    [net, 'net', ['connect', 'createConnection']], [tls, 'tls', ['connect']],
    [dns, 'dns', ['lookup', 'resolve', 'resolve4', 'resolve6']], [dns.promises, 'dns.promises', ['lookup', 'resolve']],
  ]) {
    for (const fn of fns) mod[fn] = trap(`${name}.${fn}`);
  }
}

module.exports = { attempts: () => [...globalThis.__networkAttempts] };
