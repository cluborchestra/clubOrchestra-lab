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
| `OPENAI_API_KEY` | planner job only | OpenAI Responses API (planner) |
| `ANTHROPIC_API_KEY` | worker job only | Claude Code headless / Anthropic API (worker) |

- Stored only as **GitHub Actions environment secrets** in an environment named `agents`
  (Settings → Environments → `agents` → Environment secrets). They are not repository-wide
  secrets, never go in code or files, and are never in `orchestra-state`.
- Settings for the `agents` environment:
  - **Deployment branches: `main` only.** Jobs from other branches cannot read the keys.
  - **Required reviewer: the Product Owner**, for the first supervised Lot 3 runs. Each agent job
    waits for an explicit click. Removing the reviewer later (for the autonomous loop) is its own
    approval decision.
- Only the planner and worker jobs declare `environment: agents`. The orchestrator job (`ingest`)
  **never** gets the keys: it only moves events and state.
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
- Lot 3 implementation note: the offline guard test (`offline: …`) forbids `process.env` in `src/`.
  Real clients will live in one module (e.g. `src/agents/clients/`). The test gets a narrow,
  reviewed exception for that path only, allowing exactly the two key names above.

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
3. Create the GitHub environment `agents` (branches: `main`; required reviewer: you) and add the
   two environment secrets.
4. Set real numbers in `config/agent-limits.json` (`_PRODUCT_OWNER_SETS_IN_LOT3`) and merge via PR.
5. First supervised run: one task, with the reviewer gate on.
