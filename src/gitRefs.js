'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SHA_RE } = require('./events');

// Reads branch heads straight from a .git directory (loose refs, then packed-refs).
// Pure file reads: no git binary, no child processes, no network. Used for exact-SHA gating
// and reconcile: "what does the real repo say the head is?"
const BRANCH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

class GitRefs {
  constructor(gitDir) {
    this.gitDir = path.resolve(gitDir);
  }

  // Returns the 40-hex sha of refs/heads/<branch>, or null if absent/unreadable.
  head(branch) {
    if (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.split('/').includes('..')) return null;
    const ref = `refs/heads/${branch}`;
    try {
      const loose = fs.readFileSync(path.join(this.gitDir, ...ref.split('/')), 'utf8').trim();
      if (SHA_RE.test(loose)) return loose;
    } catch { /* fall through to packed-refs */ }
    try {
      for (const line of fs.readFileSync(path.join(this.gitDir, 'packed-refs'), 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref && SHA_RE.test(sha)) return sha;
      }
    } catch { /* no packed-refs */ }
    return null;
  }
}

module.exports = { GitRefs };
