# clubOrchestra — samantekt verkefnis v1.0

**Dagsetning:** 2026-10-05 · **Eigandi (PO):** Ási · **Repo:** https://github.com/cluborchestra/clubOrchestra-lab (opið)
**Staðall:** bráðabirgðasnið; aðlagað þegar staðall frá Ása berst.

## 1. Tilgangur (orðréttur, gildir umfram allt annað)

> Tvær gervigreindir frá tveimur framleiðendum (OpenAI planner + Claude worker) vinna
> saman svo að annar grípi villur sem hinn sér ekki. Allt sem Ási þarf ekki að svara er
> afgreitt sjálfvirkt ("white noise"). Til Ása fer EINGÖNGU:
>   - kostnaður (nýr kostnaður, hækkun þaks, nálgast þak)
>   - breytingar á umfangi (nýir eiginleikar, viðbætur, breytt markmið)
>   - aðgangur að kerfum sem agentar hafa ekki, eða verk sem Ási þarf að framkvæma
>   - óafturkræfar aðgerðir og öryggis-/lyklamál
>   - ALLT sem er vafi um → til Ása (fail-closed)
> Sjálfvirkt: kóðalagfæringar, próf, endurtekningar, CI-villur, refactor innan umfangs.

## 2. Staða í stuttu máli (2026-10-05)

| Áfangi | Staða |
|---|---|
| P0 hönnun | DONE |
| P1 control plane (state machine, idempotency, single-writer, fail-closed, circuit breaker, approval gate, audit) | IMPLEMENTED + TESTED |
| P2a GitHub-lúppa staðbundið | IMPLEMENTED + TESTED |
| P2b GitHub-tenging + fyrsta keyrsla á alvöru GitHub | **Review-Dispatch Loop (áfangi P4): E2E_VERIFIED með hermdum workers.** Stale-SHA no-op og full lúppa sönnuð á GitHub. Live tvítekningarpróf frestað vegna GitHub-atviks (VERIFIED í dry-run). |
| P3 Lot 1 adapterar + kostnaðarvarnir (mock) | IMPLEMENTED + TESTED, ACCEPT |
| P3 Lot 2 replay með raunverulegu API-formi | IMPLEMENTED + TESTED, ACCEPT |
| P3 Lot 2b async kallleið, staðfestir Claude-fánar, escalation-regla í kóða | IMPLEMENTED + TESTED (þessi grein) |
| P3 Lot 3 raunverulegir agentar | BÍÐUR samþykkis Ása (kostar peninga) |
| P4 samþykkt með raunverulegum agentum (≥2 verk í röð) | PLANNED, eftir Lot 3 |

Prófasvítan er **120/120 græn**, öll offline. Nettilgildra fellir hvert próf sem reynir netkall.

## 3. Lykilákvarðanir

| # | Ákvörðun | Hvers vegna |
|---|---|---|
| D1 | Control plane er GitHub-native: staða og audit eru skrár í repo-inu (grein `orchestra-state`). Bakbeinið er GitHub Actions. | Frítt, færanlegt, engin slóð sem hverfur. |
| D2 | Planner = OpenAI Responses API. Worker = Claude Code headless (`claude -p --output-format json`). | Tveir framleiðendur grípa villur hvor annars. |
| D-A | Framleiðslukóði er án dependencies. `openai`-SDK er aðeins devDependency, notað sem dómari í prófum. | Minna yfirborð, færanleiki. |
| D-B | Worker-form = Claude Code headless JSON. `total_cost_usd` er kostnaðurinn. | Það sem Lot 3 keyrir í raun. |
| Async | Öll kallleiðin er `async`; engin sync-brú. | Fyrsta greidda keyrslan prófar aðeins EITT nýtt atriði (live I/O). |
| Escalation | Hver ákvörðun er AUTO eða OWNER. Policy-gólf í kóða sem planner getur aðeins hert. Vafi = OWNER. OWNER: GitHub Issue á `cluborchestra`, og lúppan bíður. | Tilgangurinn: aðeins það sem Ási þarf að svara fer til hans. |
| Kostnaður | SpendGuard tekur frá áætlun fyrir hvert kall (með læsingu) og bókar raunkostnað eftir kallið. Dagsþak miðast við UTC. Óþekktur kostnaður stöðvar. Provider-budget er SKYLDA. | Ekkert raunkall fyrir slysni; þak heldur jafnvel þótt okkar bókhald vanteljist. |
| Lyklar | `OPENAI_API_KEY` er aðeins í environment `agents-planner`, `ANTHROPIC_API_KEY` aðeins í `agents-worker`. Bæði eingöngu fyrir `main`, með Ása sem required reviewer allt Lot 3. | Least privilege og eftirlit. |
| Heiti | Kjarna-lúppan heitir **Review-Dispatch Loop (áfangi P4)**. | Samþykkt af PM/PO 2026-10-05. |

## 4. Hörð skilyrði (óbreytt)
Ekkert kostar án samþykkis Ása. Verkefnið er einangrað frá öðrum verkefnum og netföngum
(netoryggi@, p9@). Ekkert fer beint í `main` (feat + PR). Allt er fail-closed. Payload og úttak
módela eru gögn, aldrei fyrirmæli.

## 5. Tengd skjöl
- [Virknilýsing v1.0](clubOrchestra_virknilysing_verkefnis_v1.0.md)
- [Verkefna- og vinnuplan v1.0](clubOrchestra_verkefna_og_vinnuplan_v1.0.md)
- Tæknileg staða: [CURRENT_STATUS.md](../CURRENT_STATUS.md) · Öryggi: [SECURITY_MODEL.md](../SECURITY_MODEL.md)
- Upprunalegt spec: [clubOrchestra_verkefna_og_vinnuplan_v0.1.md](../clubOrchestra_verkefna_og_vinnuplan_v0.1.md) (óbreytt; Ási uppfærir §7)
