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
  - **Deployment branches: `main` only.** This matches the branch the jobs actually run on.
    GitHub checks an environment's branch rule against the run's `github.ref`, not against
    whatever a job later checks out.
    - The orchestrator is triggered by `workflow_run`. That event only runs the workflow file on
      the **default branch** (`main`), with `github.ref = refs/heads/main`.
    - The worker workflow (Lot 3) is triggered by `repository_dispatch`, which also only runs the
      workflow file on the default branch, with `github.ref` = `main`. The worker then *checks
      out* `co/<task_id>` to work on. That does not change `github.ref`, so the `main` rule
      still matches.
    - No agent workflow may use `workflow_dispatch`, `push` or `pull_request` triggers. Those
      can run on other refs, and the `main`-only rule would (correctly) deny them the keys.
  - **Required reviewer: the Product Owner, ACTIVE throughout Lot 3 (supervised).**
    - **Each** job that uses `agents-planner` or `agents-worker` pauses until you click
      *Approve* in GitHub. This **stops the automation by design**: no model call happens without
      your click, so the loop is no longer "no human continue" while the gate is on.
    - Removing the reviewer, to let the Review-Dispatch Loop run on its own, is a **separate, later
      decision by Ási**. It is not part of Lot 3.
    - While a job waits for approval it holds its place in the `clubOrchestra` concurrency
      group (see §4a, "pending runs").
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
- **Async call path (decided and done in Lot 2b):**
  - The control plane, the adapters and the clients are `async`, so the live transport can be a
    plain `await fetch(...)` and the live runner a plain child process, with no bridge.
  - The first paid run therefore tests exactly one new thing: the live I/O in `src/agents/live.js`.
  - The worker invocation uses only flags verified against `claude --help` 2.1.286
    (`src/agents/claudeCode.js`), including `--bare`: auth strictly from `ANTHROPIC_API_KEY`, no
    OAuth or keychain.

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
    after a model call as an alert, not a silent retry. **This is why provider-side budgets are
    MANDATORY in Lot 3 (§6):** they are the only cap that holds even if our ledger under-counts.
  - **Pending runs (finding, Lot 2b):** GitHub keeps at most **one pending** run per concurrency
    group. A newer queued run **cancels** the older pending one.
    - Today `concurrency` is set at workflow level in `orchestrator.yml`, so PR-CI-triggered
      orchestrator runs also enter the group, even though their job is then skipped. They can cancel
      a pending real ingest run.
    - So can a long reviewer wait in Lot 3 (approval held while other CI runs complete).
    - A cancelled run means a lost `workflow_run` event: no double spend, but the loop stalls
      until reconcile or a re-run.
    - **Recommendation for Lot 3, not changed here:** move `concurrency` to the `ingest` job
      (skipped jobs then never enter the group), and add the planned watchdog (reconcile on stall).
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
2. Create the dedicated OpenAI project and Anthropic workspace and create the two keys.
3. **MANDATORY: set the provider-side budgets** (OpenAI project budget, Anthropic workspace spend
   limit), at or below `daily_spend_cap_usd` × 30. Lot 3 does not start without them. They are
   the only cap that still holds if our ledger under-counts (§4a residual risk).
4. Create the GitHub environments `agents-planner` (secret `OPENAI_API_KEY`) and `agents-worker`
   (secret `ANTHROPIC_API_KEY`). Both: branches `main` only, required reviewer: you (stays on
   for all of Lot 3; removing it is a later decision).
5. Set real numbers in `config/agent-limits.json` (`_PRODUCT_OWNER_SETS_IN_LOT3`): the real
   prices for the models you choose, the daily cap and the per-call cap. Merge via PR.
6. Approve one exempt file, `src/agents/live.js` (live transport + `claude` runner). The call path
   is already async (Lot 2b), so it needs no bridge.
7. First supervised run: one task, with the reviewer gate on.
