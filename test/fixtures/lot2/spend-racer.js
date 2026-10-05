'use strict';

// Child process for the concurrent-spend test: one reservation attempt against a shared ledger.
const { SpendGuard } = require('../../../src/agents/spendGuard');
const { loadLimits } = require('../../../src/agents/limits');

const [ledgerPath, limitsPath, key] = process.argv.slice(2);
const guard = new SpendGuard({ limits: loadLimits(limitsPath), ledgerPath });
try {
  const t = guard.check({ role: 'worker', key, provider: 'anthropic', model: 'claude-code-headless', replay: true, estimate_usd: 0.3 });
  process.stdout.write(JSON.stringify({ key, ok: true, reserved: t.reserved_usd }));
} catch (err) {
  process.stdout.write(JSON.stringify({ key, ok: false, code: err.code }));
}
