# Evidence — CO-P3-LOT2B-001

**Dagsetning:** 2026-10-05 · **Grein:** `feat/co-p3-lot2b-async` · **Kóði:** `83e3762` (async + fánar) og `d0acf8f` (escalation + skjöl)
**Niðurstaða:** öll þrjú verkin eru búin. Prófasvítan er **120/120 græn**, offline. Ekkert módelkall,
enginn lykill, enginn kostnaður. Ekkert á `co/`, ekkert í `main`.
Skráin inniheldur engin leyndarmál (repo-ið er opið).

## Tilgangur
Skráður orðrétt í [docs/clubOrchestra_samantekt_verkefnis_v1.0.md](../docs/clubOrchestra_samantekt_verkefnis_v1.0.md) §1.
Til Ása fer eingöngu: kostnaður, umfang, aðgangur eða verk Ása, óafturkræft og öryggi/lyklar,
**og allur vafi**. Allt annað er sjálfvirkt.

## Verk 1: skjölun (íslenska, `docs/`)
| Skjal | Innihald |
|---|---|
| [clubOrchestra_samantekt_verkefnis_v1.0.md](../docs/clubOrchestra_samantekt_verkefnis_v1.0.md) | Tilgangur orðréttur, staða allra áfanga, lykilákvarðanir |
| [clubOrchestra_virknilysing_verkefnis_v1.0.md](../docs/clubOrchestra_virknilysing_verkefnis_v1.0.md) | Review-Dispatch Loop (áfangi P4), ástandsvél, escalation-reglan, kostnaðarvarnir, fail-closed |
| [clubOrchestra_verkefna_og_vinnuplan_v1.0.md](../docs/clubOrchestra_verkefna_og_vinnuplan_v1.0.md) | LOT 2b (lokið) → LOT 3 (röð og skyldur) → backlog |

README og CURRENT_STATUS nota heitið **„Review-Dispatch Loop (áfangi P4)“** og vísa í tilganginn.
Spec v0.1 er óbreytt.

## Verk 2: escalation-reglan í kóða
Hver dispatch-ákvörðun er **AUTO** eða **OWNER** (`src/escalation.js`).

- **Policy-gólf:** `spend`→cost, `enable_api_keys`→security og `deploy`→irreversible eru alltaf
  OWNER. Planner getur hert en aldrei mildað.
- **Planner flokkar:** `decision: {class, category, reason}` kemur í sama svari og verkið, og
  strict-skemað er útvíkkað. Það kostar ekkert aukakall.
- **Vafi = OWNER/uncertain:** flokkun vantar, er gölluð, notar óþekktan flokk, planner kann ekki
  að flokka, eða flokkun kastar villu.
- **OWNER:** control plane skrifar approval-beiðni og **GitHub Issue-beiðni úthlutaða á
  `cluborchestra`**, og lúppan bíður í `WAITING_APPROVAL`. Orchestrator-workflow-ið opnar
  issue-ið með `gh` og `GITHUB_TOKEN`:
  - `issues: write`, ekkert nýtt secret;
  - titill og meginmál koma úr skrám, aldrei úr skeljartexta;
  - endurkeyrsla býr ekki til nýtt issue (idempotent).

**Dæmi úr keyrslu:** planner flokkar „Add CSV export“ sem OWNER/scope.
```
status: WAITING_APPROVAL | next_safe_action: await owner decision CO-SIM-010.implement (scope)
{"kind":"decision","decision":"OWNER","category":"scope","decided_by":"planner","reason":"CSV export is a new feature outside the agreed goal"}
{"kind":"transition","from":"RUNNING","to":"WAITING_APPROVAL","reason":"OWNER/scope (planner): approval CO-SIM-010.implement required"}
```
Issue-beiðnin sem workflow-ið opnar:
```json
{ "approval_id": "CO-SIM-010.implement", "category": "scope", "assignee": "cluborchestra",
  "title": "[clubOrchestra] Owner decision needed: CO-SIM-010.implement (scope)",
  "body": "**The Review-Dispatch Loop is waiting for you.** … > CSV export is a new feature outside the agreed goal … **To decide:** set `status` to `approved` … or `denied` in `data/approvals/CO-SIM-010.implement.json` on branch `orchestra-state`.",
  "issue_url": null }
```

**Próf** (`test/p3-escalation.test.js`, 14/14):
- AUTO;
- OWNER fyrir cost, scope, access, irreversible og security: hvert bíður, eitt issue, og keyrir
  eftir samþykki;
- `denied` → BLOCKED;
- policy-gólf ×3;
- vafatilvik: 11 gölluð form, planner án flokkunar, og flokkun sem kastar villu;
- replay með OpenAI-formi: OWNER/scope og ónothæf flokkun;
- öryggi issue-texta;
- CLI og workflow-skref.

## Verk 3: LOT 2b lágmark
**a) Async kallleið** (`83e3762`) í stað sync-brúar:
- ControlPlane, `callModel`, adapterar, OpenAI- og Claude-clients, replay, harness og CLI eru
  `async`. Sims eru óbreyttir.
- Hegðun er óbreytt: öll fyrri próf græn, og local harness og crash/restart enda á sama SHA og
  áður (`a7f682e…`).
- Engin async-köll án `await` í prófum (athugað með grep).

**b) Claude-fánar** staðfestir gegn **Claude Code 2.1.286** (CLI sem fylgir skrifborðsforritinu).
**Aðeins** `claude --version` og `claude --help` voru keyrð; ekkert `-p` og ekkert módelkall.
| Fáni | Niðurstaða úr `--help` |
|---|---|
| `--allowedTools` | „Comma or space-separated list of tool names to allow“ → við sendum **eitt kommuaðgreint gildi** |
| `--max-turns` | **Ekki til** í 2.1.286, svo **fjarlægður** (óþekktur fáni gæti fellt keyrsluna) |
| `--max-budget-usd` | Til: hart dollaraþak á keyrslu = `per_call_max_usd` (sama upphæð og guard tekur frá) |
| `--bare` | Auðkenning eingöngu með `ANTHROPIC_API_KEY`; engin sjálfvirk lestur á CLAUDE.md eða hooks |
| `--permission-prompts none` | Allt sem myndi spyrja er sjálfkrafa hafnað |

**Full invocation, ekki stytt** (replay-limits, `per_call_max_usd` = 0.5):
```
claude -p --bare --output-format json --max-budget-usd 0.5 --permission-prompts none --allowedTools "Read,Edit,Write,Bash(npm test),Bash(git status),Bash(git diff *),Bash(git add *),Bash(git commit *)" --append-system-prompt "<WORKER_SYSTEM>"
```

## Prófaúttak (`npm test` á `d0acf8f`)
```
tests 120 · pass 120 · fail 0 · cancelled 0 · skipped 0
control-plane 28 · p2a-github-loop 19 · p2b-github-wiring 5 · p3-escalation 14 (ný)
p3-lot1-agents 16 · p3-lot2-replay 19 · p3-lot2-sdk-judge 16 · single-writer 3
```
Nettilgildra er virk í hverju prófaferli. Í `src/` er hvorki `process.env`, `fetch(` né
`child_process`.

## Push og staðfesting
_(fyllt út eftir push, sjá neðst)_

## Áhætta og niðurstöður sem Ási ætti að vita
1. **Issue-skrefið hefur ekki keyrt á GitHub enn.** Það er prófað statískt og verður virkt þegar
   greinin er mergeuð í `main`; fyrsta OWNER-tilvik staðfestir það. Orchestrator-inn er armaður á
   `main` (`ORCHESTRATOR_ENABLED=true`), en þessi grein ræsir hann ekki.
2. **Svar Ása fer í dag í gegnum approval-skrá** á `orchestra-state`. Samþykki beint í gegnum issue
   er backlog B3.
3. **Concurrency** (frá fyrri hluta Lot 2b): workflow-stigs `concurrency` getur hætt við bíðandi
   keyrslu. Lagfæring er í Lot 3 lið 8.
4. **Úttaksform `claude -p`** og exit codes eru óstaðfest (bannað að keyra). Fyrsta keyrslan í
   Lot 3 staðfestir þau.

## Það sem LOT 3 þarf frá Ása
Samþykki og spend-cap · **provider-budget (SKYLDA)** · tveir lyklar í environments
`agents-planner` / `agents-worker` (aðeins `main`, Ási required reviewer) · verð planner-módels ·
samþykki fyrir einni undanþeginni skrá `src/agents/live.js`. Sjá
[vinnuplan v1.0 §2](../docs/clubOrchestra_verkefna_og_vinnuplan_v1.0.md).
