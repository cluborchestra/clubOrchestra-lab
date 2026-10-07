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
| P3 Lot 2b + escalation + skjölun | ACCEPTED |
| PRE3 (verndaðar slóðir, `/approve`, fest CLI) | ACCEPTED (2026-10-06) |
| PRE3b (vörnin ver sjálfa sig: `src/**`, `test/support/**`, `.gitattributes`, `.gitmodules`) | ACCEPTED (2026-10-06) |
| CO-P3-FREE-001 (frí leið: Claude Max + ChatGPT/Codex) | ACCEPTED (PM 2026-10-07) |
| CO-P3-FREE-002 (staðbundinn runner + keyrsluskrifta) | Í QA: 16 ný próf (fölsuð CLI); 171/171 græn. Ekkert módelkall. Próf 1 bíður þess að Ási ræsi það |

Tvítekningarprófið er VERIFIED í dry-run; live-útgáfan er frestuð (B5).

## OPEN WORK
- **`feat/co-p3-pre3-001`:** docs + Lot 1, 2, 2b + PRE3 + PRE3b (staflað). Pushuð. **Eitt PR undirbúið → `main`**: ekki opnað og ekki mergeað. Ási opnar og samþykkir þegar Actions er stöðugt. PR-ið nær líka yfir `docs/co-p2b-e2e-status` (`2c363ae` er í staflanum).
- **`docs/co-p2b-e2e-status`:** pushuð; PR ekki staðfest.

## NOW
QA á CO-P3-FREE-002 ([evidence](../evidence/CO-P3-FREE-002.md)). Þegar samþykkt: Ási skráir sig inn og ræsir próf 1 (`node harness/run-local-free.js --start`).

## NEXT
1. Opna og mergea eina PR-ið (`feat/co-p3-pre3-001 → main`, merge commit) þegar Actions er stöðugt. Þá virkjast `approval.yml`.
2. Lot 3, eftir samþykki.

## LATER
B1 tilkynningar · B2 OWNER_CARD · B4 watchdog · B8 endurræsing eftir `/approve` · B6–B7 snyrting · P5 bilanapróf.

## BLOCKERS
B5: live tvítekningarpróf bíður heilbrigðra GitHub runners.

## PRODUCT OWNER DECISIONS REQUIRED
1. **Lot 3 (kostar peninga):**
   1. spend-cap;
   2. **budget hjá veitendum (SKYLDA);**
   3. lyklar í `agents-planner` / `agents-worker`;
   4. verð planner-módels;
   5. útvíkkun `src/agents/live.js` (í dag aðeins staðbundinn áskriftar-runner) með greiddum transport.
2. Merge á biðgreinum.
3. Tímasetning B5.
4. Approvers-listi (í dag aðeins `cluborchestra`).
5. **Frí leið:** (a) Ási ræsir próf 1 sjálfur eftir innskráningu (skref í evidence/CO-P3-FREE-002.md); (b) samþykkja eða hafna plani fyrir próf 2 (raunverulegt forritunarverk) eftir niðurstöðu prófs 1.

## IMPORTANT BOUNDARIES
- Ekkert kostar án „já“ frá Ása.
- Ekkert fer í `main` beint. Ekkert er pushað á `co/` án samþykkis fyrir keyrsluna, því
  orchestrator-inn er armaður.
- Einangrað frá netoryggi@ og p9@. Commits nota noreply-netfang.
- Vafi → til Ása (fail-closed).
- Worker breytir aldrei verndaðri slóð án OWNER; `src/**` og varnirnar sjálfar eru verndaðar. `/approve` gildir aðeins frá eiganda á bot-issue.
- Hlekkir til PM: permalink með commit-SHA, aldrei greinarheiti.
