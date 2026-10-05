'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WorkerAdapter } = require('./agents/adapter');

// Dispatch-by-file worker for the GitHub-hosted loop (P2). Instead of executing, it records the
// handoff in <dir>/outbox/<task_id>.json and returns no event; the worker's result arrives later
// as its own event. In P2b the orchestrator workflow would turn the outbox file into a
// repository_dispatch to the worker (needs the GitHub remote -> OWNER_APPROVAL_REQUIRED).
class OutboxWorker extends WorkerAdapter {
  constructor(dir) {
    super();
    this.outbox = path.join(path.resolve(dir), 'outbox');
  }

  execute(handoff) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(handoff.task_id)) throw new Error('invalid task_id');
    fs.mkdirSync(this.outbox, { recursive: true });
    fs.writeFileSync(path.join(this.outbox, `${handoff.task_id}.json`), JSON.stringify(handoff, null, 2) + '\n');
    return null;
  }
}

module.exports = { OutboxWorker };
