'use strict';

// The worker runs one exact Claude Code CLI version (config/agent-limits.json claude_code.version,
// pinned in .github/workflows/worker.yml). `claude --version` must print exactly
// "<version> (Claude Code)" (one trailing newline allowed); anything else fails closed.
function verifyClaudeVersion(output, expected) {
  if (typeof output !== 'string' || typeof expected !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected)) return false;
  return output.replace(/\r?\n$/, '') === `${expected} (Claude Code)`;
}

module.exports = { verifyClaudeVersion };
