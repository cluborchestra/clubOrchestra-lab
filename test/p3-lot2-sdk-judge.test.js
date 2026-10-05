'use strict';

// D-A: openai@7.28.0 (devDependency only) is the judge of our zero-dep Responses adapter.
//  - golden request: the SDK, given our request parameters, sends exactly the request our adapter
//    builds (URL, method, JSON body, content type).
//  - response parsing: for every 200 fixture, the SDK's parsed output_text / usage / status agree with
//    our classification.
//  - errors: the SDK's error classes for the HTTP error fixtures agree with our codes.
// The SDK gets an injected fetch that serves fixtures, an explicit dummy key (never read from the
// environment) and maxRetries 0. The network trap from helpers stays armed throughout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers'); // network trap
const sdkModule = require('openai');
const { OpenAIResponsesClient } = require('../src/agents/openaiResponses');
const { makeReplayTransport } = require('../src/agents/replay');
const { PLANNER_SYSTEM } = require('../src/agents/modelAgents');
const { loadLimits } = require('../src/agents/limits');
const { MODEL } = require('./fixtures/lot2/build-fixtures');

const OpenAI = sdkModule.default || sdkModule.OpenAI || sdkModule;
const SDK_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'openai', 'package.json'), 'utf8')).version;
const FIX = path.join(__dirname, 'fixtures', 'lot2', 'openai');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));
const LIMITS0 = (() => { const l = JSON.parse(JSON.stringify(loadLimits(path.join(__dirname, 'fixtures', 'lot2', 'limits.replay.json')))); l.transport.max_retries = 0; return l; })();
const ours = (transport = makeReplayTransport({})) => new OpenAIResponsesClient({ transport, model: MODEL, limits: LIMITS0, sleep: () => {} });

function sdkWith(fetchImpl) {
  return new OpenAI({ apiKey: 'replay-dummy-not-a-key', organization: null, project: null, webhookSecret: null, baseURL: 'https://api.openai.com/v1', fetch: fetchImpl, maxRetries: 0 });
}
const serve = (f) => async () => new Response(typeof f.body === 'string' ? f.body : JSON.stringify(f.body), { status: f.status, headers: f.headers });

test('SDK under test is the pinned devDependency', () => {
  assert.equal(SDK_VERSION, '7.28.0');
  assert.equal(require('../package.json').devDependencies.openai, '7.28.0');
  assert.deepEqual(Object.keys(require('../package.json').dependencies || {}), []); // production stays zero-dep
});

for (const [purpose, input] of [
  ['plan', { completed_tasks: [], last_verified_sha: '0'.repeat(40), feedback: null }],
  ['review', { task_id: 'CO-SIM-001', sha: 'a1'.repeat(20), ci_status: 'success', evidence_refs: ['github-run:1/attempt-1'] }],
]) {
  test(`golden request (${purpose}): the SDK sends byte-for-byte the request our adapter builds`, async () => {
    const request = { purpose, role: 'planner', key: purpose === 'plan' ? 'plan#0' : 'review:CO-SIM-001', system: PLANNER_SYSTEM, input, max_output_tokens: 2000 };
    const mine = ours().buildRequest(request);
    let captured;
    const capture = async (url, init) => { captured = { url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body }; return serve(fixture('review-accept'))(); };
    await sdkWith(capture).responses.create(JSON.parse(mine.init.body));
    assert.equal(captured.url, mine.url);
    assert.equal(captured.method, mine.init.method);
    assert.deepEqual(JSON.parse(captured.body), JSON.parse(mine.init.body));
    assert.equal(captured.body, mine.init.body); // identical serialisation, not just equal JSON
    assert.equal(captured.headers.get('content-type'), mine.init.headers['content-type']);
    assert.ok(!('authorization' in mine.init.headers)); // only the Lot 3 live transport will add it
  });
}

for (const name of ['plan-0-task1', 'plan-1-task2', 'plan-done', 'review-accept', 'review-reject', 'malformed-json', 'schema-violation']) {
  test(`parsing (${name}): SDK output_text and usage agree with our adapter`, async () => {
    const f = fixture(name);
    const r = await sdkWith(serve(f)).responses.create({ model: MODEL, input: 'x' });
    const mine = ours()._parse(JSON.stringify(f.body));
    assert.equal(r.status, 'completed');
    assert.equal(mine.text, r.output_text);
    assert.deepEqual(mine.usage, { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens });
    assert.equal(mine.error, undefined);
  });
}

test('parsing (refusal): SDK sees a refusal content part; our adapter halts REFUSAL (billed)', async () => {
  const f = fixture('refusal');
  const r = await sdkWith(serve(f)).responses.create({ model: MODEL, input: 'x' });
  assert.equal(r.output[0].content[0].type, 'refusal');
  assert.equal(r.output_text, '');
  const mine = ours()._parse(JSON.stringify(f.body));
  assert.equal(mine.error.code, 'REFUSAL');
  assert.deepEqual(mine.usage, { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens });
});

test('parsing (incomplete): SDK reports status incomplete / max_output_tokens; our adapter halts INCOMPLETE_MAX_OUTPUT_TOKENS', async () => {
  const f = fixture('incomplete-max-output-tokens');
  const r = await sdkWith(serve(f)).responses.create({ model: MODEL, input: 'x' });
  assert.equal(r.status, 'incomplete');
  assert.equal(r.incomplete_details.reason, 'max_output_tokens');
  assert.equal(ours()._parse(JSON.stringify(f.body)).error.code, 'INCOMPLETE_MAX_OUTPUT_TOKENS');
});

for (const [name, sdkClass, status, ourCode] of [
  ['error-429-retry-after-2', 'RateLimitError', 429, 'RATE_LIMITED'],
  ['error-500', 'InternalServerError', 500, 'UPSTREAM_UNAVAILABLE'],
  ['error-503', 'InternalServerError', 503, 'UPSTREAM_UNAVAILABLE'],
  ['error-401', 'AuthenticationError', 401, 'CLIENT_ERROR_401'],
]) {
  test(`errors (${name}): SDK ${sdkClass} <-> our ${ourCode}`, async () => {
    const f = fixture(name);
    const Cls = sdkModule[sdkClass] || OpenAI[sdkClass];
    await assert.rejects(sdkWith(serve(f)).responses.create({ model: MODEL, input: 'x' }), (e) => e instanceof Cls && e.status === status);
    const client = ours(makeReplayTransport({ k: [f] }));
    assert.throws(() => client.complete({ purpose: 'review', role: 'planner', key: 'k', system: 's', input: {}, max_output_tokens: 10 }), (e) => e.code === ourCode);
  });
}
