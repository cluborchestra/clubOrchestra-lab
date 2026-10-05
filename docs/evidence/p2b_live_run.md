# P2b live run on GitHub — evidence (2026-10-05)

Repo https://github.com/cluborchestra/clubOrchestra-lab · `main` = `1597f1b55ebb77f5e2f72be4928f565d52320952`
One task (`CO-SIM-001`), simulated worker, no API keys, no cost. Approved by the Product Owner.

## Setup (B3-prep)
- `orchestra-state` @ `9c61986`: the baseline `last_verified_sha` is main `1597f1b`.
  - CO-SIM-001 was dispatched to `outbox/`, and the simulated worker's result was recorded.
  - The control plane was left waiting for CI on exactly `d59516afd4ea199bf3f7232772eda3d5b88950b9`.
- `co/CO-SIM-001` holds two commits:
  - `895ee6399c0297b8888279ddd65b62e189a19174`: a stale-SHA probe;
  - on top of it, `d59516afd4ea199bf3f7232772eda3d5b88950b9`: the result. The test suite passes
    55/55 at this commit.

## Runs
| Step | Push | CI run | Orchestrator run | State commit | Outcome |
|---|---|---|---|---|---|
| 1 stale probe | `895ee63` | 37357864409 (push, success) | 37357891383 (success) | `88bd4aa76ac57ee92a073b0189c38b31da5b3cad` | `event_stale`: sha 895ee63… is not pending_ci_sha d59516a…; no work |
| 2 real result | `d59516a` | 37358003409 (push, success) | 37358037144 attempt 1 (success) | `66cee561d3821a758af332aa11af2b26e1be19db` | planner ACCEPT → CO-SIM-001 complete → CO-SIM-002 dispatched |
| 3 duplicate | — | — | 37358037144 attempts 2 and 3 (failure) | none | GitHub hosted-runner incident; the job never started; DEFERRED |

## Step 1 state diff (`9c61986` → `88bd4aa`)
- **Changed:** `version` 3→4, `inbox_cursor` 1→2 and `last_event_id`. One audit line was added
  (`event_stale`, event `gh-run-37357864409-1`), and the event id was added to `processed_events.json`.
- **Unchanged:** `status WAITING_EVENT`, `awaiting ci`, `pending_ci_sha d59516a`, `failure_count 0`,
  `completed_tasks []`.

## Step 2 audit (`66cee56`)
```
planner_review ACCEPT       event gh-run-37358003409-1  task CO-SIM-001
WAITING_EVENT -> RUNNING    event gh-run-37358003409-1  "CI passed and planner accepted at d59516a…"
RUNNING -> WAITING_EVENT    task CO-SIM-002             "dispatched CO-SIM-002 to worker"
task_dispatched             task CO-SIM-002             starting_sha d59516a…
```
State after step 2: `version 6`, `completed_tasks ["CO-SIM-001"]`, `last_verified_sha d59516a…`,
waiting for the worker on `CO-SIM-002`.

## Duplicate test
- **Dry run:** the same `node src/cli.js ingest` was run on a copy of the B3 state, with GitHub-shaped
  payloads delivered as A′, then A, then A again. The results were `event_stale`, then completion,
  then `duplicate_event_ignored`.
- **Live:** re-running orchestrator 37358037144 delivers the identical payload (same event id
  `gh-run-37358003409-1`). Attempts 2 and 3 both failed before any step ran: "The job was not
  acquired by Runner of type hosted even after multiple attempts" / "Internal server error".
- **Checks after the failures:**
  - `orchestra-state` is still `66cee56` (v6), and all files parse;
  - the inbox has 3 lines, matching cursor 3 and 3 processed ids;
  - there is no `state.lock` or `.tmp` file;
  - 0 runs are queued or in progress.
- **To do:** re-run 37358037144 once Actions runners are healthy. Expected result: a single
  `duplicate_event_ignored`, `version` 6→7, `inbox_cursor` 3→4, nothing else changed.
