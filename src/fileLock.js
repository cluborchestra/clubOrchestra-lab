'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

// Small cross-process mutex on a lock file created with O_EXCL (same technique as the state lease
// in store.js). An expired lock (crashed holder) is broken. Windows reports EPERM/EACCES while
// another process's unlink is pending: treated as "held", never as success. Returns { ok: false }
// if the lock could not be taken within waitMs; the caller fails closed.
function withFileLock(lockPath, { ttlMs = 10_000, waitMs = 2_000 } = {}, fn) {
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ owner, expires_at: Date.now() + ttlMs }), { flag: 'wx' });
      break;
    } catch (err) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      if (err.code === 'EEXIST') {
        let held = null;
        try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* unreadable: treat as held */ }
        if (held && typeof held.expires_at === 'number' && held.expires_at < Date.now()) {
          try { fs.unlinkSync(lockPath); } catch { /* someone else broke it */ }
          continue;
        }
      }
      if (Date.now() >= deadline) return { ok: false };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).owner === owner) fs.unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}

module.exports = { withFileLock };
