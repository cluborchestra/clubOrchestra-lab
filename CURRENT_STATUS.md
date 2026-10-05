# CURRENT_STATUS — clubOrchestra-lab

**Updated:** 2026-10-05 · **Tasks:** CO-P1-001, CO-P2a-001, CO-P2b-001 · **Phase:** P2b done (core loop live on GitHub, simulated worker)
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
| — | Real agents (OpenAI planner, Claude worker) | PLANNED | — | P3, needs Product Owner approval + spend cap |

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
| 7 | Full suite green (now 55: P1 31 + P2a 19 + P2b 5) | TESTED | — | `npm test` |
| 8 | Offline: no network modules; harness spawns only local `git` | TESTED | — | `offline: …` ×2 |

## P2b — GitHub wiring + first live run (CO-P2b-001)

Repo: https://github.com/cluborchestra/clubOrchestra-lab (public). `main` = `1597f1b`, the merge of
PR #1. It was a merge commit, so the P1/P2a/P2b SHAs are preserved. `main` is protected.
`ORCHESTRATOR_ENABLED=true`.

### Core loop on real GitHub: E2E_VERIFIED (2026-10-05)
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

**Scope note:** this run proves on real GitHub the core loop mechanism that spec P4 builds on. Spec P4
itself (≥2 tasks in a row, starting from a goal, with real agents) is still PLANNED, because it needs
P3 (real agents) first.

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
