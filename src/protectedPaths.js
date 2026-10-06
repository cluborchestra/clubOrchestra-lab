'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Protected paths: the worker must never change its own rules (spend caps, escalation, network trap,
// workflows, config). The control plane checks the REAL diff of the worker's commit (computed by git,
// not reported by the worker). Any protected path touched -> OWNER/security: nothing is forwarded
// until the owner decides. The planner cannot soften this.
//
// The floor below is hard-coded. config/protection.json may ADD paths, never remove them (and
// config/** is itself protected, so a worker cannot edit that list).
// PRE3b: the guard protects itself. All of src/ (this file, gitDiff.js, ownerCommands.js,
// controlPlane.js, states.js, ...) and the test support code are protected, plus git attribute and
// submodule files, which change how paths and content are interpreted. Worker tasks in this repo write
// to work/. The specific src/ entries below are kept on purpose: they name the core rules explicitly.
const FLOOR = Object.freeze([
  '.github/**',
  'config/**',
  'src/**',
  'test/support/**',
  '.gitattributes',
  '.gitmodules',
  'src/escalation.js',
  'src/agents/spendGuard.js',
  'src/agents/limits.js',
  'src/agents/live.js', // future file (P3 Lot 3); protected before it exists
  'src/fileLock.js',
  'test/support/no-network.js',
  'package.json',
  'package-lock.json',
  'docs/PROJECT_STATUS.json',
  'docs/CLUB_DOCUMENTATION_STANDARD.md',
]);
const DEFAULT_CONFIG = path.join(__dirname, '..', 'config', 'protection.json');
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Normalises a repository path for matching. Returns null for anything that is not a clean,
// repository-relative path (absolute, drive letters, escaping with ..): callers treat null as protected.
function normalize(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return null;
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  s = path.posix.normalize(s);
  if (s === '.' || s === '..' || s.startsWith('../')) return null;
  return s.replace(/^\.\//, '').replace(/\/+$/, '');
}

// Case-insensitive: case-insensitive filesystems (Windows, macOS) would map ".GitHub" onto ".github".
function matches(normalized, pattern) {
  const n = normalized.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.endsWith('/**')) {
    const dir = pat.slice(0, -3);
    return n === dir || n.startsWith(`${dir}/`);
  }
  return n === pat;
}

function isProtected(p, patterns = FLOOR) {
  const n = normalize(p);
  if (n === null) return true; // unclear path -> protected (fail closed)
  return patterns.some((pat) => matches(n, pat));
}

function validateProtection(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['protection config must be an object'];
  if (cfg.schema_version !== 1) errors.push('schema_version must be 1');
  if (!Array.isArray(cfg.extra_protected_paths) || !cfg.extra_protected_paths.every((p) => normalize(p.replace(/\/\*\*$/, '')) !== null)) {
    errors.push('extra_protected_paths must be a list of repository-relative paths');
  }
  if (!Array.isArray(cfg.approvers) || cfg.approvers.length === 0 || !cfg.approvers.every((a) => typeof a === 'string' && LOGIN_RE.test(a))) {
    errors.push('approvers must be a non-empty list of GitHub logins');
  }
  return errors;
}

// Floor ∪ configured extras. The floor is always included, whatever the config says.
function loadProtection(file = DEFAULT_CONFIG) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateProtection(cfg);
  if (errors.length) throw new Error(`invalid protection config (${file}): ${errors.join('; ')}`);
  const patterns = [...new Set([...FLOOR, ...cfg.extra_protected_paths])];
  return Object.freeze({ patterns: Object.freeze(patterns), approvers: Object.freeze(cfg.approvers.map((a) => a.toLowerCase())) });
}

// changes: [{ status, path, old_path?, old_mode, new_mode, link_target? }] from GitDiff.
// Returns the changes that touch a protected path, each with the reason.
function protectedChanges(changes, patterns = FLOOR) {
  const touched = [];
  for (const c of changes) {
    const reasons = [];
    if (isProtected(c.path, patterns)) reasons.push(`path ${c.path}`);
    if (c.old_path && isProtected(c.old_path, patterns)) reasons.push(`old path ${c.old_path}`);
    if (c.link_target !== undefined && c.link_target !== null) {
      // A symlink pointing at (or out to) a protected file is treated as touching it.
      const target = c.link_target.startsWith('/') ? null : path.posix.join(path.posix.dirname(c.path), c.link_target);
      if (target === null || isProtected(target, patterns)) reasons.push(`symlink to ${c.link_target}`);
    }
    if (reasons.length) touched.push({ status: c.status, path: c.path, ...(c.old_path ? { old_path: c.old_path } : {}), reason: reasons.join('; ') });
  }
  return touched;
}

module.exports = { FLOOR, normalize, isProtected, protectedChanges, loadProtection, validateProtection, DEFAULT_CONFIG };
