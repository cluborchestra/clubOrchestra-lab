'use strict';

// Live runner for the free path (CO-P3-FREE-002): the ONLY src file that starts the model CLIs
// (`codex`, `claude`). Local, owner-started runs only (harness/run-local-free.js); it refuses to work
// in CI. It implements the runner contract of codexExec.js / claudeCode.js:
//   runner({ command, argv, stdin, meta, files? }) -> Promise<{ exit_code, stdout, stderr, outputs }>
// Guarantees:
//   - fixed binaries from `commands` (absolute paths), argument arrays, shell: false;
//   - cwd = the disposable clone (workdir); files ({SCHEMA_FILE}, {SETTINGS_FILE}) and the -o output
//     ({OUTPUT_FILE}) live in scratchDir, which must be OUTSIDE the clone; a placeholder that is not
//     substituted fails the call before any process starts;
//   - child environment from an ALLOWLIST (no API keys, tokens, base URLs or NODE_OPTIONS can pass),
//     plus CODEX_HOME for codex (the isolated login); so the CLIs can only use the subscription login;
//   - per-command timeout (the process tree is killed) and an output size cap.
// It is NOT a replay runner (no .replay flag): the guard accepts it only in mode local-subscription,
// and only for subscription-priced models.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const ENV_ALLOW = Object.freeze([
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG',
]);
const ENV_NEVER = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE_URL|NODE_OPTIONS/i;
const PLACEHOLDER = /^\{[A-Z_]+\}$/;
const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// Builds a child environment from the allowlist only; `extra` may add named values (never secrets).
function childEnv(base, extra = {}) {
  const env = {};
  for (const k of ENV_ALLOW) if (typeof base[k] === 'string') env[k] = base[k];
  for (const [k, v] of Object.entries(extra)) {
    if (ENV_NEVER.test(k)) throw fail('ENV_REFUSED', `refusing to pass ${k} to a child process`);
    env[k] = String(v);
  }
  return env;
}

function inCi(base) {
  return Boolean(base.CI || base.GITHUB_ACTIONS);
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true }, () => {});
  else child.kill('SIGKILL');
}

// Runs one process; resolves { exit_code, stdout, stderr, ms }, rejects with code ETIMEDOUT,
// EOUTPUTLIMIT or the spawn error code (e.g. ENOENT).
function runProcess({ file, args, cwd, env, stdin = '', timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawnImpl(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errs = [];
    let bytes = 0;
    let done = false;
    const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => { killTree(child); reject(fail('ETIMEDOUT', `${path.basename(file)} timed out after ${timeoutMs} ms`)); }), timeoutMs);
    const take = (list) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) finish(() => { killTree(child); reject(fail('EOUTPUTLIMIT', `${path.basename(file)} wrote more than ${maxOutputBytes} bytes`)); });
      else list.push(chunk);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(errs));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({
      exit_code: code === null ? -1 : code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(errs).toString('utf8'),
      ms: Date.now() - t0,
    })));
    child.stdin.on('error', () => {}); // a CLI that exits before reading stdin is reported by its exit code
    child.stdin.end(stdin);
  });
}

function checkCommand(name, cmd) {
  if (!cmd || typeof cmd.file !== 'string' || !path.isAbsolute(cmd.file)) throw new TypeError(`commands.${name}.file must be an absolute path`);
  if (cmd.args !== undefined && !(Array.isArray(cmd.args) && cmd.args.every((a) => typeof a === 'string'))) throw new TypeError(`commands.${name}.args must be strings`);
}

// commands: { codex: { file, args? }, claude: { file, args? } }  (codex: node + codex.js, no .cmd shim)
function makeLiveRunner({ commands, workdir, scratchDir, codexHome, timeoutsMs = { codex: 180000, claude: 600000 },
  env = process.env, spawnImpl = spawn, maxOutputBytes = DEFAULT_MAX_OUTPUT }) {
  if (inCi(env)) throw fail('LOCAL_ONLY', 'the live runner is local-only: subscription logins never run in CI');
  for (const [name, cmd] of Object.entries(commands || {})) checkCommand(name, cmd);
  for (const [k, v] of Object.entries({ workdir, scratchDir, codexHome })) {
    if (typeof v !== 'string' || !path.isAbsolute(v)) throw new TypeError(`${k} must be an absolute path`);
  }
  if (inside(scratchDir, workdir)) throw new TypeError('scratchDir must be outside the working directory');
  if (inside(codexHome, workdir)) throw new TypeError('codexHome must be outside the working directory');
  fs.mkdirSync(scratchDir, { recursive: true });
  let n = 0;

  const runner = async (inv) => {
    const cmd = commands[inv.command];
    if (!cmd) throw fail('UNKNOWN_COMMAND', `no binary configured for ${inv.command}`);
    const id = `${String(++n).padStart(3, '0')}-${inv.command}`;
    const outputFile = path.join(scratchDir, `${id}-last-message.txt`);
    const subs = { '{WORKDIR}': workdir, '{OUTPUT_FILE}': outputFile };
    for (const [name, content] of Object.entries(inv.files || {})) {
      if (!/^[a-z]+$/.test(name) || typeof content !== 'string') throw fail('BAD_FILE', `bad invocation file ${name}`);
      const p = path.join(scratchDir, `${id}-${name}.json`);
      fs.writeFileSync(p, content);
      subs[`{${name.toUpperCase()}_FILE}`] = p;
    }
    const argv = inv.argv.map((a) => (Object.prototype.hasOwnProperty.call(subs, a) ? subs[a] : a));
    const left = argv.filter((a) => PLACEHOLDER.test(a));
    if (left.length) throw fail('UNRESOLVED_PLACEHOLDER', `unresolved ${left.join(',')}`);
    const extra = inv.command === 'codex' ? { CODEX_HOME: codexHome } : {};
    const record = { id, command: inv.command, argv, meta: inv.meta, env_keys: Object.keys(childEnv(env, extra)).sort() };
    runner.invocations.push(record);
    let res;
    try {
      res = await runProcess({
        file: cmd.file, args: [...(cmd.args || []), ...argv], cwd: workdir, env: childEnv(env, extra),
        stdin: inv.stdin, timeoutMs: timeoutsMs[inv.command], maxOutputBytes, spawnImpl,
      });
    } catch (err) {
      record.error = err.code || err.message;
      throw err;
    }
    const outputs = {};
    if (argv.includes(outputFile)) {
      try { outputs.last_message = fs.readFileSync(outputFile, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    Object.assign(record, { exit_code: res.exit_code, ms: res.ms, stdout_bytes: Buffer.byteLength(res.stdout), stderr_tail: res.stderr.slice(-500) });
    return { exit_code: res.exit_code, stdout: res.stdout, stderr: res.stderr, outputs };
  };
  runner.live = true;
  runner.invocations = [];
  return runner;
}

// Non-model checks the run script needs before any model call: `--version`, `claude auth status`,
// `codex login status`. Same allowlisted environment; never a prompt.
async function runCheck({ cmd, argv, cwd, codexHome = null, env = process.env, timeoutMs = 60000, spawnImpl = spawn }) {
  if (inCi(env)) throw fail('LOCAL_ONLY', 'the live runner is local-only');
  checkCommand('check', cmd);
  const extra = codexHome ? { CODEX_HOME: codexHome } : {};
  return runProcess({ file: cmd.file, args: [...(cmd.args || []), ...argv], cwd, env: childEnv(env, extra), stdin: '', timeoutMs, spawnImpl });
}

module.exports = { makeLiveRunner, runCheck, runProcess, childEnv, ENV_ALLOW };
