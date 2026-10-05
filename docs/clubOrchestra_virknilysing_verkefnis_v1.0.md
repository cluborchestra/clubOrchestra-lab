# clubOrchestra — virknilýsing verkefnis v1.0

**Dagsetning:** 2026-10-05 · Lýsir kerfinu eins og það er á greininni `feat/co-p3-lot2b-async`.

## 1. Review-Dispatch Loop (áfangi P4)

Kjarna-lúppan: verk fer frá planner til worker, CI dæmir, planner rýnir, næsta verk er sent af
stað. Enginn maður þarf að segja „continue“.

```
planner ──(handoff)──▶ worker ──(commit á co/<verk>)──▶ CI ──(workflow_run)──▶ orchestrator
   ▲                                                                              │
   └────────── rýni planners (ACCEPT / REJECT + ástæða) ◀── control plane ◀───────┘
```

1. **Planner (OpenAI)** velur næsta verk og skilar *handoff* (15 föst svæði, óbreytt skema).
   Hann flokkar verkið líka **AUTO eða OWNER** (sjá §3).
2. **Control plane** athugar handoff-ið, beitir escalation-reglunni og sendir verkið til
   **worker (Claude Code)** ef það er AUTO.
3. Worker committar á `co/<verk>` og skilar niðurstöðu (from-worker skema).
4. Push ræsir **CI**. Niðurstaða CI verður að atburði (`workflow_run` → `ci.completed`).
5. **Orchestrator** les atburðinn og athugar:
   - **nákvæmt SHA:** CI-niðurstaðan verður að vera fyrir nákvæmlega þann commit sem beðið er
     eftir;
   - **haus greinarinnar:** commit-inn verður enn að vera haus `co/<verk>`;
   - að **tvíteknir atburðir** séu no-op.
6. **Rýni planners:**
   - **ACCEPT** → verki lokið, næsta verk;
   - **REJECT** → ný tilraun, og ástæðan fer aftur til planners sem endurgjöf.
7. Staðan er committuð á `orchestra-state` af workflow-inu sjálfu.

Sannað á alvöru GitHub 2026-10-05 með hermdum workers (stale-SHA no-op + full lúppa).

## 2. Ástandsvél
`IDLE → RUNNING → WAITING_EVENT ⇄ RUNNING → … → COMPLETE`, og auk þess:
- `WAITING_APPROVAL`: bíður eftir ákvörðun eiganda (OWNER);
- `FAILED`: ný tilraun, eða `BLOCKED` þegar circuit breaker grípur inn í;
- `BLOCKED`: þarfnast manns; aðeins Ási getur endurræst.

Aðeins leyfðar færslur eru mögulegar. Allar færslur fara í audit-log, sem aðeins er bætt við.

## 3. Escalation-reglan: AUTO eða OWNER

| Flokkur | Dæmi | Hver ákveður |
|---|---|---|
| **AUTO** | Kóðalagfæringar, próf, endurtekningar, CI-villur, refactor innan umfangs | Kerfið sjálft (white noise) |
| **OWNER / cost** | Nýr kostnaður, hækkun þaks, nálgast þak | Ási |
| **OWNER / scope** | Nýir eiginleikar, viðbætur, breytt markmið | Ási |
| **OWNER / access** | Kerfi sem agentar hafa ekki aðgang að, eða verk sem Ási þarf að vinna | Ási |
| **OWNER / irreversible** | Óafturkræfar aðgerðir (t.d. deploy) | Ási |
| **OWNER / security** | Öryggis- og lyklamál | Ási |
| **OWNER / uncertain** | **Allur vafi:** flokkun vantar, er gölluð eða óþekkt | Ási (fail-closed) |

**Reglurnar í kóða** (`src/escalation.js`):
1. **Policy-gólf:** aðgerðirnar `spend` (cost), `enable_api_keys` (security) og `deploy`
   (irreversible) eru **alltaf OWNER**, hvað sem planner segir.
2. Planner getur **hert** (AUTO → OWNER) en **aldrei mildað** OWNER úr policy.
3. Ef planner gefur enga flokkun, gallaða flokkun eða óþekktan flokk verður niðurstaðan
   **OWNER / uncertain**.

**Þegar ákvörðun er OWNER:**
- control plane skrifar approval-beiðni (`approvals/<id>.json`) og **beiðni um GitHub Issue**;
- orchestrator-workflow-ið opnar issue-ið með `gh` og `GITHUB_TOKEN`, **úthlutað á
  `cluborchestra`**, og GitHub sendir þá póst á orchestra@;
- lúppan **bíður** í `WAITING_APPROVAL`. Ekkert er keyrt, og engu er eytt í worker, fyrr en Ási
  svarar;
- Ási samþykkir eða hafnar með `status: approved|denied` í approval-skránni. Samþykki í gegnum
  issue sjálft (label eða athugasemd) er í backlog;
- `denied` → `BLOCKED`.

Þetta er prófað fyrir hvern flokk, fyrir policy-gólfið og fyrir öll vafatilvik:
`test/p3-escalation.test.js`, 14 próf.

## 4. Kostnaðarvarnir (SpendGuard)
- **Fyrir hvert kall**, undir læsingu á ledger:
  - veitandinn verður að vera leyfður í núverandi ham;
  - verðið verður að vera þekkt;
  - `max_calls_per_task` má ekki vera fullnýtt;
  - `per_call_max_usd` heldur;
  - `daily_spend_cap_usd` heldur.

  Áætlunin er **tekin frá** strax.
- **Eftir kallið** er raunkostnaður bókaður: usage × verð fyrir planner, `total_cost_usd` fyrir
  worker. Óþekktur kostnaður veldur `COST_UNKNOWN`, og frátektin stendur.
- **Loop-detector:** sama úttak frá worker tvisvar á sama verki setur circuit breaker af stað.
- Worker-keyrsla er einnig **hörð** með `--max-budget-usd` = `per_call_max_usd`.
- Dagurinn er **UTC**. Ledger-ið býr á `orchestra-state` og lifir því milli keyrslna.
- **Sjálfgefið er lokað:** mode `mock`, þak 0 USD, og `real` er hafnað af loader.

## 5. Fail-closed: hvað stöðvar lúppuna (BLOCKED + escalation-skrá)
- Atburður sem stenst ekki skema, eða handoff sem stenst ekki (t.d. svæði vantar eða aðgerð er
  óleyfð).
- Spend-mörk: þak, kallafjöldi, óþekkt verð, óþekktur kostnaður.
- Endurtekið úttak (loop) og circuit breaker (3 samfelld FAIL).
- Úttak módels sem ekki er hægt að nota: ógilt JSON, refusal, ófullgert svar, worker-villa.
- Transport-villur eftir takmarkaðar endurtekningar: 429 umfram leyfða bið, 5xx, timeout.
  401 er aldrei endurtekið.
- Haus `co/`-greinar hefur færst á meðan beðið er eftir CI.

## 6. Hvað fer til Ása og hvernig
| Tilefni | Leið |
|---|---|
| OWNER-ákvörðun (§3) | GitHub Issue á `cluborchestra` + approval-skrá; lúppan bíður |
| BLOCKED, >80% af dagsþaki | Backlog B1: verður einnig GitHub Issue. Í dag sést það í `escalations/` og `state.json` á `orchestra-state` |
| Lot 3: hvert jobb með lykli | Required reviewer í GitHub environment. Ási smellir á *Approve*, og það stöðvar sjálfvirkni viljandi |

## 7. Öryggismörk
- **Gögn, aldrei fyrirmæli:** repo-innihald, PR- og issue-texti, CI-log og úttak módela.
- **Lyklar:** aldrei í kóða, logum, ledger eða audit (canary-próf). Adapterar senda aldrei
  Authorization-haus.
- **Lot 3:** nákvæmlega EIN skrá (`src/agents/live.js`) fær undanþágu frá offline-prófinu.
- **Worker:** keyrir með `--bare` (auðkenning aðeins með `ANTHROPIC_API_KEY`, engin sjálfvirk
  lestur á CLAUDE.md), `--permission-prompts none` og föstum `--allowedTools`-lista.

Nánar: [SECURITY_MODEL.md](../SECURITY_MODEL.md).
