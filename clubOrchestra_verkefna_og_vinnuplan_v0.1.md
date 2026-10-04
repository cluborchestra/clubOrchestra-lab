# clubOrchestra — verkefna- og vinnuplan

**Útgáfa:** v0.1 · **Dagsetning:** 2026-10-04 · **Vinnuheiti:** clubOrchestra
**Hlutverk skjals:** canonical source of truth fyrir verkefnið (hönnun + lifandi backlog).
**Umsjón:** 🧠 Brainstorm with me – Project Manager (PM/BA/Arkitekt/QA) · Product Owner: Ásmundur.

> Status-merki (tveir ásar):
> **Líftími:** BACKLOG · NEXT · IN_PROGRESS · BLOCKED · OWNER_APPROVAL_REQUIRED · DONE
> **Staðfesting:** NOT_VERIFIED · VERIFIED · READY_NOT_DEPLOYED · LIVE
> Verk telst DONE aðeins með VERIFIED evidence — aldrei af því kóði er „kominn á branch".

---

## 1. Markmið

Sanna að **OpenAI-API planner** og **Claude worker** geti rétt vinnu á milli sín,
atburðadrifið, í 2–3 örugg skref í röð **án þess að human skrifi „continue"** — örugglega,
idempotent, rekjanlega, og stöðvi til að spyrja human við skilgreind mörk.

Þetta er **minnsta kerfið sem sannar hegðunina.** Ekki fjöl-leigjendur, ekki dashboard,
ekki 10 skjöl. Sanna lúppuna fyrst; alhæfa síðar.

## 2. Hörð skilyrði Product Owner (ósnertanleg)

1. **Snertir ekki önnur verkefni.** Ekkert clubNetöryggi, P9/clubFasteignir, engin production
   Worker/DNS/Access/DB/repo. Önnur verkefni = aðeins til skoðunar.
2. **Enginn kostnaður án samþykkis.** Allt sem kostar pening (eða annað) fer til Product Owner
   fyrir já/nei. Sjá §5.
3. **Færanlegt og endurnýtanlegt.** Lausnin verður að vera hægt að taka í önnur verkefni án þess
   að vera föst eða tæknilega flækt inn í þau, og **án vefslóða sem gætu horfið.**
4. **Frítt eins og hægt er.**

## 3. Lykilákvarðanir (v0.1 — afturkræfar)

- **D1 — Control plane = GitHub-native (ekki Cloudflare/D1 í MVP).**
  Staða + audit = JSON/markdown skrár í repo-inu. Single-writer læsing = GitHub Actions
  `concurrency` + optimistic lock (commit á state-skrá með þekktu blob-SHA; push hafnað ef breytt).
  Bakbein/vakning = GitHub Actions (`workflow_run`, `repository_dispatch`, `schedule`).
  **Rök:** ókeypis, hámarks-færanlegt (bara skrár, enginn þjónn, engin slóð sem hverfur),
  útgáfustýrt (ókeypis audit-saga), endurnýtanlegt með því að afrita repo-sniðmát.
  D1/Cloudflare = skjalfest *framtíðar*-viðbót ef lifandi dashboard eða ytri triggerar þarf.
- **D2 — Hlutverk (staðfest geta):**
  Worker = Claude Code **headless** (`claude -p`, `--output-format json`, `--resume`,
  `--allowedTools`) eða `anthropics/claude-code-action@v1`.
  Planner = **OpenAI Responses API + Structured Outputs** (strangt schema) fyrir ákvarðanir/handoff.
  Chat-öppin (ChatGPT/Claude) er EKKI hægt að lúppa — aðeins API.
- **D3 — Skjölun = markdown í repo-inu sem source of truth** (git-diffanlegt, færanlegt).
  Valkvætt .docx snapshot fyrir clubXXXX-möppusamræmi þegar óskað er. Engin Claude-Doc/ytri slóð
  (það væri „slóð sem hverfur").
- **D4 — Vinnuheiti = clubOrchestra.**

## 4. FIRST DELIVERABLE — Design Checkpoint

### 4.1 Getu-rannsókn (staðfest)
- **Claude worker:** headless `claude -p` virkar með `ANTHROPIC_API_KEY`, skilar stdout/JSON,
  styður `--resume` (fjölþrep) og `--allowedTools` (hömlur). Opinber GitHub Action
  `anthropics/claude-code-action@v1` pakkar headless-keyrslu + commit/PR/comment. **Kostnaður:**
  non-interactive köll (headless/Action/SDK) draga af API-kvóta, ekki áskrift (frá 2026-06-15).
- **OpenAI planner:** Responses API er núverandi agentic-staðall (leysir Assistants af). Structured
  Outputs = strangt JSON-schema; function/tool calling; `previous_response_id` fyrir fjölþrep.
  Keyranlegt úr eigin kóða/Action í lúppu.
- **Bakbein:** GitHub Actions + webhooks; `concurrency` gefur single-writer ókeypis.

### 4.2 Beint ChatGPT↔Claude samtal í dag?
Nei. Ekkert beint app-til-apps samtal. Samhæfing fer um API + control plane. Samtalið er
útfært sem **structured handoff objects**, ekki bókstaflegt spjall.

### 4.3 Arkitektúr (MVP)
```
Product Owner ──approval/goals──▶ GitHub repo (state.json + audit/ + workplan.md)
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                              ▼
   GitHub Actions (backbone + lock)   Planner: OpenAI Responses API   Worker: Claude Code headless
   - concurrency = single writer      - reads state + evidence        - reads real repo
   - triggers: workflow_run,          - emits next task (schema)      - implements, tests
     repository_dispatch, schedule     - evaluates worker evidence     - returns structured result
          │                                                            │
          └───────────────── commit/CI result = event ────────────────┘
```
Engin ytri þjónusta, enginn þjónn, engin slóð. Allt í einu einangruðu repo-i.

### 4.4 State-model (skrá: `state.json`)
```json
{ "schema_version": 1, "project_id": "clubOrchestra-lab",
  "status": "IDLE|RUNNING|WAITING_EVENT|WAITING_APPROVAL|BLOCKED|FAILED|COMPLETE",
  "current_task_id": null, "current_owner": "planner|worker|human|null",
  "lease_until": null, "repo": "...", "branch": "...",
  "expected_sha": null, "last_verified_sha": null, "last_event_id": null,
  "failure_count": 0, "next_safe_action": null }
```

### 4.5 Event-schema (4 tegundir til að byrja)
`task.ready · task.completed · ci.completed · approval.required`
```json
{ "schema_version": 1, "event_id": "uuid", "type": "ci.completed",
  "created_at": "UTC", "producer": "github|planner|worker", "project_id": "...",
  "repo": "...", "branch": "...", "sha": "...", "task_id": "...",
  "status": "success|failure", "payload": {}, "evidence_refs": [] }
```
Allir handlerar idempotent (sjá 4.7).

### 4.6 Handoff-schema
```
to-worker:   { task_id, objective, why, repo, branch_policy, starting_sha, allowed_scope,
               forbidden_scope, acceptance_criteria, required_tests, security_boundaries,
               documentation_requirements, evidence_required, return_format }
from-worker: { task_id, outcome: PASS|FAIL|BLOCKED, starting_sha, ending_sha, files_changed,
               tests, ci, docs_synced, risks, blockers, next_recommendation }
```
Planner **metur** evidence; treystir aldrei beru „done".

### 4.7 Single-writer + idempotency
- **Single writer:** GitHub Actions `concurrency: { group: clubOrchestra, cancel-in-progress: false }`
  → aðeins ein keyrsla í einu. Auk þess optimistic lock: lesa `state.json` blob-SHA, skrifa til baka
  með því SHA; ef annar skrifaði á undan → push hafnað → endurlesa (reconcile).
- **Idempotency:** `processed_events.json` geymir séða `event_id`. Séð áður → no-op.

### 4.8 Approval-model (skrá: `approvals/<id>.json`)
```json
{ "approval_id": "...", "task_id": "...", "action": "enable_api_keys|deploy|...",
  "reason": "...", "requested_at": "...", "requested_by": "planner",
  "status": "pending|approved|denied", "approved_by": null, "approved_at": null }
```
Product Owner samþykkir með commit/label/PR. Engin innbyggð túlkun („notandinn vildi líklega").

### 4.9 Circuit breaker
`failure_count` í state. N (t.d. 3) samfelld FAIL eða sama patch endurtekið → `status=BLOCKED`,
escalate til human. Engin blind endurtekning.

### 4.10 Vakning / watchdog / reconciliation
- **Vakning:** atburðadrifin (`workflow_run` lýkur → næsta skref; `repository_dispatch` fyrir handoff).
- **Watchdog:** `schedule` workflow sem AÐEINS athugar fastan lease / týndan atburð / staðnað ástand.
  Heilbrigt → engin aðgerð. Verður ALDREI annar writer.
- **Reconciliation:** lesa raunverulegt repo (git head, CI-status) vs `state.json`, leysa misræmi
  án þess að endurtaka óafturkræfa vinnu.

### 4.11 Threat-model (þ.m.t. prompt injection)
Repo-innihald, issues, commit-skilaboð, CI-logs, ytri texti = **UNTRUSTED DATA**, mega aldrei breyta
policy. Control-instructions búa í workflow/policy, aldrei teknar úr repo-innihaldi. Secrets í GitHub
encrypted secrets (aldrei í kóða/logs/payload). Least-privilege token. Einnota repo.

### 4.12 Kostnaðar-stýringar
Sjá §5. P0–P2 = núll AI-eyðsla (hermdir workers). P3+ = spend-cap + max köll/task + loop-detector,
á bak við OWNER_APPROVAL.

### 4.13 Einangrað test-umhverfi
Nýtt einnota GitHub-repo (t.d. `clubOrchestra-lab`), ótengt öðrum repo-um. GitHub free tier.
Enginn Cloudflare. Ekkert production.

### 4.14 Nákvæm acceptance-próf
1) Planner býr til 1 afmarkað task. 2) Worker keyrir headless, skilar structured evidence.
3) CI-niðurstaða → atburður sjálfkrafa. 4) Planner vaknar, staðfestir exact-SHA + evidence, gefur
næsta task. 5) ≥2 verk í röð án „continue". 6) 1 approval-aðgerð stöðvar + spyr. 7) tvítekinn
webhook → engin tvíverknaður; stale-SHA → engin vinna. 8) endurræsing → reconcile. 9) circuit
breaker eftir N FAIL. + P5 bilanapróf (§7).

### 4.15 Hvað má byggja/prófa með NÚLL production-aðgangi OG núll kostnaði
Allt P0–P2: control plane, hermdir workers, GitHub-lúppa. Engir API-lyklar, engin eyðsla, ekkert
annað verkefni snert. Aðeins P3+ þarf lykla (kostnaðar-hlið).

## 5. Kostnaðar-hlið (skýr mörk)

| Fasi | Kostar? | Krefst samþykkis? |
|------|---------|-------------------|
| P0 rannsókn | Nei | Nei |
| P1 control plane (hermdir workers) | Nei (GitHub free) | Nei |
| P2 GitHub-lúppa (hermdir workers) | Nei | Nei |
| Stofnun einnota repo + secrets | Nei (frítt) | **Já** (nýtt aðgangs-/secret-mál) |
| P3+ raunverulegir agentar (OpenAI + Anthropic API) | **Já — API-köll** | **Já + spend-cap** |

Regla: ekkert sem kostar er virkjað án skýrs „já" frá Product Owner.

## 6. Færanleiki (skilyrði #3, tryggt með hönnun)

Allt control-plane-ið = eitt repo-sniðmát. Ný verkefni fá sitt eigið einangraða afrit. Enginn
sameiginlegur gagnagrunnur, engin sameiginleg slóð, ekkert harðvírað inn í önnur verkefni.
„Taktu sniðmátið, afritaðu í nýtt repo" = öll endurnýting.

## 7. Lifandi vinnuplan (backlog)

### IN_PROGRESS
- **P0 — Getu-rannsókn + arkitektúr-ákvörðun.** Staðfest báðum megin (Claude headless + OpenAI
  Responses). State-store ákveðið (GitHub-native). — *NOT_VERIFIED þar til Product Owner staðfestir
  ákvarðanir §3.*

### NEXT
- **P1 — Control plane með hermdum workers:** state.json, event-envelope, idempotency
  (processed_events), lease (concurrency + blob-SHA), audit-log, approval-gate, circuit breaker.
  Engir raunverulegir AI. (Frítt.)

### BACKLOG
- **P2** GitHub-lúppa á einnota repo (hermdir workers): task→commit→CI→webhook→control plane→review.
  Sanna exact-SHA, tvítekinn atburð, stale-SHA, CI-fail, reconcile. (Frítt.)
- **P3** Skipta inn raunverulegum agentum (Claude headless worker, OpenAI planner). (Kostnaður.)
- **P4** Lokuð lúppa: goal→plan→task→commit→CI→review→task#2→CI→complete, án „continue". **Lykilsönnun.**
- **P5** Bilanapróf: tvítekinn webhook, stale-SHA, CI-fail, worker-timeout fyrir/eftir commit,
  planner-timeout, ógildur/vantar-reit atburður, illgjarn prompt í repo, árekstur writer-a,
  endurtekin-fail lúppa, approval-aðgerð, watchdog heilbrigður vs. raunverulegt stall. Allt fail-safe.

### OWNER_APPROVAL_REQUIRED
- Stofnun einnota GitHub-repo (`clubOrchestra-lab`) + GitHub encrypted secrets.
- Síðar: virkja OpenAI- + Anthropic-API-lykla með spend-cap (P3-hlið).

### BLOCKED
- (ekkert)

### DONE
- (ekkert enn — P0 bíður VERIFIED staðfestingar Product Owner.)

---

## 8. Skjöl (byrja á fáum)
Þetta skjal er canonical v0.1 (hönnun + plan í einu). Þegar það stækkar klofnar það í:
`ARCHITECTURE.md · SECURITY_MODEL.md · CURRENT_STATUS.md` + þennan vinnuplan. Status-merki:
PLANNED / IMPLEMENTED / TESTED / E2E_VERIFIED / DISABLED. Kóði og skjöl segja sömu sögu í sama commit.

**Meginregla:** minnsta sem sannar örugga, atburðadrifna, 2-skrefa framvindu. Ekki ofhanna.
Engin endalaus sjálfvirk lúppa — hvert skref þarf ástæðu.
