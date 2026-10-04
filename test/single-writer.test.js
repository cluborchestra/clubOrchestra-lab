'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store');
const { tmpDir } = require('./helpers');

test('single-writer: two writers read same version -> exactly one commits, other must re-read', () => {
  const dir = tmpDir('race');
  const a = new Store(dir).init();
  const b = new Store(dir);

  const sa = a.readState();
  const sb = b.readState();
  assert.equal(sa.version, sb.version);

  const ra = a.commit('writer-A', sa.version, { ...sa, next_safe_action: 'A' });
  const rb = b.commit('writer-B', sb.version, { ...sb, next_safe_action: 'B' });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, 'STALE_VERSION');
  assert.equal(a.readState().next_safe_action, 'A'); // B's write did not land

  // B re-reads (reconcile) and retries on the fresh version.
  const sb2 = b.readState();
  const rb2 = b.commit('writer-B', sb2.version, { ...sb2, next_safe_action: 'B' });
  assert.equal(rb2.ok, true);
  assert.equal(b.readState().version, 2);
});

test('single-writer: a held, unexpired lease rejects other writers; an expired lease can be taken', () => {
  const dir = tmpDir('lease');
  let now = 1_000_000;
  const a = new Store(dir, { leaseMs: 5_000, now: () => now }).init();
  const b = new Store(dir, { leaseMs: 5_000, now: () => now });

  assert.equal(a.acquireLease('writer-A').ok, true);
  const s = b.readState();
  const rb = b.commit('writer-B', s.version, { ...s, next_safe_action: 'B' });
  assert.deepEqual([rb.ok, rb.reason, rb.holder], [false, 'LEASE_HELD', 'writer-A']);

  now += 10_000; // A crashed without releasing; lease expires
  const rb2 = b.commit('writer-B', s.version, { ...s, next_safe_action: 'B' });
  assert.equal(rb2.ok, true);
  assert.equal(fs.existsSync(b.p.lock), false); // released after commit
});

test('single-writer: N concurrent OS processes racing on the same version -> exactly one wins', async () => {
  const dir = tmpDir('proc-race');
  new Store(dir).init();
  const N = 6;
  const script = path.join(__dirname, 'fixtures', 'race-writer.js');
  const results = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, dir, `proc-${i}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(JSON.parse(out)));
  })));

  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.ok(['STALE_VERSION', 'LEASE_HELD'].includes(r.reason));
  const final = new Store(dir).readState();
  assert.equal(final.version, 1);
  assert.equal(final.next_safe_action, winners[0].owner);
});
