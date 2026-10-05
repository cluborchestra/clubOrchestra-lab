'use strict';

require('./support/no-network'); // every test process: any network attempt throws

const fs = require('node:fs');
const path = require('node:path');
const { ControlPlane } = require('../src/controlPlane');
const { SimPlanner } = require('../src/sim/planner');
const { SimWorker } = require('../src/sim/worker');

// Test scratch dirs live inside the repo (gitignored) so nothing outside it is touched.
const TMP_ROOT = path.join(__dirname, '..', '.tmp-test');
let counter = 0;

function tmpDir(name) {
  const d = path.join(TMP_ROOT, `${process.pid}-${name}-${++counter}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let tick = 0;
const fixedClock = () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + 1000 * tick++).toISOString();

function setup(name, { plan, script, payloadExtra, plannerExtra, breakerThreshold } = {}) {
  const dir = tmpDir(name);
  const planner = new SimPlanner({ ...(plan ? { plan } : {}), extra: plannerExtra || {} });
  const worker = new SimWorker({ script, payloadExtra, clock: fixedClock });
  const cp = new ControlPlane({ dir, planner, worker, now: fixedClock, breakerThreshold }).init();
  return { dir, cp, planner, worker };
}

function transitions(cp) {
  return cp.store.readAudit().filter((e) => e.kind === 'transition').map((e) => `${e.from}->${e.to}`);
}

module.exports = { setup, tmpDir, transitions, fixedClock, TMP_ROOT };
