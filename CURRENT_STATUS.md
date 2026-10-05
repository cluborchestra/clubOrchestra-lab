# CURRENT_STATUS — clubOrchestra-lab

**Updated:** 2026-10-05 · **Tasks:** CO-P1-001, CO-P2a-001, CO-P2b-001, CO-P3-LOT1-001, CO-P3-LOT2-001, CO-P3-LOT2B-001 · **Phase:** P3 Lot 2b (async call path, verified worker flags; no live calls)
Tags: PLANNED / IMPLEMENTED / TESTED / E2E_VERIFIED / DISABLED (spec §8).
TESTED = covered by an automated test in `test/` that passes with `npm test`.

**P1 control plane: IMPLEMENTED + TESTED.** QA accepted CO-P1-001 on 2026-10-04. Its tests also
pass on GitHub Actions (CI run 37355805656), and the live P2b run below used it end to end.

| # | Capability | Status | Where | Proof |
|---|---|---|---|---|
| 1 | Scaffold: state.json, event intake, processed_events.json, audit JSONL, approvals/ | TESTED | `src/store.js`; on GitHub: branch `orchestra-state` | all tests run on a fresh scaffold |
| 2 | State machine, only legal transitions; illegal rejected + logged | TESTED | `src/states.js` | `state machine: illegal transition…` |
| 3 | Envelope validation, fail closed → BLOCKED / NEEDS_HUMAN | TESTED | `src/events.js` | `fail closed: event missing "<field>"` ×11, unparseable, wrong project/type |
| 4 | Idempotency (`processed_events.json`) | TESTED | `src/controlPlane.js` | `idempotency: …` ×2 |
| 5 | Single-writer: lease file + optimistic version lock | TESTED | `src/store.js` | `single-writer: …` ×3 (incl. 6 real OS processes racing) |
| 6 | Circuit breaker (N=3) → BLOCKED + escalation record | TESTED | `src/controlPlane.js` | `circuit breaker: …` ×2 |
| 7 | Approval gate stops + resumes; denied → BLOCKED | TESTED | `src/controlPlane.js`, `src/policy.js` | `approval gate: …` ×2 |
| 8 | Simulated planner + worker (deterministic, offline) | TESTED | `src/sim/` | used by every control-plane test |
| 9 | Happy path: 2 tasks → COMPLETE, exact-SHA verified, no human "continue" | TESTED | `src/controlPlane.js` | `happy path: …`, `exact-SHA: …` ×2 |
| 10 | Audit log: every transition (event_id, task_id, actor, from→to, ts) | TESTED | `src/store.js` | `audit: …`; samples in `docs/evidence/` |
| 11 | Offline / zero cost / no secrets | TESTED | — | `offline: …` static guard on `src/` |
| — | Untrusted payload / handoff cannot alter control logic | TESTED | `src/events.js`, `src/policy.js` | `untrusted: …` ×2 |
| — | Real agents (OpenAI planner, Claude worker) | PLANNED | — | P3 Lot 3, needs Product Owner approval + spend cap |

## P2a — GitHub loop, proven locally (CO-P2a-001)

**P2a: IMPLEMENTED + TESTED (local) — NOT E2E_VERIFIED.** Nothing has run on GitHub.

| # | Capability | Status | Where | Proof (`test/p2a-github-loop.test.js`) |
|---|---|---|---|---|
| 1 | Adapter: `workflow_run` → `ci.completed` envelope | TESTED | `src/adapters/github.js` | `adapter: …` ×4 |
| 2 | Adapter idempotency: `event_id = gh-run-<runId>-<runAttempt>`; redelivery = no-op | TESTED | `src/adapters/github.js` | `adapter idempotency: …` ×2 |
| 3 | Exact-SHA gate: sha ≠ pending / head moved / CI before worker → no work, logged stale | TESTED | `src/controlPlane.js`, `src/gitRefs.js` | `exact-SHA: …` ×3 |
| 4 | Reconcile after restart (git head + durable state), no repeated work | TESTED | `src/controlPlane.js` (`reconcile`, `resume`) | `reconcile: …` ×4 |
| 5 | Workflow files: `ci.yml` + `orchestrator.yml` with `concurrency` | IMPLEMENTED (files only) | `.github/workflows/` | static checks moved to `test/p2b-github-wiring.test.js`; **never executed** |
| 6 | Local harness: whole chain offline, no human "continue" | TESTED | `harness/` | `full local chain: …`, `deterministic: …` |
| — | CI failure + planner-review rejection go through the circuit breaker | TESTED | `src/controlPlane.js` | `CI failure …`, `planner review REJECT …` |
| — | `ingest` CLI (what the orchestrator workflow runs) | TESTED | `src/cli.js`, `src/ingest.js` | `cli ingest: …` |
| 7 | Full suite green (now 120: P1 31 + P2a 19 + P2b 5 + P3 Lot 1 16 + P3 Lot 2 35 + escalation 14) | TESTED | — | `npm test` |
| 8 | Offline: no network modules; harness spawns only local `git` | TESTED | — | `offline: …` ×2 |

## P2b — GitHub wiring + first live run (CO-P2b-001)

Repo: https://github.com/cluborchestra/clubOrchestra-lab (public). `main` = `1597f1b`, the merge of
PR #1. It was a merge commit, so the P1/P2a/P2b SHAs are preserved. `main` is protected.
`ORCHESTRATOR_ENABLED=true`.

### Review-Dispatch Loop (P4 milestone / áfangi P4) on real GitHub: E2E_VERIFIED with simulated workers (2026-10-05)
One task (`CO-SIM-001`), simulated worker, no API keys, no cost. The run was:

- push to `co/`
- CI (`push`)
- `workflow_run`
- orchestrator
- exact-SHA + branch-head gate
- planner review
- task complete
- next task dispatched
- state committed to `orchestra-state` by the workflow

No human "continue" anywhere in that chain. Full evidence:
[docs/evidence/p2b_live_run.md](docs/evidence/p2b_live_run.md).

| Proof | Status | Evidence |
|---|---|---|
| Stale-SHA CI result → no work (logged `event_stale`) | **E2E_VERIFIED** | CI 37357864409 → orchestrator 37357891383 → state `88bd4aa` |
| CI on the exact pending sha → CO-SIM-001 complete, CO-SIM-002 dispatched to `outbox/`, state committed by the workflow | **E2E_VERIFIED** | CI 37358003409 → orchestrator 37358037144 (attempt 1) → state `66cee56` |
| Duplicate delivery of the same `workflow_run` → no-op | **VERIFIED (dry-run)**; live re-run **DEFERRED** | Same `ingest` command on a copy of the live state gives `duplicate_event_ignored`; also unit/harness tests. The live re-run of orchestrator **37358037144** failed twice (attempts 2 and 3) during a **GitHub Actions hosted-runner incident** ("job was not acquired by Runner of type hosted" / "Internal server error"). The job never started, and nothing was written. |

**To finish later:** on run **37358037144**, click **Re-run all jobs**. Expected: one new state commit
with a single `duplicate_event_ignored` for `gh-run-37358003409-1`, `version` 6→7,
`inbox_cursor` 3→4, nothing else changed.

**Name and scope:** the core loop is called the **Review-Dispatch Loop (P4 milestone)**: CI → orchestrator
→ planner review → dispatch of the next task, with no human "continue". This run verified its
mechanism on real GitHub with **simulated** workers. P4's acceptance in the spec (≥2 tasks in a row,
starting from a goal, with **real** agents) is still PLANNED: it needs P3 Lot 3 first.

### Wiring
| Item | Status | Where / proof |
|---|---|---|
| Adapter ignores CI from non-`co/` branches (PR CI can't block the loop) | TESTED | `src/adapters/github.js`; `test/p2b-github-wiring.test.js` |
| Orchestrator on the state-branch pattern (`orchestra-state`, never pushes to `main`) | E2E_VERIFIED | 2 state commits pushed by the workflow; `main` untouched |
| Orchestrator gate: `vars.ORCHESTRATOR_ENABLED == 'true'` + push-CI + own repo | TESTED (static) | `orchestrator: disabled unless …` |
| Actions pinned to commit SHAs (checkout v4.4.0, setup-node v4.4.0) | E2E_VERIFIED | all live runs resolved them |
| `data/` only on `orchestra-state` | IMPLEMENTED | `.gitignore`, branch `orchestra-state` |
| `orchestra-state` intact after the failed re-runs | VERIFIED | tip `66cee56`, v6, files consistent, no lock/tmp files, 0 runs queued/in progress |
| Wire dispatch: `outbox/<task>.json` → `repository_dispatch` → worker workflow | PLANNED | P3 territory |
| Watchdog `schedule` workflow (stall → reconcile, never a 2nd writer) | PLANNED | — |
| Required status check `test` on `main` | OWNER (GitHub UI) | optional hardening |

**Current live state:** `WAITING_EVENT`, waiting for the worker on `CO-SIM-002` (written to `outbox/`;
nothing executes it). This is the accepted stopping point.

## P3 Lot 1 — agent adapters + spend/rate controls (CO-P3-LOT1-001)

**P3 Lot 1: IMPLEMENTED + TESTED (local).** Real agents are **NOT wired**: there are no API calls,
no keys and no cost. Lot 2 and Lot 3 are pending. Nothing in this lot touches the orchestrator,
the workflows or `orchestra-state`.

| # | Capability | Status | Where | Proof (`test/p3-lot1-agents.test.js`) |
|---|---|---|---|---|
| 1 | `PlannerAdapter` / `WorkerAdapter` boundary; sims, outbox/git workers and mock model agents implement it; handoff schema unchanged (moved verbatim to `src/handoff.js`) | TESTED | `src/agents/adapter.js`, `src/handoff.js` | `contract: …` ×4 |
| 1 | No behaviour change: the mock agents run the P1 loop and the P2 local GitHub loop identically to the sims | TESTED | `src/agents/modelAgents.js`, `src/agents/mock.js` | `mock agents drive the P1 loop …`, `mock planner in the P2 local GitHub loop …`; all 55 earlier tests unchanged |
| 2 | Spend/rate guard checked **before** every call: `max_calls_per_task`, `daily_spend_cap_usd`, `per_call_max_usd`, unpriced model, provider not enabled → BLOCKED + escalation (fail closed) | TESTED | `src/agents/spendGuard.js` | `max_calls_per_task: …`, `daily_spend_cap: …` ×2, `per-call cap, unpriced model and real providers …` |
| 3 | Loop detector: identical worker output for the same task → circuit breaker tripped | TESTED | `src/agents/spendGuard.js`, `src/controlPlane.js` (`_halt`) | `loop detector: …` ×2 |
| 4 | Caps in `config/agent-limits.json`, conservative defaults (mock only, 0 USD caps), `_PRODUCT_OWNER_SETS_IN_LOT3` block; invalid config or `mode: real` refused | TESTED | `config/agent-limits.json`, `src/agents/limits.js` | `config: …` |
| 5 | Secrets plan (key names, GitHub environment secrets, least privilege, never logged) | DOCUMENTED ONLY | `SECURITY_MODEL.md` | nothing set |
| — | Untrusted model output: malformed → BLOCKED; extra fields dropped; review needs an exact `ACCEPT`; approval gate holds | TESTED | `src/agents/modelAgents.js` | `untrusted output: …` ×2, `contract: extra fields …` |
| — | Spend ledger stores counts, tokens, cost and hashes only, never prompts or outputs | TESTED | `src/agents/spendGuard.js` | `ledger records …` |

### Still to do
- **Lot 2:** done, see the next section.
- **Lot 3: arm real agents. Costs money, needs Product Owner approval.**
  - The real clients get their keys from the GitHub environments `agents-planner` / `agents-worker` (see `SECURITY_MODEL.md`).
  - Product Owner sets the real caps and prices in `config/agent-limits.json`, and sets
    provider-side budgets.
  - Allow `mode: real` in the loader.
  - Wire `outbox/` → `repository_dispatch` → a worker workflow.
  - First supervised one-task run.

## P3 Lot 2 — replay dry run with the real API shapes (CO-P3-LOT2-001)

**P3 Lot 2: IMPLEMENTED + TESTED (local).** This lot is replay only. Live mode is impossible: there
is no live transport or runner in the code, the loader refuses `mode: real`, and the guard refuses
any transport not marked as replay. There was no network traffic, no key was read, no `claude` was
run, and nothing was spent.

**Decisions applied:**
- **D-A:** production code stays zero-dependency. The `openai` SDK is a devDependency, used only as
  the test judge.
- **D-B:** the worker is Claude Code headless JSON.

**Dependency record (the one approved download):**
- `openai@7.28.0`, installed 2026-10-05 with
  `npm install --save-dev --save-exact --ignore-scripts openai`;
- `resolved https://registry.npmjs.org/openai/-/openai-7.28.0.tgz`;
- `integrity sha512-HSY4fFLflQGYe2kvO0atm6/GzhD61gpyiOZZUvO4nptMUhuB1to2K3wwFpFqc5gfEK0SxyIIFiu1yE2MtygWcA==`;
- no transitive packages. Its optional peers (AWS/Smithy/ws/zod) are not installed and not used.
- CI runs `npm ci --ignore-scripts` before `npm test`.

| # | Case | Status | Proof |
|---|---|---|---|
| — | Planner adapter: raw HTTP to `POST /v1/responses` (strict `json_schema`, `store:false`) via an **injected transport**; no Authorization header | TESTED | `src/agents/openaiResponses.js`; SDK judge: `golden request …` ×2 |
| — | Worker adapter: `claude -p --output-format json` invocation via an **injected runner**; cost = `total_cost_usd` | TESTED | `src/agents/claudeCode.js` |
| — | Fixtures: 14 OpenAI + 8 Claude Code, each with a header (date, SDK version, "hand-authored, not captured live"); OpenAI ones checked against SDK parsing and error classes | TESTED | `test/fixtures/lot2/`; `test/p3-lot2-sdk-judge.test.js` (16) |
| 1 | Happy path → planner ACCEPT ×2 → COMPLETE, no "continue" | TESTED | `test/p3-lot2-replay.test.js` #1 |
| 2 | Planner REJECT → reason fed back to the planner → new attempt passes within limits | TESTED | #2 |
| 3 | Malformed JSON / schema violation (planner and worker) → fail closed, billed cost booked | TESTED | #3 |
| 4 | `incomplete` / `max_output_tokens` → halt, no retry | TESTED | #4 |
| 5 | Refusal → halt | TESTED | #5 |
| 6 | 429 + retry-after → waits exactly that long and retries; beyond `max_retry_after_s` → halt without waiting | TESTED | #6 |
| 7 | 5xx / timeout → bounded retries (2, backoff 1s/2s) then halt; recovery; 401 never retried; worker timeout; worker `is_error` subtypes; missing cost → `COST_UNKNOWN` | TESTED | #7, #7b, #7c |
| 8 | Spend cap reached mid-loop → refused before the call, reason recorded | TESTED | #8 |
| 9 | Loop detector → halt (breaker tripped) | TESTED | #9 |
| 10 | Token accounting: usage × FAKE price table, and reported `total_cost_usd`, = expected spend | TESTED | #10 |
| 11 | Only a push to `co/**` drives the loop. The three filter layers are quoted from the files: `ci.yml` triggers, orchestrator job `if:`, adapter branch filter | EVIDENCE | #11 (static) |
| 12 | Spend survives restarts: every step as a fresh instance still stops at the cap | TESTED | #12 |
| 13 | Concurrent processes cannot jointly overshoot the cap (ledger lock + reservation) | TESTED | #13 |
| — | Network trap armed for the **whole suite**; API keys never read even when present; live transport refused | TESTED | `test/support/no-network.js` via `test/helpers.js`; 3 safety tests |

**PM questions:**
- **Q1, where `spent_usd_today` lives:** `<state>/spend/ledger.json`, which on GitHub is
  `orchestra-state`, committed with the state. It persists across Actions runs (test 12).
  Concurrent spenders on one host are excluded by the lock + reservation (test 13). Across runs,
  the orchestrator's `concurrency` group serialises them. See `SECURITY_MODEL.md` §4a, which also
  covers the residual risk of a rejected push.
- **Q2, `failure_count` 3 after 2 worker calls:** intentional. A repeated output trips the breaker
  (`SECURITY_MODEL.md` §4b).
- **Q3, the day boundary:** UTC; the daily cap resets at 00:00 UTC (tested; documented in
  `config/agent-limits.json` and `SECURITY_MODEL.md` §4a).

**Also changed in Lot 2:**
- Spend is reserved before each call and settled after it (it was booked after the call in Lot 1).
- The planner gets `last_failure` as feedback (new state field `last_failure`, ignored by the sims).
- The review reason appears in the rejection message.
- `AgentPlanner.review()` returns `{ verdict, reason }`.
- `SECURITY_MODEL.md` §2 is corrected: the planner key goes to the orchestrator's `ingest` job
  (environment `agents-planner`), and the worker key goes only to the worker job
  (`agents-worker`).
- Lot 1 tests: three assertions were updated for the new APIs (`record(ticket, …)`, the
  `reserved_usd` entry field, the review `reason`). They are as strict as before.

## P3 Lot 2b — async call path + verified worker flags (CO-P3-LOT2B-001)

**P3 Lot 2b: IMPLEMENTED + TESTED (local).** Real agents are still not wired. There was no network
traffic, no key was read and no model was called.

| # | Item | Status | Where / proof |
|---|---|---|---|
| 1 | **Async call path** instead of a sync bridge, so the first paid run tests one new thing (live I/O). Covers `ControlPlane` (`step/run/start/transition/humanReset/reconcile/resume`), `callModel`, the adapters, the OpenAI/Claude clients, the replay transport/runner, the harness and the CLI. Sims stay synchronous (awaiting a plain value is a no-op). Behaviour is unchanged: all 106 tests pass, and the local harness and CLI demo give the same SHAs as before. | TESTED | `src/controlPlane.js`, `src/agents/*`; no un-awaited calls in tests (checked) |
| 2 | **Worker flags verified** against `claude --help` of **Claude Code 2.1.286** (the desktop app's bundled CLI; only `--version`/`--help` were run). `--allowedTools` = "comma or space-separated". `--max-turns` is **not** in 2.1.286's help, so it was removed. It is replaced by `--max-budget-usd <per_call_max_usd>` (a hard per-run dollar cap), plus `--bare` and `--permission-prompts none`. | VERIFIED (help text) | `src/agents/claudeCode.js`; `runs/claude-help-2.1.286.txt` (local, sha256 13dd71866e4b6fde…) |
| 3 | **Environments vs. real branches:** `workflow_run` (orchestrator) and `repository_dispatch` (worker) both run on the default branch (`github.ref = main`), so the `main`-only rule matches. The required reviewer stays on for all of Lot 3 and stops automation; removing it is a later decision by Ási. | DOCUMENTED | `SECURITY_MODEL.md` §2 |
| 4 | **Provider budgets are MANDATORY** in the Lot 3 checklist (because of the §4a ledger risk) | DOCUMENTED | `SECURITY_MODEL.md` §6 item 3 |
| 5 | **Escalation rule in code:** every dispatch decision is AUTO or OWNER (cost/scope/access/irreversible/security/uncertain). The policy floor can only be raised by the planner, and an unclassifiable decision is OWNER. OWNER writes an approval request and a GitHub Issue request assigned to `cluborchestra`, and the loop waits. The orchestrator opens the issue with `gh` + `GITHUB_TOKEN` (`issues: write`, no new secret). The planner's plan schema carries `decision`. | TESTED (14) | `src/escalation.js`, `src/ownerIssues.js`, `test/p3-escalation.test.js`; workflow step static-tested, not yet run live |
| 6 | Icelandic project documents v1.0: summary (purpose verbatim), functional description, work plan | DONE | `docs/clubOrchestra_*_v1.0.md` |
| — | **Finding:** workflow-level `concurrency` keeps only one pending run, and skipped (PR-CI) orchestrator runs also enter the group, so a pending real ingest can be cancelled (lost event, no double spend). Recommended for Lot 3: job-level concurrency + the watchdog. Not changed here. | OPEN | `SECURITY_MODEL.md` §4a |

Full worker invocation (`config/agent-limits.json`, `per_call_max_usd` from the active limits):

```
claude -p --bare --output-format json --max-budget-usd <per_call_max_usd> --permission-prompts none \
  --allowedTools "Read,Edit,Write,Bash(npm test),Bash(git status),Bash(git diff *),Bash(git add *),Bash(git commit *)" \
  --append-system-prompt "<WORKER_SYSTEM>"     (handoff on stdin)
```

### Backlog (not started)
- **B1 Owner notifications:** on BLOCKED, on "approval needed", or at >80% of the daily cap, open a
  GitHub Issue assigned to `cluborchestra` (GitHub emails `orchestra@`). Uses `GITHUB_TOKEN`, no
  new secret. Never `netoryggi@` or `p9@`. *Partly done in Lot 2b:* OWNER decisions already open
  issues. BLOCKED and the 80% alert remain.
- **B3** approval through the issue itself (a label or comment from `cluborchestra`) instead of
  editing the approval file.
- **B2 `OWNER_CARD.md`:** one plain-language page for the owner after a long break: kill switch,
  approvals, where to see the state, key rotation.

## Known limitations

- `state.lock` + `version` is the local lock. On GitHub, `orchestrator.yml` adds Actions
  `concurrency` and a non-forced push to `orchestra-state` (rejected if that branch moved). Both
  were used in the live run. A race between two orchestrator runs has not been provoked live.
- `processed_events.json` is written right after `state.json` under the same lease. A crash between
  the two can let an event be re-read; it is then stale (no longer the current task) and ignored.
- The sim worker keeps its attempt counter in memory. Across separate CLI invocations a retried
  task re-emits the same `event_id`, which is (correctly) treated as a duplicate, so the loop waits
  instead of progressing. Fail-safe, sim-only; the real worker in P3 produces unique event ids.
- Without `requireCi` (P1 mode) only `task.completed` drives transitions; with `requireCi` (P2)
  `ci.completed` does too. Other valid event types are logged and ignored.
- P2a: a CI result that arrives *before* the worker's result is logged stale and dropped. With
  real timing (CI takes minutes) this is unlikely. The worker result is still accepted, and the
  control plane then waits for CI on that sha. A CI re-run (new `run_attempt`, so a new event_id)
  completes it. Requesting that re-run automatically belongs to the P2b watchdog.
- P2a: `adopt_commit` trusts any new head on `co/<task>` as the candidate. It does not verify
  ancestry from `expected_sha` (no git binary in `src/`). CI + planner review still gate it.
  P2b can add a `git merge-base --is-ancestor` check in the workflow.
- P2a: `reconcile` never re-dispatches. If the control plane crashed after committing a dispatch
  but before the worker started, the task waits (`no_commit_yet`) until the P2b watchdog or a
  human re-dispatches it.
- P2a tests and the harness need the local `git` binary (offline; system/global config disabled).
- CO-SIM-002's handoff in `outbox/` says `"repo": "clubOrchestra-lab"` rather than
  `cluborchestra/clubOrchestra-lab`: the `ingest` CLI creates the sim planner without the full repo
  name. Cosmetic; fix in a later PR.
- Unauthenticated GitHub API checks are limited to 60 requests/hour; poll sparingly.
- P3 Lot 1: the spend ledger is written by the agent adapters at call time, outside the state
  commit. That is deliberate: a call that happened is booked even if the state commit then loses
  an optimistic-lock race. Two concurrent writers could still race on the ledger file itself. On
  GitHub the orchestrator's `concurrency` group prevents this; Lot 3 should keep agent calls under
  that same group.
- P3 Lot 1: pre-call estimates use `max_output_tokens` for output (worst case). With the default
  mock pricing everything is 0 USD; real accuracy is a Lot 2 item.
- P3 Lot 2: the fixtures are hand-authored from the documented formats. The OpenAI ones are
  checked against `openai@7.28.0` parsing and error classes. The `--allowedTools` syntax and the flags
  we use are now verified against `claude --help` 2.1.286 (Lot 2b). The Claude Code **output**
  shape and exit codes are not verified, because `claude -p` is still forbidden; Lot 3's first run
  confirms them.
- P3 Lot 2: the worker output must be a bare JSON object. If real Claude Code wraps it in prose or a
  code fence, it fails closed (`INVALID_OUTPUT`); Lot 3 may need a strict extractor.
- P3 Lot 2: the planner token estimate is about 3 bytes per token plus 32, which is deliberately
  conservative. Real usage replaces it after each call.
