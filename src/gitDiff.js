'use strict';

// The real diff of a worker's commit, computed by the control plane with the local git binary,
// never taken from the worker's own report.
//
// This is the ONE file in src/ allowed to start a process, and only for this narrow use:
//   - execFileSync('git', [...]) with an argument array (no shell);
//   - read-only, local subcommands only: diff and cat-file;
//   - no network subcommand (fetch/push/clone/pull/remote/ls-remote), no hooks or external diff tools.
// The offline test in test/control-plane.test.js enforces exactly this exemption.
const { execFileSync } = require('node:child_process');
const { SHA_RE } = require('./events');

const MAX = 64 * 1024 * 1024;

class GitDiff {
  constructor(gitDir) {
    if (typeof gitDir !== 'string' || !gitDir) throw new TypeError('gitDir is required');
    this.gitDir = gitDir;
  }

  _git(args) {
    return execFileSync('git', ['--git-dir', this.gitDir, '-c', 'core.quotePath=false', ...args], {
      encoding: 'buffer', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
  }

  // [{ status, path, old_path?, old_mode, new_mode, link_target? }] for base..head, with rename
  // detection. status: A, D, M, T, R, C (with similarity dropped). Throws if git cannot answer:
  // the caller fails closed.
  changes(base, head) {
    if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new Error('changes(): base and head must be 40-char shas');
    const raw = this._git(['diff', '--raw', '-z', '-M', '--no-abbrev', '--no-ext-diff', '--no-textconv', base, head]).toString('utf8');
    const parts = raw.split('\0');
    const out = [];
    for (let i = 0; i < parts.length && parts[i] !== '';) {
      const meta = parts[i++];
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ACDMRTUX])\d*$/.exec(meta);
      if (!m) throw new Error(`unparseable git diff record: ${meta.slice(0, 80)}`);
      const [, oldMode, newMode, , newSha, status] = m;
      const c = { status, old_mode: oldMode, new_mode: newMode };
      if (status === 'R' || status === 'C') {
        c.old_path = parts[i++];
        c.path = parts[i++];
      } else {
        c.path = parts[i++];
      }
      if (newMode === '120000') c.link_target = this._git(['cat-file', 'blob', newSha]).toString('utf8');
      out.push(c);
    }
    return out;
  }
}

module.exports = { GitDiff };
