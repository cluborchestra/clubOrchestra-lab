# clubOrchestra — PM handoff
Status: ACTIVE
Updated: 2026-10-05
Owner: PM
Canonical source: NO. Afleitt af docs/clubOrchestra_verkefna_og_vinnuplan.md + docs/PROJECT_STATUS.json

## CURRENT STATE
**Review-Dispatch Loop (áfangi P4)** er VERIFIED LIVE á GitHub með **hermdum** workers. Engir
raunverulegir agentar eru til, engir lyklar, og eytt hefur verið 0 USD.

## CURRENT PRODUCTION
- **`main`:** `1597f1b`, varin.
- **Orchestrator:** armaður (`ORCHESTRATOR_ENABLED=true`).
- **`orchestra-state`:** `66cee56`, `WAITING_EVENT` (bíður worker á `CO-SIM-002`). Þetta er
  samþykktur stöðvunarpunktur.

## ACCEPTANCE
| Áfangi | Staða |
|---|---|
| P1 | ACCEPTED |
| P2a | ACCEPTED |
| P2b | VERIFIED LIVE (hermdir workers) |
| P3 Lot 1 | ACCEPTED |
| P3 Lot 2 | ACCEPTED |
| P3 Lot 2b + escalation | Í QA: 120/120 próf græn, staðbundið |

Tvítekningarprófið er VERIFIED í dry-run; live-útgáfan er frestuð (B5).

## OPEN WORK
- **`feat/co-p3-lot2b-async`:** Lot 1, 2 og 2b, staflað. Pushuð; ekki mergeuð, og PR ekki opnað.
- **`docs/co-p2b-e2e-status`:** pushuð; PR ekki staðfest.

## NOW
QA á CO-P3-LOT2B-001 ([evidence](../evidence/CO-P3-LOT2B-001.md)).

## NEXT
1. Merge PRs (docs, síðan P3), með merge commit.
2. Lot 3, eftir samþykki.

## LATER
B1 tilkynningar · B2 OWNER_CARD · B3 samþykki í issue · B4 watchdog · B6–B7 snyrting · P5 bilanapróf.

## BLOCKERS
B5: live tvítekningarpróf bíður heilbrigðra GitHub runners.

## PRODUCT OWNER DECISIONS REQUIRED
1. **Lot 3 (kostar peninga):**
   1. spend-cap;
   2. **budget hjá veitendum (SKYLDA);**
   3. lyklar í `agents-planner` / `agents-worker`;
   4. verð planner-módels;
   5. undanþága fyrir `src/agents/live.js`.
2. Merge á biðgreinum.
3. Tímasetning B5.
4. Merking á spec v0.1 (*superseded* eða skjalasafn).

## IMPORTANT BOUNDARIES
- Ekkert kostar án „já“ frá Ása.
- Ekkert fer í `main` beint. Ekkert er pushað á `co/` án samþykkis fyrir keyrsluna, því
  orchestrator-inn er armaður.
- Einangrað frá netoryggi@ og p9@. Commits nota noreply-netfang.
- Vafi → til Ása (fail-closed).
