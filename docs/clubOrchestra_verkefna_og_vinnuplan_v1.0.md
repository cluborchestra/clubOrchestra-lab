# clubOrchestra — verkefna- og vinnuplan v1.0

**Dagsetning:** 2026-10-05 · Tekur við af v0.1 sem vinnuplan. Hönnunin í v0.1 gildir áfram og §7
þar er Ása að uppfæra.
**Status-merki:** PLANNED · IMPLEMENTED · TESTED · E2E_VERIFIED · OWNER_APPROVAL_REQUIRED · DONE.

## 1. LOT 2b: lokið á þessari grein (`feat/co-p3-lot2b-async`)

| Verk | Staða |
|---|---|
| Async kallleið í stað sync-brúar; öll fyrri próf græn | TESTED |
| `claude --version` / `--help` (2.1.286). `--allowedTools` staðfest (kommu- eða bilaðgreint). `--max-turns` **ekki til** í 2.1.286, svo fjarlægt og `--max-budget-usd` sett í staðinn. Auk þess `--bare` og `--permission-prompts none`. | VERIFIED (hjálpartexti) |
| Escalation-reglan í kóða: AUTO/OWNER, policy-gólf, vafi = OWNER; OWNER → GitHub Issue á `cluborchestra` + bið | TESTED (14 próf) |
| Environments passa við raunverulegar greinar (`workflow_run` og `repository_dispatch` keyra á `main`) | DOCUMENTED |
| Provider-budget gert að SKYLDU í Lot 3 | DOCUMENTED |
| Íslensk skjöl: samantekt, virknilýsing, vinnuplan (v1.0) | DONE |

Prófasvítan er 120/120 græn, offline.

## 2. LOT 3: raunverulegir agentar (kostar peninga; OWNER_APPROVAL_REQUIRED)

Röðin skiptir máli. Ekkert hefst fyrr en Ási samþykkir.

1. Ási samþykkir Lot 3 og spend-cap.
2. Ási stofnar sérstakt OpenAI-project og Anthropic-workspace, og býr til tvo lykla.
3. **SKYLDA:** budget hjá veitendum (OpenAI project budget, Anthropic spend limit), ≤ dagsþak × 30.
4. GitHub environments: `agents-planner` (`OPENAI_API_KEY`) og `agents-worker`
   (`ANTHROPIC_API_KEY`). Bæði eingöngu fyrir `main`, með Ása sem required reviewer allt Lot 3.
5. Rauntölur í `config/agent-limits.json` (í gegnum PR):
   - verð fyrir planner-módelið;
   - dagsþak;
   - per-call þak (sem er jafnframt `--max-budget-usd` worker).
6. Ein undanþegin skrá, `src/agents/live.js`: live transport (`await fetch`) og live
   `claude`-runner.
7. Worker-workflow: `outbox/` → `repository_dispatch` → worker-jobb (environment `agents-worker`).
8. **Lagfæring úr Lot 2b-niðurstöðu:** `concurrency` á `ingest`-jobbið í stað alls workflow-sins
   (annars getur PR-CI hætt við bíðandi keyrslu), og watchdog.
9. Fyrsta supervisaða keyrslan: eitt verk, með reviewer-hliðinu á. Hún staðfestir:
   - úttaksform `claude -p` og exit codes;
   - að raunkostnaður sé bókaður.
10. P4-samþykkt: ≥2 verk í röð með raunverulegum agentum. Þá verður Review-Dispatch Loop
    E2E_VERIFIED með raunverulegum agentum.

## 3. Backlog (ekki hafið)

| # | Verk | Athugasemd |
|---|---|---|
| B1 | Tilkynningar til eiganda: BLOCKED, þörf á samþykki, >80% af dagsþaki → GitHub Issue á `cluborchestra` | Notar `GITHUB_TOKEN`. Aldrei netoryggi@ / p9@. OWNER-ákvarðanir eru þegar komnar (Lot 2b); BLOCKED og 80% eftir. |
| B2 | `OWNER_CARD.md`: ein síða á mannamáli eftir langt hlé (neyðarrofi, samþykki, hvar staðan sést, lyklaendurnýjun) | |
| B3 | Samþykki í gegnum issue (label eða athugasemd frá `cluborchestra`) í stað þess að breyta approval-skrá | Auðveldara fyrir Ása |
| B4 | Watchdog `schedule`: stöðnun → reconcile, aldrei annar writer | Tengist B1 og Lot 3 lið 8 |
| B5 | Live tvítekningarpróf: endurkeyra orchestrator run 37358037144 þegar GitHub Actions er stöðugt | VERIFIED í dry-run |
| B6 | Snyrting: handoff `repo` í CLI-planner = `cluborchestra/clubOrchestra-lab` | Útlit eingöngu |
| B7 | Strangari útdráttur ef Claude vefur JSON-svar í texta | Ef Lot 3 sýnir þörf |
| P5 | Bilanapróf (spec §7) | Eftir P4 |

## 4. Afhendingarregla
Hvert verk fer á feat-grein og síðan PR. Ekkert fer í `main` beint, og ekkert er pushað á `co/` án
samþykkis fyrir þá keyrslu. Evidence fer í `evidence/<verk>.md` og Ási fær einn hlekk.
