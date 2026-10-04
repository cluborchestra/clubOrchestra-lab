# clubOrchestra-lab

P1 of clubOrchestra: the **control plane with simulated workers**. It proves the safety spine
(state machine, idempotency, single-writer, fail-closed, circuit breaker, approval gate, audit)
before any real AI or GitHub events are wired in.

Canonical spec: [clubOrchestra_verkefna_og_vinnuplan_v0.1.md](clubOrchestra_verkefna_og_vinnuplan_v0.1.md).
Status per feature: [CURRENT_STATUS.md](CURRENT_STATUS.md).

**Fully offline and free:** Node.js ≥ 22, zero dependencies (no `npm install`), no network,
no secrets, no API keys. Planner and worker are deterministic stubs.

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

Other commands: `init <dir>`, `status <dir>`, `deny <dir> <approval_id> --by <name>`,
`reset <dir> --by <name>` (human-only BLOCKED → IDLE).

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
  cli.js           offline CLI
test/              node:test suites (no dependencies)
data/              committed empty scaffold (state.json IDLE, empty inbox/audit, approvals/)
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
| `WAITING_EVENT` | consumes one inbox event: duplicate → no-op; invalid → `BLOCKED`; stale task/SHA → ignored; verified PASS → `RUNNING`; else `FAILED` |
| `FAILED` | retry (`RUNNING`) unless breaker tripped (then already `BLOCKED` + escalation) |
| `WAITING_APPROVAL` | `approvals/<id>.json` approved (with `approved_by`) → `RUNNING`; denied → `BLOCKED`; else stop |
| `BLOCKED` / `COMPLETE` | nothing; `BLOCKED` leaves only by human reset |

**Untrusted data:** event payloads and handoff content are only validated and compared with
values the control plane holds itself (expected SHA, current task id). Whether a task needs
approval comes from `policy.js` by action, never from the handoff. Tests prove that injected
fields like `requires_approval:false` or `"status":"COMPLETE"` in a payload change nothing.
