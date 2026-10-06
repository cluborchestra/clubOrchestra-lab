# Evidence — CO-P3-PRE3B-001
Status: FOR QA
Updated: 2026-10-06
Owner: Claude Code (framkvæmd) · rýni: PM
Canonical source: NO. Evidence; staðan er í docs/PROJECT_STATUS.json og docs/clubOrchestra_verkefna_og_vinnuplan.md (v1.3)

**Grein:** `feat/co-p3-pre3-001` · **Kóði og skjöl:** `eea57e42c1ed5f17be2255df914cd639a889764e`

**Niðurstaða:** skilyrðið er uppfyllt, og vörnin ver nú sjálfa sig. Prófasvítan er **146/146 græn**,
þar af 3 ný. Ekkert net, engir lyklar og ekkert á `co/` eða í `main`. Eitt PR er undirbúið, en
ekki opnað og ekki mergeað.

## PRE3b: gólfið útvíkkað (`src/protectedPaths.js` `FLOOR`)
**Bætt við:**
- `src/**`: protectedPaths, gitDiff, ownerCommands, controlPlane, states og allt annað í `src/`;
- `test/support/**`;
- `.gitattributes` og `.gitmodules`.

Eldri nafngreindar færslur halda sér, viljandi, svo kjarnareglurnar sjáist með nafni. Worker-verk í
þessu repo skrifa í `work/`, svo útvíkkunin kostar ekkert.

**Próf:**
| Próf | Niðurstaða |
|---|---|
| Worker breytir `src/protectedPaths.js` í laumi (skýrsla hans segir `work/…`) | haldið, OWNER/security (policy) |
| Worker bætir við `.gitattributes` í laumi | haldið, OWNER/security |
| `work/**` (venjuleg lúppa) | AUTO: COMPLETE, ekkert haldið, ekkert issue |
| Slóðapróf | `src/*`, `SRC/x.js`, `test/support/*` og `.GITATTRIBUTES` verndað; `work/`, `docs/`, `harness/` og önnur próf ekki |

**Skjöl:**
- aðalskjal **v1.3**: §4 verndaðar slóðir, §12, §14 með Lot 3 eftirfylgni (B8 + concurrency), §18;
- SECURITY_MODEL §4c, PM_HANDOFF og PROJECT_STATUS.

## Prófaúttak (`npm test` á `eea57e4`)
```
tests 146 · pass 146 · fail 0
```

## Eitt PR: `feat/co-p3-pre3-001 → main` (undirbúið, EKKI opnað, EKKI mergeað)
- **Umfang:** 13 commits ofan á `main` `1597f1b` (merge-base = main), 84 skrár.
- **Prufu-merge** (`git merge-tree`): **engir árekstrar**.
- **Docs-greinin:** PR-ið nær líka yfir `docs/co-p2b-e2e-status` (`2c363ae` er í staflanum), svo
  ekki þarf sér PR fyrir hana.
- **Áður en opnað er:** þegar PR er opnað keyrir CI á því (`pull_request`), og orchestrator-keyrslan
  sem það ræsir endar sem *skipped*.

**Opna (Ási, þegar Actions er stöðugt):**
https://github.com/cluborchestra/clubOrchestra-lab/compare/main...feat/co-p3-pre3-001?expand=1

Þú afritar titil og texta hér að neðan. Merge-aðferð: **„Create a merge commit“**.

**Titill:**
```text
P3: Lot 1–2b + PRE3/PRE3b → main (agent-lag, kostnaðarvarnir, escalation, verndaðar slóðir, /approve)
```

**Texti:**
```markdown
Sameinar P3-staflann inn í `main`: docs (P2b live-evidence) → Lot 1 → Lot 2 → Lot 2b + skjölun → PRE3 → PRE3b. Öll stig eru samþykkt af PM/PO nema PRE3b, sem er í QA.

## Merge-aðferð
**Notaðu „Create a merge commit“.** Það varðveitir SHA allra commits, sem evidence vísar í. Squash og rebase myndu brjóta þær tilvísanir.

**Ekki mergea fyrr en:**
- GitHub Actions er stöðugt;
- CI á þessu PR er grænt;
- Ási hefur samþykkt.

## Innihald
- **Lot 1:** AgentAdapter-lag + spend-cap/rate/loop-detector (mock).
- **Lot 2:** replay með raunverulegu API-formi. OpenAI Responses-planner (zero-dep, `openai` SDK aðeins sem dómari í prófum) og Claude Code headless-worker.
- **Lot 2b:** async kallleið, Claude-fánar staðfestir gegn 2.1.286, escalation-regla AUTO/OWNER með issue-beiðnum, og skjölun eftir club-staðli (`docs/`).
- **PRE3:**
  - verndaðar slóðir á raunverulegum diff (`src/gitDiff.js`, samþykkt undanþága);
  - `/approve` og `/deny` í issue (`approval.yml`);
  - fest Claude Code CLI 2.1.286 (`worker.yml`, óvirkt).
- **PRE3b:** gólfið ver sjálft sig (`src/**`, `test/support/**`, `.gitattributes`, `.gitmodules`).

## Hvað breytist á `main` við merge
- **`orchestrator.yml`** (keyrir þegar `ORCHESTRATOR_ENABLED=true`, sem er stillt í dag):
  - full saga (`fetch-depth: 0`) fyrir diff-athugun;
  - athugun á verndaðum slóðum;
  - skref sem opnar OWNER-issues (`issues: write`).
- **`approval.yml` verður virkt:** `issue_comment` keyrir aðeins af `main`. Engin secrets.
- **`worker.yml` er áfram óvirkt:** `WORKER_ENABLED` er óstillt, engin secrets og ekkert módelkall.
- **Live staða** á `orchestra-state` (`66cee56`, bíður worker á CO-SIM-002) er samhæfð nýja kóðanum. Nýju reitirnir vantar þar, og það er meðhöndlað.

## Öryggi
- Engir lyklar, ekkert módelkall og enginn kostnaður.
- `pull_request_target` er hvergi notað.
- Texti athugasemda og issue fer aldrei í skel, planner eða worker.
- Orchestrator er armaður. **Ekkert push á `co/` án samþykkis fyrir keyrsluna.**

## Próf
`npm test`: **146/146** græn staðbundið, offline, með nettilgildru í hverju prófaferli. CI keyrir á þessu PR (`pull_request`). Orchestrator-keyrslan sem það ræsir endar sem *skipped*, því hún kemur ekki af `push`.

## Evidence (SHA-permalinks)
- Lot 2b: https://github.com/cluborchestra/clubOrchestra-lab/blob/4e0c8d0408d79e8780b51ecd3cefafc0b07af03d/evidence/CO-P3-LOT2B-001.md
- PRE3: https://github.com/cluborchestra/clubOrchestra-lab/blob/1ded1af7e0f48e6074ff16a491e7c0382fc20807/evidence/CO-P3-PRE3-001.md
- PRE3b: sjá `evidence/CO-P3-PRE3B-001.md` á þessari grein.

## Eftirfylgni í Lot 3 (ekki í þessu PR)
- B8: endurræsing eftir `/approve`.
- `concurrency` á `ingest`-jobbið + watchdog.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Push
- `git push origin feat/co-p3-pre3-001`: haus `7bae2d0` (kóði `eea57e4` + evidence). Auðkenni er
  `cluborchestra` með noreply-netfangi.
- **Engin Actions-keyrsla ræstist:** heildarfjöldinn var 5 fyrir push og 5 mínútu eftir.
- **Opin PR:** 0. PR-ið er aðeins undirbúið, eins og beðið var um.
- **Óbreytt á remote:** `main` = `1597f1b`, `orchestra-state` = `66cee56`,
  `co/CO-SIM-001` = `d59516a`. Engin ný `co/` grein.
