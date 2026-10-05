'use strict';

// Generates the Lot 2 replay fixtures (run: node test/fixtures/lot2/build-fixtures.js).
// The OpenAI fixtures follow the documented POST /v1/responses response shape and are checked
// against openai@7.28.0's own parsing in test/p3-lot2-replay.test.js. The Claude Code fixtures follow the
// documented `claude -p --output-format json` result shape. All of them are hand-authored: nothing was
// captured from a live API or a live `claude` run (both forbidden in Lot 2).
const fs = require('node:fs');
const path = require('node:path');
const { SimPlanner } = require('../../../src/sim/planner');

const DIR = __dirname;
const CREATED = '2026-10-05';
const SDK = 'openai@7.28.0';
const REPO = 'cluborchestra/clubOrchestra-lab';
const MODEL = 'gpt-replay-1'; // deliberately not a real model name
const SHA = { base: '0'.repeat(40), a1: 'a1'.repeat(20), a1b: 'b1'.repeat(20), a2: 'a2'.repeat(20) };

const oaHeader = (what) => ({
  created: CREATED, sdk: SDK, api: 'POST /v1/responses (OpenAI Responses API)', fixture: what,
  provenance: 'hand-authored from the documented response shape; NOT captured from a live API',
});
const ccHeader = (what) => ({
  created: CREATED, format: 'claude -p --output-format json (documented result shape)', fixture: what,
  provenance: 'hand-authored from the documented format; NOT captured from a live claude run',
});

function responseBody({ id, text, refusal, status = 'completed', incomplete = null, usage = { input: 1500, output: 350 }, schema = 'co_plan' }) {
  return {
    id: `resp_replay_${id}`, object: 'response', created_at: 1791244800, status, background: false, error: null,
    incomplete_details: incomplete, instructions: '(planner instructions; omitted in fixture)', max_output_tokens: 2000,
    metadata: {}, model: MODEL,
    output: [{
      type: 'message', id: `msg_replay_${id}`, status: status === 'incomplete' ? 'incomplete' : 'completed', role: 'assistant',
      content: [refusal ? { type: 'refusal', refusal } : { type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    parallel_tool_calls: true, previous_response_id: null, reasoning: { effort: null, summary: null }, service_tier: 'default',
    store: false, temperature: 1, text: { format: { type: 'json_schema', name: schema, strict: true } }, tool_choice: 'auto',
    tools: [], top_p: 1, truncation: 'disabled',
    usage: { input_tokens: usage.input, input_tokens_details: { cached_tokens: 0 }, output_tokens: usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.input + usage.output },
    user: null,
  };
}

const ok = (what, body) => ({ _fixture: oaHeader(what), status: 200, headers: { 'content-type': 'application/json', 'x-request-id': `req_replay_${body.id}` }, body });
const err = (what, status, headers, error) => ({ _fixture: oaHeader(what), status, headers: { 'content-type': 'application/json', ...headers }, body: { error } });

const sim = new SimPlanner({ repo: REPO });
const plan = (completed, last, decision) => {
  const task = sim.nextTask({ completed_tasks: completed, last_verified_sha: last });
  return JSON.stringify({ task, decision: decision || (task ? sim.classify(task) : null) });
};

const openai = {
  'plan-0-task1': ok('plan#0 -> CO-SIM-001 handoff', responseBody({ id: 'plan0', text: plan([], SHA.base) })),
  'plan-1-task2': ok('plan#1 -> CO-SIM-002 handoff (starts at a1…)', responseBody({ id: 'plan1', text: plan(['CO-SIM-001'], SHA.a1) })),
  'plan-done': ok('plan -> no more tasks', responseBody({ id: 'plandone', text: JSON.stringify({ task: null, decision: null }), usage: { input: 1500, output: 12 } })),
  'plan-0-owner-scope': ok('plan#0 -> CO-SIM-001, classified OWNER/scope by the planner', responseBody({ id: 'planowner', text: plan([], SHA.base, { class: 'OWNER', category: 'scope', reason: 'adds a new feature beyond the agreed goal' }) })),
  'plan-0-unclassified': ok('plan#0 -> CO-SIM-001 with an unusable decision (class MAYBE)', responseBody({ id: 'planmaybe', text: plan([], SHA.base, { class: 'MAYBE', category: null, reason: 'not sure' }) })),
  'review-accept': ok('review -> ACCEPT', responseBody({ id: 'revacc', text: JSON.stringify({ verdict: 'ACCEPT', reason: 'CI green on the exact sha; scope respected' }), usage: { input: 900, output: 40 }, schema: 'co_review' })),
  'review-reject': ok('review -> REJECT', responseBody({ id: 'revrej', text: JSON.stringify({ verdict: 'REJECT', reason: 'docs not updated for the new module' }), usage: { input: 900, output: 40 }, schema: 'co_review' })),
  refusal: ok('refusal content part', responseBody({ id: 'refusal', refusal: "I can't help with that request." , usage: { input: 1500, output: 9 } })),
  'incomplete-max-output-tokens': ok('status incomplete, reason max_output_tokens (truncated JSON)', responseBody({ id: 'trunc', status: 'incomplete', incomplete: { reason: 'max_output_tokens' }, text: '{"task": {"task_id": "CO-SIM-001", "action": "impl', usage: { input: 1500, output: 2000 } })),
  'malformed-json': ok('output_text is prose, not JSON', responseBody({ id: 'prose', text: 'Sure! Here is the plan: {"task": ...}', usage: { input: 1500, output: 20 } })),
  'schema-violation': ok('task missing "why", with an extra field', responseBody({ id: 'schema', text: (() => { const t = JSON.parse(plan([], SHA.base)).task; delete t.why; return JSON.stringify({ task: { ...t, requires_approval: false }, decision: { class: 'AUTO', category: null, reason: 'x' } }); })() })),
  'error-429-retry-after-2': err('429 rate limit, retry-after 2s', 429, { 'retry-after': '2' }, { message: 'Rate limit reached for requests', type: 'requests', param: null, code: 'rate_limit_exceeded' }),
  'error-429-retry-after-3600': err('429 rate limit, retry-after 3600s (beyond our cap)', 429, { 'retry-after': '3600' }, { message: 'Rate limit reached for requests', type: 'requests', param: null, code: 'rate_limit_exceeded' }),
  'error-500': err('500 server error', 500, {}, { message: 'The server had an error while processing your request.', type: 'server_error', param: null, code: null }),
  'error-503': err('503 overloaded', 503, {}, { message: 'The engine is currently overloaded, please try again later.', type: 'server_error', param: null, code: null }),
  'error-401': err('401 invalid key (must never be retried)', 401, {}, { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' }),
};

const result = (task, start, end, outcome = 'PASS') => JSON.stringify({
  task_id: task, outcome, starting_sha: start, ending_sha: end, files_changed: [`src/${task.toLowerCase()}.js`],
  tests: [{ name: 'npm test', status: outcome === 'PASS' ? 'pass' : 'fail' }], ci: { status: 'pending' }, docs_synced: true,
  risks: [], blockers: [], next_recommendation: outcome === 'PASS' ? 'await CI' : 'retry',
});
const ccUsage = { input_tokens: 1820, cache_creation_input_tokens: 5400, cache_read_input_tokens: 21000, output_tokens: 2350, server_tool_use: { web_search_requests: 0 }, service_tier: 'standard' };
function cc(what, { subtype = 'success', is_error = false, resultText, cost, turns = 6, exit = 0 }) {
  const stdout = { type: 'result', subtype, is_error, duration_ms: 48210, duration_api_ms: 41377, num_turns: turns };
  if (resultText !== undefined) stdout.result = resultText;
  stdout.session_id = '00000000-0000-4000-8000-000000000001';
  if (cost !== undefined) stdout.total_cost_usd = cost;
  Object.assign(stdout, { usage: ccUsage, permission_denials: [], uuid: '00000000-0000-4000-8000-0000000000a1' });
  return { _fixture: ccHeader(what), exit_code: exit, stdout };
}

const claude = {
  'work-task1': cc('CO-SIM-001 PASS (base -> a1…)', { resultText: result('CO-SIM-001', SHA.base, SHA.a1), cost: 0.2134 }),
  'work-task1-retry': cc('CO-SIM-001 PASS, second attempt (base -> b1…)', { resultText: result('CO-SIM-001', SHA.base, SHA.a1b), cost: 0.1950 }),
  'work-task1-fail': cc('CO-SIM-001 FAIL (identical every time -> loop)', { resultText: result('CO-SIM-001', SHA.base, SHA.a1b, 'FAIL'), cost: 0.0420 }),
  'work-task2': cc('CO-SIM-002 PASS (a1… -> a2…)', { resultText: result('CO-SIM-002', SHA.a1, SHA.a2), cost: 0.1876 }),
  'error-max-turns': cc('subtype error_max_turns, is_error true', { subtype: 'error_max_turns', is_error: true, cost: 0.3110, turns: 8, exit: 1 }),
  'error-during-execution': cc('subtype error_during_execution, is_error true', { subtype: 'error_during_execution', is_error: true, cost: 0.0275, turns: 2, exit: 1 }),
  'missing-cost': cc('success but total_cost_usd absent', { resultText: result('CO-SIM-001', SHA.base, SHA.a1) }),
  'prose-result': cc('success, but result is prose instead of the JSON object', { resultText: 'Done! I implemented the module and all tests pass.', cost: 0.0990 }),
};

module.exports = { SHA, MODEL, REPO };

// Only writes when run directly; requiring this file (tests) has no side effects.
if (require.main === module) {
  for (const [sub, set] of [['openai', openai], ['claude-code', claude]]) {
    fs.mkdirSync(path.join(DIR, sub), { recursive: true });
    for (const [name, data] of Object.entries(set)) fs.writeFileSync(path.join(DIR, sub, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  }
  console.log(`wrote ${Object.keys(openai).length} openai + ${Object.keys(claude).length} claude-code fixtures`);
}
