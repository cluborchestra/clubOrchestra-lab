# CURRENT_STATUS — clubOrchestra-lab

**Updated:** 2026-10-04 · **Tasks:** CO-P1-001, CO-P2a-001, CO-P2b-001 · **Phase:** P2b (GitHub wiring; no real run yet)
Tags: PLANNED / IMPLEMENTED / TESTED / E2E_VERIFIED / DISABLED (spec §8).
TESTED = covered by an automated test in `test/` that passes with `npm test`.

**P1 control plane: IMPLEMENTED + TESTED (local) — NOT E2E_VERIFIED.** QA accepted CO-P1-001
on 2026-10-04 (local only; no remote, CI or PR yet — repo creation is OWNER_APPROVAL_REQUIRED).

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

## P2b — GitHub wiring (CO-P2b-001)

Repo: https://github.com/cluborchestra/clubOrchestra-lab (public, approved by Product Owner).
**P2b: IMPLEMENTED + TESTED (local) — NOT E2E_VERIFIED.** No Actions run has happened.

| Item | Status | Where / proof |
|---|---|---|
| Remote added; `main` = P1 (`7799664`); feature branches + `orchestra-state` pushed | IMPLEMENTED | git remote `origin` |
| Adapter ignores CI from non-`co/` branches (PR CI can't block the loop) | TESTED | `src/adapters/github.js`; `test/p2b-github-wiring.test.js` |
| Orchestrator wired to the state-branch pattern (`orchestra-state`, never pushes to `main`) | TESTED (static) | `.github/workflows/orchestrator.yml`; `orchestrator: state-branch pattern …` |
| Orchestrator DISABLED: job gated on `vars.ORCHESTRATOR_ENABLED == 'true'` + push-CI + own repo | TESTED (static) | `orchestrator: disabled unless …` |
| Actions pinned to commit SHAs (checkout v4.4.0, setup-node v4.4.0) | TESTED (static) | `workflows: actions pinned …` |
| `data/` removed from code branches; state only on `orchestra-state` | IMPLEMENTED | `.gitignore`, branch `orchestra-state` |
| `main` set as default + branch protection | OWNER (GitHub UI) | settings checklist in the PR description |
| P2b PR into `main` | OWNER (GitHub UI) | no authenticated GitHub API/CLI on this machine |
| First real run (set `ORCHESTRATOR_ENABLED=true`, push a `co/` branch) | OWNER_APPROVAL_REQUIRED | → E2E_VERIFIED only after it runs |
| Wire dispatch: `outbox/<task>.json` → `repository_dispatch` → worker workflow | PLANNED | after first real run |
| Watchdog `schedule` workflow (stall → reconcile, never a 2nd writer) | PLANNED | after first real run |

Nothing is E2E_VERIFIED yet.

## Known limitations

- `state.lock` + `version` is the local lock. On GitHub, `orchestrator.yml` adds Actions
  `concurrency` and a non-forced push to `orchestra-state` (rejected if that branch moved). This
  is authored but not yet exercised.
- `orchestra-state` starts from the generic scaffold (`last_verified_sha` = 40 zeros, `branch: main`).
  Before the first real run it must be initialised with the real `main` sha; that is part of the
  first-run approval.
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
