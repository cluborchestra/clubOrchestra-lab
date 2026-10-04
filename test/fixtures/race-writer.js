'use strict';

// Child process for the multi-process single-writer race test.
// Every process commits against version 0 (the version they all "read").
const { Store } = require('../../src/store');

const [dir, owner] = process.argv.slice(2);
const store = new Store(dir);
const s = store.readState();
const r = store.commit(owner, 0, { ...s, next_safe_action: owner });
process.stdout.write(JSON.stringify({ owner, ok: r.ok, reason: r.reason || null }));
