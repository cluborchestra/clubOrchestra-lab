# clubOrchestra — Verkefna- og vinnuplan
Status: ACTIVE
Updated: 2026-10-05
Owner: Product Owner (Ási) · umsjón: PM
Canonical source: YES
Version: v1.3

Ef skjölum ber ekki saman gildir eftirfarandi forgangsröð:
1. nýjust staðfest evidence úr repo/keyrslu;
2. [PROJECT_STATUS.json](PROJECT_STATUS.json);
3. þetta skjal;
4. [PM_HANDOFF.md](PM_HANDOFF.md).

Skjalastaðall: [CLUB_DOCUMENTATION_STANDARD.md](CLUB_DOCUMENTATION_STANDARD.md).

## 1. Kjarni / Tilgangur

Tilgangur verkefnisins, orðréttur. Hann gildir umfram allt annað:

> Tvær gervigreindir frá tveimur framleiðendum (OpenAI planner + Claude worker) vinna
> saman svo að annar grípi villur sem hinn sér ekki. Allt sem Ási þarf ekki að svara er
> afgreitt sjálfvirkt ("white noise"). Til Ása fer EINGÖNGU:
>   - kostnaður (nýr kostnaður, hækkun þaks, nálgast þak)
>   - breytingar á umfangi (nýir eiginleikar, viðbætur, breytt markmið)
>   - aðgangur að kerfum sem agentar hafa ekki, eða verk sem Ási þarf að framkvæma
>   - óafturkræfar aðgerðir og öryggis-/lyklamál
>   - ALLT sem er vafi um → til Ása (fail-closed)
> Sjálfvirkt: kóðalagfæringar, próf, endurtekningar, CI-villur, refactor innan umfangs.

Kjarna-lúppan heitir **Review-Dispatch Loop (áfangi P4)**:
- planner sendir verk til worker;
- CI dæmir commit-inn;
- planner rýnir og sendir næsta verk;
- enginn maður segir „continue“.

## 2. Markmið
1. Sanna að OpenAI-planner og Claude-worker geti rétt vinnu á milli sín, atburðadrifið, í 2–3
   örugg skref í röð án „continue“. Það er **P4-samþykkt**.
2. Allt sem fellur undir §1 sem sjálfvirkt er afgreitt án Ása. Allt annað stöðvast og fer til
   hans.
3. Lausnin er færanleg (eitt repo-sniðmát), frí eins og hægt er, og kostar ekkert án samþykkis.

## 3. Scope
**Innifalið:**
- control plane (ástandsvél, atburðir, idempotency, single-writer, circuit breaker, approval/OWNER
  gate, audit);
- GitHub-native lúppa (Actions, `orchestra-state`);
- agent-adapterar (OpenAI Responses planner, Claude Code headless worker);
- kostnaðarvarnir;
- escalation-reglan;
- skjölun og evidence.

**Utan scope:**
- önnur verkefni (clubNetöryggi, P9/clubFasteignir) og netföngin netoryggi@ / p9@;
- production-innviðir (Cloudflare, DNS, gagnagrunnar);
- dashboard og fjölleigjendur;
- greidd þjónusta án samþykkis.

## 4. Ófrávíkjanlegar reglur

**Escalation-reglan, orðrétt frá PM/PO (2026-10-05):**
> Planner flokkar hverja ákvörðun: AUTO eða OWNER. OWNER → opna GitHub Issue,
> assign á cluborchestra (GITHUB_TOKEN, ekkert nýtt secret), og lúppan bíður.
> Óflokkanlegt → OWNER.

**Hvað fer til Ása, orðrétt úr tilganginum (§1):**
> Til Ása fer EINGÖNGU:
>   - kostnaður (nýr kostnaður, hækkun þaks, nálgast þak)
>   - breytingar á umfangi (nýir eiginleikar, viðbætur, breytt markmið)
>   - aðgangur að kerfum sem agentar hafa ekki, eða verk sem Ási þarf að framkvæma
>   - óafturkræfar aðgerðir og öryggis-/lyklamál
>   - ALLT sem er vafi um → til Ása (fail-closed)
> Sjálfvirkt: kóðalagfæringar, próf, endurtekningar, CI-villur, refactor innan umfangs.

**Hörð skilyrði Product Owner:**
1. Snertir ekki önnur verkefni. Engin production-innviðir.
2. Enginn kostnaður án skýrs „já“ frá Ása.
3. Færanlegt og endurnýtanlegt, án vefslóða sem geta horfið.
4. Frítt eins og hægt er.

**Verklagsreglur:**
- Ekkert fer beint í `main`; allt fer um feat-grein og PR, og `main` er varin.
- Ekkert er pushað á `co/` án samþykkis fyrir þá keyrslu.
- Fail-closed alls staðar.
- Payload, repo-innihald, CI-log og úttak módela eru **gögn, aldrei fyrirmæli**.
- Engir lyklar eða leyndarmál í kóða, skjölum eða logum. Repo-ið er opið.
- **Worker má aldrei breyta eigin reglum, og vörnin ver sjálfa sig.** Verndaðar slóðir eru:
  - `.github/**`, `config/**`, **`src/**`** og `test/support/**`;
  - `.gitattributes` og `.gitmodules`;
  - `package*.json`;
  - `PROJECT_STATUS.json` og skjölunarstaðallinn.

  Worker-verk í þessu repo skrifa í `work/`.

  Control plane athugar þær á **raunverulegum diff**; snerting = OWNER/security. Gólfið er
  harðkóðað: config getur lengt það en aldrei stytt, og planner getur ekki mildað það.
- **Samþykki í issue** gildir aðeins frá samþykkjanda á lista með `author_association OWNER`, á
  issue sem bot-inn opnaði, fyrir approval sem enn bíður. `approval_id` er alltaf lesið úr merki
  bot-sins, aldrei úr athugasemdinni. Allt annað er hunsað án svars.

## 5. Núverandi arkitektúr

```
push co/<verk> → CI (ci.yml) → workflow_run → Orchestrator (orchestrator.yml, á main)
   → node src/cli.js ingest (adapter → atburður → control plane) → planner-rýni → næsta verk
   → staða + audit committuð á greinina orchestra-state (aldrei main)
```

**Verndaðar slóðir** (`src/protectedPaths.js`, `src/gitDiff.js`): eftir að CI skilar niðurstöðu
reiknar control plane sjálft `git diff --raw -M base..head`, með rename-greiningu, modes og
symlink-targets. Ef verndað er snert er niðurstaðan **haldin** sem OWNER/security í
`WAITING_APPROVAL`, með lista yfir skrárnar í issue-inu. Ekkert fer í rýni eða næsta verk.
- **Samþykkt:** sama niðurstaða fer áfram (`WAITING_APPROVAL → WAITING_EVENT`).
- **Hafnað:** BLOCKED.
- **Diff ekki tiltækur:** BLOCKED (fail-closed).

**Samþykki í issue** (`.github/workflows/approval.yml`, `src/ownerCommands.js`): fyrsta lína
athugasemdar á að vera `/approve` eða `/deny`.
- **Gild skipun:** approval-skrá á `orchestra-state` er uppfærð (höfundur, comment-URL og tími), bot
  svarar og lokar issue-inu.
- **Allt annað:** hunsað og skráð í audit.
- **Varaleið:** approval-skráin sjálf.

**Worker-CLI** (`.github/workflows/worker.yml`, beinagrind; óvirk þar til `WORKER_ENABLED`):
`@anthropic-ai/claude-code@2.1.286`, og `claude --version` verður að passa nákvæmlega, annars
fail-closed.

**Control plane** (`src/controlPlane.js`, async): ástandsvélin
`IDLE · RUNNING · WAITING_EVENT · WAITING_APPROVAL · FAILED · BLOCKED · COMPLETE`, þar sem aðeins
leyfðar færslur eru mögulegar. Hún tryggir:
- idempotency (`processed_events.json`);
- single-writer (lease + optimistic version, og á GitHub auk þess `concurrency` + non-forced push);
- circuit breaker við 3 samfelld FAIL;
- audit-log sem aðeins er bætt við.

**Hlið áður en verki lýkur:**
1. Atburður stenst skema (annars BLOCKED).
2. **Nákvæmt SHA:** CI-niðurstaðan er fyrir nákvæmlega þann commit sem beðið er eftir.
3. **Haus greinarinnar:** commit-inn er enn haus `co/<verk>`.
4. **Rýni planners:** ACCEPT lýkur verkinu; REJECT veldur nýrri tilraun, og ástæðan fer til
   planners sem endurgjöf.

**Escalation** (`src/escalation.js`):
- **Policy-gólf í kóða:** `spend`→cost, `enable_api_keys`→security og `deploy`→irreversible
  eru alltaf OWNER.
- **Planner-flokkun:** hver ákvörðun er AUTO eða OWNER/{cost, scope, access, irreversible,
  security}. Planner getur hert en aldrei mildað.
- **Vafi:** óflokkanlegt verður OWNER/uncertain.
- **OWNER:** approval-beiðni og issue-beiðni (`src/ownerIssues.js`), og lúppan bíður í
  `WAITING_APPROVAL`. Orchestrator opnar issue-ið með `gh` + `GITHUB_TOKEN`, úthlutað á
  `cluborchestra`.

**Agentar** (`src/agents/`):
- `PlannerAdapter`/`WorkerAdapter`.
- **Planner:** OpenAI Responses (`POST /v1/responses`, strict `json_schema`) í gegnum innspýtt
  transport.
- **Worker:** Claude Code headless (`claude -p --bare --output-format json --max-budget-usd …
  --permission-prompts none --allowedTools …`) í gegnum innspýttan runner.
- Í dag eru aðeins replay/mock til; enginn live-kóði er til.

**Kostnaðarvarnir** (`src/agents/spendGuard.js`):
- frátekt **áður en** kall er gert, undir læsingu á ledger;
- raunkostnaður bókaður eftir kallið;
- óþekktur kostnaður stöðvar;
- dagsþak miðast við UTC;
- loop-detector.

Ledger-ið er á `orchestra-state`. Sjálfgefið er lokað: mode `mock`, þak 0 USD, og `real` er
hafnað.

## 6. Núverandi staða (staðfest)
Staðfest 2026-10-05 úr git og opinberu GitHub API.

- **`main` = `1597f1b`:** merge á PR #1, varin. Workflows CI og Orchestrator eru virk.
  `ORCHESTRATOR_ENABLED=true` (sett af Ása).
- **`orchestra-state` = `66cee56`:** `WAITING_EVENT`, bíður worker á `CO-SIM-002` (í `outbox/`;
  ekkert keyrir það). Þetta er samþykktur stöðvunarpunktur.
- **Review-Dispatch Loop á alvöru GitHub með hermdum workers, E2E_VERIFIED:**
  - stale-SHA no-op: CI 37357864409 → orchestrator 37357891383 → `88bd4aa`;
  - full lúppa: CI 37358003409 → orchestrator 37358037144 (attempt 1) → `66cee56`.
- **Live tvítekningarpróf:** VERIFIED í dry-run. Live endurkeyrsla er **frestuð**, því attempts
  2–3 á 37358037144 féllu á GitHub hosted-runner atviki. Ekkert var skrifað.
- **P3 Lot 1, 2 og 2b** eru IMPLEMENTED + TESTED á greininni `feat/co-p3-lot2b-async` (pushuð,
  **ekki mergeuð**, PR ekki opnað).
- **PRE3** (verndaðar slóðir, `/approve` í issue, fest CLI) er IMPLEMENTED + TESTED á
  `feat/co-p3-pre3-001`, staflað ofan á Lot 2b.
  - Prófasvítan er **143/143** græn, staðbundið og offline.
  - Ekkert af nýju workflow-unum hefur keyrt á GitHub: `issue_comment` keyrir aðeins af `main`.
  - Á GitHub hefur CI aðeins keyrt á PR #1 (37355805656, grænt).
- **Docs-greinin** `docs/co-p2b-e2e-status` (`2c363ae`) er pushuð. Staða PR fyrir hana er ekki
  staðfest.

## 7. Capability / feature status
| Capability | Staða | Hvar / sönnun |
|---|---|---|
| Control plane (P1) + GitHub-tenging (P2b) | **LIVE** (á `main`, orchestrator armaður) | `main` `1597f1b` |
| Review-Dispatch Loop með hermdum workers | **VERIFIED LIVE** | §6, `docs/evidence/p2b_live_run.md` |
| Tvítekinn atburður = no-op á GitHub | VERIFIED (dry-run); live frestað | §6 |
| Adapter hunsar CI utan `co/` | LIVE | `src/adapters/github.js` |
| Agent-adapterar + kostnaðarvarnir (Lot 1) | READY_NOT_DEPLOYED (á grein, ekki mergeað) | `test/p3-lot1-agents.test.js` |
| Replay með raunverulegu API-formi (Lot 2) | READY_NOT_DEPLOYED (á grein) | `test/p3-lot2-*.test.js` |
| Async kallleið + staðfestir Claude-fánar (Lot 2b) | READY_NOT_DEPLOYED (á grein) | `src/agents/claudeCode.js` |
| Escalation-regla AUTO/OWNER + issue-beiðnir | READY_NOT_DEPLOYED (á grein; issue-skrefið hefur aldrei keyrt) | `test/p3-escalation.test.js` |
| Verndaðar slóðir á raunverulegum diff (PRE3 + PRE3b: vörnin ver sjálfa sig) | READY_NOT_DEPLOYED (á grein) | `test/p3-pre3.test.js` (13 próf, raunverulegt git) |
| `/approve` / `/deny` í issue (PRE3) | READY_NOT_DEPLOYED (á grein; `approval.yml` keyrir aðeins eftir merge) | `test/p3-pre3.test.js` (9 próf + statísk) |
| Fest Claude Code CLI 2.1.286 + nákvæm útgáfuathugun (PRE3) | READY_NOT_DEPLOYED (beinagrind, óvirk) | `worker.yml`; `check-claude-version` |
| Raunverulegir agentar (live transport/runner) | PLANNED (Lot 3) | — |
| P4-samþykkt (≥2 verk í röð með raunverulegum agentum) | PLANNED | eftir Lot 3 |
| Tilkynningar við BLOCKED / >80% af þaki (B1) | PLANNED | backlog |
| Bilanapróf (P5) | FUTURE | — |

## 8. NOW
- **PRE3b:** gólfið útvíkkað, svo vörnin ver sjálfa sig. Evidence:
  [evidence/CO-P3-PRE3B-001.md](../evidence/CO-P3-PRE3B-001.md).
- **Eitt PR undirbúið:** `feat/co-p3-pre3-001 → main`, ekki mergeað. Ási samþykkir þegar GitHub
  Actions er stöðugt.

## 9. NEXT
1. PR fyrir `docs/co-p2b-e2e-status`, og síðan fyrir staflaða P3-greinina (Lot 1 → 2 → 2b → PRE3)
   inn í `main` (merge commit). Eftir merge virkjast `approval.yml`, og fyrsta OWNER-tilvik staðfestir
   issue-opnun og `/approve` live.
2. Lot 3 þegar Ási samþykkir (§13, §14).

## 10. LATER / BACKLOG
| # | Verk |
|---|---|
| B1 | Tilkynningar til eiganda (BLOCKED, >80% af þaki) sem GitHub Issue á `cluborchestra`. OWNER-ákvarðanir eru þegar komnar. |
| B2 | `OWNER_CARD.md`: ein síða á mannamáli eftir langt hlé (neyðarrofi, samþykki, hvar staðan sést, lyklaendurnýjun) |
| B3 | ~~Samþykki í gegnum issue~~: **útfært í PRE3** (`/approve`/`/deny`). Eftir: live staðfesting eftir merge. |
| B8 | Endurræsing eftir `/approve`. Lúppan heldur í dag fyrst áfram við næstu orchestrator-keyrslu. Lot 3: approval-workflow sendir `repository_dispatch` (leyft með `GITHUB_TOKEN`) og orchestrator hlustar á það. |
| B4 | Watchdog (`schedule`): stöðnun → reconcile, aldrei annar writer |
| B5 | Live tvítekningarpróf: endurkeyra orchestrator 37358037144 |
| B6 | Snyrting: `repo` í handoff frá CLI-planner = `cluborchestra/clubOrchestra-lab` |
| B7 | Strangari útdráttur ef Claude vefur JSON-svar í texta |
| P5 | Bilanapróf |

## 11. Blockers
- **Live tvítekningarpróf (B5):** bíður heilbrigðra GitHub hosted runners. Atvikið 2026-10-05 hefur
  ekki verið endurathugað.
- Aðrir tæknilegir blockerar eru engir. Lot 3 bíður ákvörðunar Ása (§13); það er gate, ekki
  blocker.

## 12. Acceptance / verification
| Áfangi | Staða | Sönnun |
|---|---|---|
| P1 control plane | ACCEPTED (QA 2026-10-04) | 28 próf (`test/control-plane.test.js`) + 3 single-writer (6 raunveruleg ferli keppa) |
| P2a lúppa staðbundið | ACCEPTED | 19 próf (`test/p2a-github-loop.test.js`), staðbundinn harness |
| P2b tenging + live keyrsla | VERIFIED LIVE (hermdir workers) | 5 próf + live keyrslur (§6) |
| P3 Lot 1 | ACCEPTED (PM 2026-10-05) | 16 próf |
| P3 Lot 2 | ACCEPTED (PM 2026-10-05) | 35 próf: 19 replay + 16 SDK-dómari (`openai@7.28.0` devDependency) |
| P3 Lot 2b + escalation + skjölun | ACCEPTED (PM 2026-10-05) | 14 escalation-próf; 120/120 |
| PRE3 | ACCEPTED (PM 2026-10-06), með skilyrðinu PRE3b | 23 ný próf; `gitDiff.js`-undanþágan og WAITING_EVENT ⇄ WAITING_APPROVAL samþykkt |
| PRE3b | Í QA | 3 ný próf; allt 146/146 grænt |

**Prófaregla:** hvert prófaferli hefur nettilgildru (`test/support/no-network.js`). Í `src/` er
hvorki `process.env` né `fetch(` (offline-próf).
- `child_process` er aðeins í `src/gitDiff.js`. Það er þröng undanþága frá PRE3: aðeins
  `execFileSync('git', [...])` án skeljar, og aðeins les-skipanirnar `diff` og `cat-file`.
- Offline-prófið staðfestir hvert atriði og bannar netskipanir.

**Þekktar takmarkanir:**
- Úttaksform `claude -p` og exit codes eru óstaðfest, því `-p` er bannað fram að Lot 3.
- `adopt_commit` í reconcile staðfestir ekki ancestry; CI og rýni hlið það samt.
- `reconcile` sendir aldrei verk aftur af stað. Stöðnun bíður watchdog (B4).
- CI-niðurstaða sem kemur á undan niðurstöðu worker er hunsuð. Lagfæring er að endurkeyra CI.
- `processed_events.json` er skrifað strax á eftir `state.json`. Ef ferlið hrynur á milli er
  atburðurinn hunsaður sem stale.
- Fyrir-kalls áætlun planners er íhaldssöm (≈3 bæti á tóka). Raun-usage kemur í staðinn eftir
  kallið.

## 13. Ákvarðanir sem Product Owner þarf að taka
1. **Lot 3** (kostar peninga), í þessari röð:
   1. samþykki og spend-cap;
   2. **budget hjá veitendum (SKYLDA);**
   3. lyklar í environments `agents-planner` / `agents-worker` (aðeins `main`, Ási required
      reviewer allt Lot 3);
   4. verð planner-módels;
   5. samþykki fyrir einni undanþeginni skrá, `src/agents/live.js`.
2. **Merge:** PR fyrir docs-greinina og fyrir Lot-greinina inn í `main`.
3. **B5:** hvenær á að endurkeyra live tvítekningarprófið.
4. **Approvers:** `config/protection.json` leyfir í dag aðeins `cluborchestra`. Breyting fer um PR,
   og skráin er sjálf vernduð.

## 14. Roadmap / work packages
P0 hönnun ✔ → P1 ✔ → P2a ✔ → P2b ✔ (VERIFIED LIVE með hermdum workers) → P3 Lot 1 ✔ → Lot 2 ✔ →
Lot 2b ✔ → PRE3 ✔ → **PRE3b (í QA)** → **Lot 3** (raunverulegir agentar, OWNER_APPROVAL) → **P4-samþykkt** → P5
bilanapróf.

**Lot 3 í réttri röð:**
1. Atriðin úr §13.1.
2. `src/agents/live.js`.
3. Worker-workflow: `outbox/` → `repository_dispatch`.
4. `concurrency` á `ingest`-jobbið + watchdog (§4a, skráð af PM sem Lot 3 eftirfylgni).
4b. B8: endurræsing eftir `/approve` (`repository_dispatch` frá approval-workflow; skráð af PM sem Lot 3
   eftirfylgni).
5. Fyrsta supervisaða keyrslan, eitt verk.
6. P4: ≥2 verk í röð.

## 15. Arkitektúr- og tækniákvarðanir
| # | Ákvörðun | Rök |
|---|---|---|
| D1 | GitHub-native control plane; staða á `orchestra-state` | Frítt, færanlegt, engin slóð sem hverfur |
| D2 | Planner = OpenAI Responses; worker = Claude Code headless | Tveir framleiðendur grípa villur hvor annars |
| D-A | Framleiðslukóði án dependencies; `openai` aðeins sem dómari í prófum | Minna yfirborð |
| D-B | Worker-form = Claude Code JSON, kostnaður = `total_cost_usd` | Það sem Lot 3 keyrir |
| Async | Kallleiðin er async, engin sync-brú | Fyrsta greidda keyrslan prófar eitt nýtt atriði |
| Fánar | Staðfestir gegn `claude --help` 2.1.286. `--max-turns` er ekki til, svo `--max-budget-usd` kemur í staðinn | Óþekktur fáni gæti fellt keyrsluna |
| Escalation | Policy-gólf + planner-flokkun; vafi = OWNER | Tilgangurinn (§1) |
| Merge | Merge commit (ekki squash/rebase) | SHA-saga og evidence haldast |
| Heiti | Review-Dispatch Loop (áfangi P4) | PM/PO 2026-10-05 |
| Verndaðar slóðir | Raunverulegur diff reiknaður af control plane með `git`, aldrei skýrsla worker | Worker stjórnar ekki athuguninni |
| `gitDiff.js`-undanþága | Eina skráin í `src/` sem má keyra ferli: staðbundið `git`, aðeins lesa | Pure-JS git-pack-lestur væri miklu stærri og áhættusamari |
| Nýjar færslur | `WAITING_EVENT → WAITING_APPROVAL` (halda niðurstöðu) og `WAITING_APPROVAL → WAITING_EVENT` (halda áfram eftir samþykki) | Rétt staða (bíður eiganda) án þess að endurtaka vinnu |
| Fest CLI | npm-pakki `@anthropic-ai/claude-code@2.1.286` í `worker.yml` og `claude_code.version` í config; próf heldur þeim jöfnum | Ein útgáfa, sannreynd fyrir hverja keyrslu |

## 16. Öryggi, persónuvernd og rekstrarskorður
Nánar í [SECURITY_MODEL.md](../SECURITY_MODEL.md). Helstu atriði:
- **Lyklar:**
  - `OPENAI_API_KEY` er aðeins í `agents-planner` (ingest-jobbið), `ANTHROPIC_API_KEY` aðeins í
    `agents-worker`.
  - Bæði eingöngu fyrir `main`. Það passar, því `workflow_run` og `repository_dispatch` keyra á
    default branch.
  - Required reviewer er virkt allt Lot 3 og stöðvar sjálfvirknina viljandi.
- **Adapterar** snerta aldrei lykla (canary-próf). Nákvæmlega ein skrá verður undanþegin í Lot 3.
- **Ledger-áhætta:** ef state-push er hafnað tapast bókun. Þess vegna er budget hjá veitendum
  SKYLDA.
- **Concurrency:** workflow-stigs `concurrency` heldur aðeins einni bíðandi keyrslu, svo atburður
  getur týnst (aldrei tvöföld eyðsla). Lagfæring er í Lot 3.
- **Óvottað API:** óauðkennd GitHub API-köll eru takmörkuð við 60 á klukkustund.
- **Opið repo:** hver sem er getur skrifað athugasemd. Skipun gildir aðeins við öll skilyrði
  (`src/ownerCommands.js`), og texti athugasemdar fer aldrei í skel, planner eða worker.
- **`approval.yml`:**
  - `permissions: issues: write, contents: write`, ekkert annað;
  - engin secrets og ekkert `pull_request_target`;
  - sami concurrency-hópur og orchestrator.

## 17. Skjölunar- og afhendingarreglur
- **Staðall:** [CLUB_DOCUMENTATION_STANDARD.md](CLUB_DOCUMENTATION_STANDARD.md).
  - Eitt canonical plan (þetta skjal), eitt stöðuskjal ([PROJECT_STATUS.json](PROJECT_STATUS.json))
    og stutt afleiða ([PM_HANDOFF.md](PM_HANDOFF.md)).
  - Yfirlit yfir skjöl: [DOCUMENTATION_INVENTORY.md](DOCUMENTATION_INVENTORY.md).
- **Tungumál og útgáfur:** íslenska í skjölum, enska í kóða. Engin útgáfa í skráarheitum, heldur
  í haus og breytingaskrá.
- **Evidence** fer í `evidence/<verk-id>.md`. PM/Ási fá **einn permalink með commit-SHA**
  (`…/blob/<SHA>/evidence/…`), aldrei hlekk á greinarheiti, því vefsækir les annars úrelt afrit.
- **Hvert verk:** feat-grein og PR. Kóði og skjöl segja sömu sögu í sama commit.

## 18. Breytingaskrá
| Útgáfa | Dags. | Breyting |
|---|---|---|
| v0.1 | 2026-10-04 | Upprunalegt spec í rót (`clubOrchestra_verkefna_og_vinnuplan_v0.1.md`): hönnun + backlog. Sögulegt. |
| v1.3 | 2026-10-06 | PRE3 samþykkt (`gitDiff.js`-undanþága og nýjar færslur samþykktar). PRE3b: gólf verndaðra slóða útvíkkað um `src/**`, `test/support/**`, `.gitattributes` og `.gitmodules`, svo vörnin ver sjálfa sig (§4); 146 próf. B8 og concurrency skráð sem Lot 3 eftirfylgni (§14). |
| v1.2 | 2026-10-05 | PRE3 bætt við:
- verndaðar slóðir á raunverulegum diff (§4, §5, §15);
- `/approve`/`/deny` í issue;
- fest Claude Code CLI 2.1.286;
- B3 útfært og B8 skráð;
- 143 próf. |
| v1.1 | 2026-10-05 | Spec v0.1 merkt SUPERSEDED (ákvörðun Ása), og sú ákvörðun tekin af §13. PRE3 skráð í §9 sem bíðandi verklýsingu. Hlekkir til PM eru héðan í frá permalinks með commit-SHA (§17). |
| v1.0 | 2026-10-05 | Club-skjölunarstaðall tekinn upp. Þetta skjal varð canonical plan. Inn í það voru sameinuð drögin `clubOrchestra_samantekt_/virknilysing_/verkefna_og_vinnuplan_v1.0` og `CURRENT_STATUS.md`, sem var eytt. Tilgangur og escalation-regla orðrétt í §1 og §4. Staða til og með P3 Lot 2b. |
