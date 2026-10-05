# clubOrchestra-lab

clubOrchestra control plane with simulated workers.

- **P1:** the safety spine: state machine, idempotency, single-writer, fail-closed, circuit
  breaker, approval gate, audit.
- **P2a:** the GitHub loop proven **locally**. A CI `workflow_run` result becomes an event,
  exact-SHA gating applies, duplicate and stale events are no-ops, and the control plane
  reconciles after a restart.
- **P2b:** wired to GitHub: https://github.com/cluborchestra/clubOrchestra-lab (public). State
  lives on the orphan branch `orchestra-state`. The orchestrator workflow is **disabled** until
  the Product Owner enables it. First live run done: see CURRENT_STATUS.
- **P3 Lot 1:** agent-adapter boundary + spend/rate safety controls, with **mock** model agents.
  No real API, no keys, no cost. Secrets plan: [SECURITY_MODEL.md](SECURITY_MODEL.md).

Canonical spec: [clubOrchestra_verkefna_og_vinnuplan_v0.1.md](clubOrchestra_verkefna_og_vinnuplan_v0.1.md).
Status per feature: [CURRENT_STATUS.md](CURRENT_STATUS.md).

**Fully offline and free:** Node.js ≥ 22, zero dependencies (no `npm install`), no network,
no secrets, no API keys. Planner and worker are deterministic stubs. The P2a tests and harness
also need the local `git` binary. They run it only inside scratch repos under `.tmp-test/` /
`runs/`, with system and global git config disabled.

## Run

```bash
npm test
```

```bash
node src/cli.js demo
```

Happy path: the sim planner issues 2 tasks, the sim worker returns PASS evidence, the control
plane verifies exact SHA + evidence each time and reaches `COMPLETE` with no human "continue".
Prints final state and the audit log. Writes to `runs/demo/` (gitignored).

Approval gate, end to end:

```bash
node src/cli.js demo-approval
```

```bash
node src/cli.js approve runs/demo-approval CO-SIM-003.deploy --by <your-name>
```

```bash
node src/cli.js run runs/demo-approval --plan approval
```

### P2a: local GitHub loop

```bash
node harness/run-local-loop.js
```

Full chain, offline. The sim worker commits on `co/<task_id>` in a scratch git repo. Sim CI
emits a GitHub-shaped `workflow_run` payload, delivered **twice** like a GitHub retry. The
adapter turns it into a `ci.completed` event. The control plane checks the exact SHA and the
branch head (read from `.git`), the sim planner reviews it, the next task is dispatched, and the
run reaches `COMPLETE`. Prints a sample payload, the derived event, the audit trail and the
result. Writes to `runs/local-loop/`.

```bash
node harness/run-local-loop.js --crash
```

Same chain, but the control plane crashes right after task 1's commit, so the worker's result
is lost. A fresh instance runs `resume()`: it drains the durable inbox, reconciles against the
git head, adopts the existing commit instead of re-running the task, and finishes.

Other commands: `init <dir>`, `status <dir>`, `deny <dir> <approval_id> --by <name>`,
`reset <dir> --by <name>` (human-only BLOCKED → IDLE),
`ingest <dir> <workflow_run.json> --git-dir <path> [--repo owner/name]` (what the orchestrator
workflow runs).

## Layout

```
src/
  states.js        state machine: 7 states, explicit legal-edge table
  policy.js        control policy (allowed actions, approval-required actions, breaker N=3)
  events.js        event envelope validation + worker evidence verification
  store.js         files on disk: state.json, lease (state.lock), processed_events.json,
                   events/inbox.jsonl, audit/audit.jsonl, approvals/, escalations/
  controlPlane.js  the loop: step() = read -> decide -> optimistic commit -> audit -> side effects
  sim/planner.js   deterministic planner stub (canned to-worker handoffs)
  sim/worker.js    deterministic worker stub (canned task.completed events)
  adapters/github.js  GitHub workflow_run payload -> ci.completed event (event_id = gh-run-<id>-<attempt>)
  ingest.js        adapter -> intake (shared by CLI and harness)
  gitRefs.js       reads branch heads straight from .git files (no git binary)
  outboxWorker.js  dispatch-by-file worker for the Actions path (outbox/<task_id>.json)
  handoff.js       the handoff schema (to-worker fields, from-worker result) shared by everyone
  agents/          P3: adapter.js (PlannerAdapter/WorkerAdapter), modelAgents.js (AgentPlanner/
                   AgentWorker), spendGuard.js (caps + loop detector), limits.js, mock.js, errors.js
  cli.js           offline CLI
harness/           P2a local loop: scratch git repo, git-committing sim worker, sim CI, event pump
.github/workflows/ ci.yml (CI placeholder), orchestrator.yml (workflow_run -> ingest; concurrency)
                   orchestrator gated off by repo variable ORCHESTRATOR_ENABLED (see below)
config/            agent-limits.json: spend/rate caps (conservative defaults; PO sets real numbers)
test/              node:test suites (no dependencies)
data/              local only (gitignored); `node src/cli.js init data` creates the scaffold.
                   On GitHub the state lives on branch orchestra-state (data/ only).
docs/evidence/     sample audit logs / state / approval record from simulated runs
```

## How it works

Each `step()` reads `state.json`, decides one move from the current state, and commits with an
optimistic lock: it must name the `version` it read and hold the lease file `state.lock`
(created with `O_EXCL`, owner + expiry). A writer that loses gets `STALE_VERSION` or
`LEASE_HELD` and must re-read. Audit entries and side effects (dispatching the worker, writing
an approval request or escalation) happen only after a successful commit.

| State | What a step does |
|---|---|
| `IDLE` | nothing; `start()` → `RUNNING` |
| `RUNNING` | asks planner; validates the handoff; policy gate → `WAITING_APPROVAL`, or dispatch → `WAITING_EVENT`; no more tasks → `COMPLETE` |
| `WAITING_EVENT` | consumes one inbox event: duplicate → no-op; invalid → `BLOCKED`; stale task/SHA → ignored; verified PASS → `RUNNING` (P1) or *awaiting CI* (P2); else `FAILED` |
| `FAILED` | retry (`RUNNING`) unless breaker tripped (then already `BLOCKED` + escalation) |
| `WAITING_APPROVAL` | `approvals/<id>.json` approved (with `approved_by`) → `RUNNING`; denied → `BLOCKED`; else stop |
| `BLOCKED` / `COMPLETE` | nothing; `BLOCKED` leaves only by human reset |

**Untrusted data:** event payloads and handoff content are only validated and compared with
values the control plane holds itself (expected SHA, current task id). Whether a task needs
approval comes from `policy.js` by action, never from the handoff. Tests prove that injected
fields like `requires_approval:false` or `"status":"COMPLETE"` in a payload change nothing.

### P2: CI-gated completion (`requireCi: true`)

Inside `WAITING_EVENT` the state records what it waits for: `awaiting: worker | ci`.

1. **Worker result** (`task.completed`), with evidence verified as in P1: records
   `pending_ci_sha` and waits for CI. This is not completion yet.
2. **CI result** (`ci.completed`, from the adapter). Each check below must pass, otherwise the
   result is logged as `event_stale` and nothing happens:
   - the control plane is awaiting CI;
   - the event is for the current task;
   - `sha === pending_ci_sha`;
   - the task branch head in the repo still equals that sha. If the head can't be read, the
     control plane goes to `BLOCKED` (fail closed).

   A CI failure goes through the circuit breaker.
3. **Planner review:** only an exact `{ verdict: 'ACCEPT' }` completes the task. Anything else
   counts as a failure.

`reconcile()` after a restart. It acts only once the inbox is drained and never re-dispatches
a worker:

| Situation | Decision |
|---|---|
| awaiting worker, task branch has a new commit | `adopt_commit`: wait for CI on that commit |
| awaiting worker, no commit | `no_commit_yet`: keep waiting |
| awaiting CI, head == pending sha | `consistent` |
| awaiting CI, head moved | `branch_moved` → `BLOCKED` / NEEDS_HUMAN |

## P2b: GitHub wiring

| Branch | Holds | Written by |
|---|---|---|
| `main` (protected, default) | code: P1 → P2a → P2b | PRs only |
| `co/<task_id>` | one task's work | the worker (simulated now, real in P3) |
| `orchestra-state` (orphan) | `data/` only: state, inbox, audit, approvals | the orchestrator only; never merged into `main` |

Flow on GitHub, once enabled:

1. A push to `co/<task>` runs **CI**.
2. When CI completes, a `workflow_run` event triggers the **Orchestrator**.
3. The Orchestrator checks out `main` (code) and `orchestra-state` (into `state/`).
4. It fetches the `co/*` heads and runs `node src/cli.js ingest state/data …`.
5. It does a plain (non-forced) push of `state/` to `orchestra-state`. If the branch moved, the
   push is rejected, which is the optimistic lock.

**Orchestrator off switch:** the `ingest` job runs only when all three hold:

- the repository variable `ORCHESTRATOR_ENABLED` is exactly `true`;
- the CI run came from a `push`, not a PR;
- the CI run belongs to this repo.

Unset (the default) means every trigger ends with the job skipped. Only the Product Owner
enables it.

CI runs on feature-branch PRs are ignored by the adapter: their branch isn't `co/`, so the result
is "not ours" and can't block the loop.

## P3 Lot 1: agent adapters + spend/rate controls (mock only)

Every planner and worker implements one interface (`src/agents/adapter.js`) and exchanges the
unchanged handoff schema (`src/handoff.js`):

| Interface | Implemented by |
|---|---|
| `PlannerAdapter`: `nextTask(view)`, `review(evidence)` | `SimPlanner`, `AgentPlanner` (model-backed) |
| `WorkerAdapter`: `execute(handoff)` | `SimWorker`, `OutboxWorker`, harness `GitWorker`, `AgentWorker` (model-backed) |

`AgentPlanner` and `AgentWorker` are shaped like the real agents will be. They take a *client*
(`estimate()` + `complete()`); in Lot 1 that is the deterministic `MockModelClient`. Every call
goes through these steps:

1. **`SpendGuard.check()` before the call.** It refuses the call when any of these hold:
   - the provider is not enabled (`REAL_AGENTS_DISABLED`);
   - the model has no price (`PRICING_UNKNOWN`);
   - `max_calls_per_task` is used up;
   - the per-call cap would be exceeded;
   - the daily cap would be exceeded.
2. **The call.**
3. **`SpendGuard.record()`.** It books the actual cost and runs the loop detector: the same
   worker output for the same task twice trips the circuit breaker.
4. **Strict JSON parse + schema whitelist** of the output.

Any refusal raises an `AgentHaltError`, and the control plane goes to **BLOCKED** with an
escalation record (fail closed).

Caps live in `config/agent-limits.json`. The defaults are closed: mode `mock`, `daily_spend_cap_usd: 0`,
`per_call_max_usd: 0`, and only `mock/mock-1` (free) is priced. The Product Owner sets real
numbers in Lot 3 (see `_PRODUCT_OWNER_SETS_IN_LOT3` in that file), via a reviewed PR. The spend
ledger is `<state dir>/spend/ledger.json`.

```bash
node --test test/p3-lot1-agents.test.js
```
