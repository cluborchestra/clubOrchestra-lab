# SECURITY_MODEL — clubOrchestra-lab

Scope: how real agents (P3 Lot 3) will get API keys and how cost and prompt injection are contained.
**Status: PLAN ONLY.** No key or secret exists for this project, and nothing in this document has
been set up. Every step marked *Lot 3* needs the Product Owner's explicit approval (spec §5).

## 1. Threat model (spec §4.11, unchanged)
- Repo content, issues, PR text, commit messages, CI logs and **model output** are **untrusted
  data**. They never become instructions or policy.
- Control logic is in code: state machine, `policy.js` (allowed actions, approval-required
  actions), `config/agent-limits.json` (caps). Changing any of these requires a reviewed PR into
  protected `main`.
- Model output is parsed as strict JSON. Only the handoff-schema fields are kept
  (`src/handoff.js` `pick`); anything else is dropped. Invalid output → BLOCKED (fail closed).

## 2. Secrets: names and where they live (Lot 3)
| Secret | Used by | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | orchestrator `ingest` job only (environment `agents-planner`) | OpenAI Responses API. The control plane calls the planner *during* `ingest` (plan + review). |
| `ANTHROPIC_API_KEY` | worker job only (environment `agents-worker`) | Claude Code headless (worker), started by `repository_dispatch` from `outbox/` |

*Corrected in Lot 2:* an earlier draft said the orchestrator job never gets a key. In this design
the planner runs inside the orchestrator's `ingest` step, so that job needs `OPENAI_API_KEY`, and
only that one. The worker key is never available there.

- Stored only as **GitHub Actions environment secrets**, one key per environment:
  `agents-planner` (OpenAI) and `agents-worker` (Anthropic), under Settings → Environments. They are
  not repository-wide secrets, never go in code or files, and are never in `orchestra-state`.
  Each job can read only the key it needs.
- Settings for both environments:
  - **Deployment branches: `main` only.** Jobs from other branches cannot read the keys.
  - **Required reviewer: the Product Owner**, for the first supervised Lot 3 runs. Each agent job
    waits for an explicit click. Removing the reviewer later (for the autonomous loop) is its own
    approval decision.
- Only the orchestrator `ingest` job declares `environment: agents-planner`, and only the worker job
  declares `environment: agents-worker`. CI jobs and anything triggered by a pull request never
  declare either environment.
- GitHub never passes secrets to `pull_request` runs from forks. This project never uses
  `pull_request_target` or `workflow_run` with untrusted checkouts in a job that holds secrets.

## 3. Least privilege
- **One key per provider, created for this project only.**
  - OpenAI: a project-scoped key in a dedicated project, with only the models we use enabled.
  - Anthropic: a dedicated workspace key.
  - No personal, admin or organisation-wide keys.
- **Provider-side spend limits are the first line of defence:** an OpenAI project budget and an
  Anthropic workspace spend limit, each set at or below `daily_spend_cap_usd` × 30.
- **Our `SpendGuard` is the second line.** It checks every call *before* it is made: price known,
  per-call cap, daily cap, `max_calls_per_task`, and the loop detector.
- **GitHub is the third line:**
  - `concurrency: clubOrchestra` (one orchestrator at a time);
  - `timeout-minutes` on every job;
  - `GITHUB_TOKEN` gets only `contents: write` where a job must push, and `contents: read` elsewhere;
  - `main` is protected (PR required, no bypass, no force push).
- The Claude worker runs with a minimal `--allowedTools` list. It never gets the OpenAI key and
  never pushes to `main`, only to `co/<task_id>` branches.

## 4. Never in code or logs
- Keys reach a process **only as environment variables** in the agent job's `env:`. They are never
  passed as command-line arguments (visible in process lists), never written to files, never echoed.
- GitHub masks secret values in logs. Derived values (base64, substrings) are not masked, so
  adapters must never print request headers or the raw environment.
- The spend ledger (`data/spend/ledger.json`) and the audit log store only **counts, tokens, cost
  and SHA-256 hashes** of outputs. They never store prompts, outputs or headers (this is tested).
- **The adapters never touch keys** (Lot 2, tested). `src/agents/openaiResponses.js` builds the HTTP
  request **without** an Authorization header and hands it to an injected `transport(url, init)`.
  `src/agents/claudeCode.js` builds the `claude` invocation and hands it to an injected `runner`.
  A test sets canary values in `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` and checks they never appear in
  any request, invocation, ledger or audit entry.
- **Lot 3: exactly ONE file is exempt from the offline test:** `src/agents/live.js` (name reserved,
  does not exist yet). It holds the live HTTP transport (adds `Authorization: Bearer
  $OPENAI_API_KEY`) and the live `claude` runner (passes `ANTHROPIC_API_KEY` only into that child's
  environment). It is the only place allowed `fetch`/`child_process`/`process.env`, and only for
  those two key names. The exemption names that one path, and the offline test keeps checking
  every other file.
- **Lot 3 design point (needs a decision):** the control plane and adapters are synchronous, while
  real `fetch` is asynchronous. Recommendation: keep the verified control plane unchanged and give
  `live.js` a synchronous bridge (a worker thread + `Atomics.wait`, or `spawnSync` of a small
  helper). The alternative is to make the whole agent call path async, which touches verified
  P1/P2 code.

## 4a. Spend ledger: where it lives, concurrency, the day (P3 Lot 2 Q1/Q3)
- **Location:** `<state dir>/spend/ledger.json`. On GitHub that is `state/data/spend/ledger.json` on
  the `orchestra-state` branch, committed by the orchestrator's `git add data` together with
  `state.json`. Every Actions run therefore starts from the previous run's spend. Test 12 runs
  every step as a fresh instance on the same files, and the cap still holds.
- **Reservation before the call:** `check()` takes a lock on the ledger (`ledger.json.lock`, O_EXCL,
  as with `state.lock`) and adds the call's **estimate** to `spent_usd_today` before the call is
  made. After the call, `record()` replaces the estimate with the actual cost. If the call failed
  or its cost cannot be established, the estimate stays booked (conservative; `COST_UNKNOWN` halts).
- **Concurrency:**
  - On one host, the lock plus the reservation means concurrent callers cannot jointly overshoot
    the cap. Test 13: 8 processes race for 0.30 USD each under a 1.00 cap, exactly 3 succeed and
    0.90 is booked.
  - Across Actions runs, the orchestrator's `concurrency: { group: clubOrchestra,
    cancel-in-progress: false }` serialises runs.
  - **Lot 3 requirement:** every job that calls a model runs in that same concurrency group and
    commits the ledger in the same push as the state.
  - **Residual risk:** if that push is rejected (optimistic lock lost), the run's ledger bookings
    are lost with it. Serialisation prevents this. Lot 3 must also treat a rejected state push
    after a model call as an alert, not a silent retry.
- **The day is UTC.** `spent_usd_today` resets at 00:00 UTC, computed from the clock as
  `new Date(now).toISOString()`, whatever offset the clock reports. Tested at the boundary and with
  ±02:00 offsets. Call budgets (`max_calls_per_task`) never reset.

## 4b. Loop detector = circuit-breaker trip (P3 Lot 2 Q2)
When the worker returns **the same output twice for the same task** (`REPEATED_OUTPUT`), the
control plane halts immediately and **trips the circuit breaker**: `failure_count` is raised to the
breaker threshold (3) even if fewer real FAILs were counted (1 FAIL + the repeat in the Lot 1
example). This is intentional, not a counting error:
- A repeat proves retries are not making progress (spec §4.9: "same patch repeated → BLOCKED").
  Waiting for the remaining retries would only spend more money.
- One field answers "is the breaker tripped?" (`failure_count >= threshold`) for the human reset,
  the future watchdog and reporting, the same way for both causes.
- The true history is kept elsewhere: the audit log has every FAIL transition, and the escalation
  record (`kind: loop_detected`, `code: REPEATED_OUTPUT`) has the hash and the repeat count.

## 5. Detection, rotation, kill switches
- GitHub **secret scanning + push protection** stay on (default for public repos), so a key
  committed by mistake is blocked or flagged.
- Suspected leak: revoke the key at the provider **first**, then delete the environment secret,
  then rotate. Revoking costs nothing and is always safe.
- Kill switches, fastest first:
  1. unset `ORCHESTRATOR_ENABLED`;
  2. set `"mode": "mock"` in `config/agent-limits.json` (via PR);
  3. delete the `agents` environment secrets;
  4. revoke the provider keys.

## 6. Product Owner checklist for Lot 3 (nothing done yet)
1. Approve Lot 3 and a spend cap.
2. Create the dedicated OpenAI project and Anthropic workspace, set provider-side budgets, and
   create the two keys.
3. Create the GitHub environments `agents-planner` (secret `OPENAI_API_KEY`) and `agents-worker`
   (secret `ANTHROPIC_API_KEY`). Both: branches `main` only, required reviewer: you.
4. Set real numbers in `config/agent-limits.json` (`_PRODUCT_OWNER_SETS_IN_LOT3`): the real
   prices for the models you choose, the daily cap and the per-call cap. Merge via PR.
5. Decide the sync-bridge question for `src/agents/live.js` (§4).
6. First supervised run: one task, with the reviewer gate on.
