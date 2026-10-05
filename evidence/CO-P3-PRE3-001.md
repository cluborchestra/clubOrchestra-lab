# Evidence — CO-P3-PRE3-001
Status: FOR QA
Updated: 2026-10-05
Owner: Claude Code (framkvæmd) · rýni: PM
Canonical source: NO. Evidence; staðan er í docs/PROJECT_STATUS.json og docs/clubOrchestra_verkefna_og_vinnuplan.md (v1.2)

**Grein:** `feat/co-p3-pre3-001`, staflað ofan á `4e0c8d0`. **Kóði og skjöl:** commit
`16025a1bf34dc93bd832a0c8355c66619228ca59`.

**Niðurstaða:** öll þrjú atriðin eru útfærð og prófuð. Prófasvítan er **143/143 græn**, þar af 23
ný. Ekkert net, engir lyklar, ekkert módelkall og enginn kostnaður. Ekkert á `co/`, ekkert í
`main`. Ný workflow hafa ekki keyrt á GitHub. `issue_comment` keyrir aðeins af `main`, svo live
staðfesting kemur eftir merge.

## Tvennt sem PM þarf að vita fyrst
1. **Ný, þröng undanþága frá offline-prófinu.** Til að fá „raunverulegan diff“ verður control
   plane að keyra `git`.
   - `src/gitDiff.js` er eina skráin í `src/` sem má ræsa ferli: aðeins
     `execFileSync('git', [...])` með `shell: false`, og aðeins `diff` og `cat-file` (lesa,
     staðbundið, `--no-ext-diff --no-textconv`).
   - Offline-prófið staðfestir hvert atriði og bannar netskipanir (fetch, push, clone, remote,
     ls-remote …).
   - Valkosturinn var að lesa git-pack-skrár í hreinu JS. Það hefði verið mun stærra og
     áhættusamara.
2. **Tvær nýjar færslur í ástandsvélinni:**
   - `WAITING_EVENT → WAITING_APPROVAL`: halda niðurstöðu sem snertir verndað;
   - `WAITING_APPROVAL → WAITING_EVENT`: halda áfram eftir samþykki.

   Báðar eru prófaðar, og P1-prófin eru óbreytt og græn.

## 1) Verndaðar slóðir: policy-gólf á raunverulegum diff
- **Gólfið, harðkóðað** (`src/protectedPaths.js` `FLOOR`):
  - `.github/**` og `config/**`;
  - `src/escalation.js`, `src/agents/spendGuard.js`, `src/agents/limits.js` og
    `src/agents/live.js` (framtíðarskrá);
  - `src/fileLock.js` og `test/support/no-network.js`;
  - `package.json` og `package-lock.json`;
  - `docs/PROJECT_STATUS.json` og `docs/CLUB_DOCUMENTATION_STANDARD.md`.
- **Config:** `config/protection.json` getur aðeins **bætt við** (`extra_protected_paths`), og
  skráin er sjálf vernduð. Reitur eins og `remove` hefur engin áhrif (prófað).
- **Hvar athugað er:**
  - **Í control plane, eftir worker:** þegar CI-niðurstaða fyrir nákvæmt SHA berst og haus greinar
    passar.
  - **Diff-inn:** `git diff --raw -z -M --no-abbrev base..head`, þar sem `base` = `expected_sha` og
    `head` = commit worker. Diff-inn tekur til rename-greiningar, modes og symlink-targets (úr
    `cat-file`).
  - **Worker stjórnar ekki athuguninni:** í prófinu segir hann `files_changed: ["work/…"]` en skrifar
    í `.github/…`, og það greinist.
- **Snerting:**
  - **OWNER/security:** niðurstaðan er haldin í `WAITING_APPROVAL`. Hvorki rýni né næsta verk fer af
    stað.
  - **Approval og issue:** approval `<verk>.protected.<sha12>` er skrifað, og issue-beiðni á
    `cluborchestra` með **lista yfir skrár**.
  - **Samþykkt:** sama niðurstaða fer í rýni.
  - **Hafnað:** BLOCKED.
  - **Diff ekki tiltækur:** BLOCKED (fail-closed).
  - **Planner:** getur ekki mildað þetta.
- **Worker system prompt** fær nú: „Do not modify protected paths; request OWNER instead.“
- **Orchestrator** sækir nú alla sögu (`fetch-depth: 0`, `co/*` án `--depth`), svo base-commit sé
  alltaf til staðar.

**Próf (10, öll með raunverulegu git):**
| Próf | Niðurstaða |
|---|---|
| Breyting á `config/agent-limits.json` | M greint |
| Ný skrá `.github/workflows/evil.yml` | A greint |
| Eyðing `src/escalation.js` | D greint |
| Rename INN í `.github/` og ÚT úr `src/escalation.js` | R greint í báðar áttir |
| Symlink á `../config/agent-limits.json`, á `/etc/passwd` og út fyrir repo | greint; meinlaus symlink á README ekki |
| Mode-breyting (`+x`) á verndaðri skrá | greint (100644→100755) |
| Há/lágstafir (`.GitHub/…`, `CONFIG/…`, `Package.JSON`) og `../`, `\`, `./`, algildar slóðir, drif | greint; meinlausar slóðir ekki |
| Gólf í kóða; config lengir eingöngu; approvers úr verndaðri config | staðfest |
| E2E: worker snertir `.github` í laumi → haldið → samþykkt → rýni → COMPLETE | staðfest |
| E2E: hafnað → BLOCKED; diff ekki tiltækur → BLOCKED; repo án diff-veitanda hafnað við smíði | staðfest |

## 2) `/approve` og `/deny` í issue
Reglurnar eru í hreinu falli (`src/ownerCommands.js`) og prófaðar með hermdum atburðum. Skipun gildir
**aðeins** ef **öll** þessi skilyrði halda:
- **a)** `comment.user.login` er á listanum í `config/protection.json` (í dag `cluborchestra`),
  **og** `author_association == "OWNER"`, **og** notandinn er ekki bot.
- **b)** issue-ið var opnað af `github-actions[bot]`, ber **nákvæmlega eitt** falið merki
  `<!-- clubOrchestra:approval_id=… -->`, og er það issue sem outbox-ið okkar skráði fyrir þetta id
  (`issue_url`). `approval_id` kemur **aðeins** úr merkinu, aldrei úr athugasemdinni.
- **c)** approval er enn `pending`. Annars verður engin breyting og svarið er „Already decided“.
  Endurspilaður atburður (sama comment-id) er hljóður no-op.
- **d)** fyrsta lína er nákvæmlega `/approve` eða `/deny`, og ástæða má fylgja. Ekki gilt: tilvitnun
  (`>`), kóðablokk, inndregin lína, eitthvað á undan, aðrir há/lágstafir eða `/approved`.
- **e)** aðeins `created`; breyttar athugasemdir eru hunsaðar.

**Niðurstöður:**
- **Allt annað:** hunsað og skráð í audit (útkoma og id, aldrei textinn), **ekkert svar**.
- **Gild skipun:**
  - approval-skrá á `orchestra-state` fær `status`, `approved_by`, `approved_at`,
    `decision_comment_id`/`_url` og `decision_reason` (sem gögn);
  - bot svarar og lokar issue-inu;
  - `/deny` → control plane BLOCKar verkið.
- **Varaleið:** approval-skráin sjálf.
- **Texti athugasemdar** fer aldrei í skel, planner eða worker (prófað: planner-inntak inniheldur
  hann ekki).

**Próf (9):**
| Próf | Niðurstaða |
|---|---|
| Gilt `/approve` | approved, comment-URL/höfundur/tími skráð, svar + lokun |
| Gilt `/deny` | denied |
| Ókunnugur, COLLABORATOR, eigandalogin sem COLLABORATOR eða MEMBER, bot | hunsað, ekkert svar, óbreytt |
| Rangt issue: ekki frá bot, ekki skráð, merki vantar, tvö merki, PR | hunsað |
| Falsað approval_id í athugasemd | ekki notað; aðeins id úr merki bot-sins |
| Þegar afgreitt / endurspilaður atburður | „Already decided“ / hljóður no-op |
| `/approve` í tilvitnun, kóðablokk, inndregið, ekki fyrst, `/APPROVE`, `/approved`; breytt athugasemd | hunsað |
| Shell-metatákn (`$(rm -rf ~)`, backticks, `;`, `\|`, `&&`, `>`) | geymt sem gögn; aldrei endurvarpað í svari eða audit |
| Texti ákvörðunar nær ekki til planner | staðfest |

**Útdráttur úr `.github/workflows/approval.yml`** (athugasemdir sleppt):
```yaml
on:
  issue_comment:
    types: [created]
concurrency:
  group: clubOrchestra
  cancel-in-progress: false
permissions:
  issues: write
  contents: write
jobs:
  decide:
    if: github.event.issue.pull_request == null
    steps:
      # checkout main + orchestra-state + setup-node (all pinned to commit SHAs)
      - run: node src/cli.js owner-command state/data "$GITHUB_EVENT_PATH" "$RUNNER_TEMP/owner-command"
      - working-directory: state      # record the decision: non-forced push to orchestra-state
        run: git add data … git push origin HEAD:orchestra-state
      - env: { GH_TOKEN: ${{ github.token }}, GH_REPO: ${{ github.repository }} }
        run: |
          out="$RUNNER_TEMP/owner-command"
          [ -f "$out.reply.md" ] || exit 0          # ignored comments: no reply
          num=$(cat "$out.issue"); case "$num" in ''|*[!0-9]*) exit 1 ;; esac
          gh issue comment "$num" --body-file "$out.reply.md"
          if [ -f "$out.close" ]; then gh issue close "$num"; fi
```
**Statískt staðfest:**
- engin secrets og ekkert `pull_request_target`;
- `github.event.comment` kemur hvergi fyrir í workflow-inu;
- engin `${{ … }}` í `run:`-blokkum;
- aðeins eitt push, og það á `orchestra-state`;
- actions festar á commit-SHA.

## 3) Fest Claude Code CLI-útgáfa
- **Aðferð:** npm-pakkinn `@anthropic-ai/claude-code@2.1.286` í `.github/workflows/worker.yml`.
  Sama gildi er í `config/agent-limits.json` (`claude_code.version`, vernduð), og próf heldur þeim
  jöfnum.
- **Skrefið strax á eftir:**
  `node src/cli.js check-claude-version "$(claude --version)"`. Það fellur nema úttakið sé nákvæmlega
  `2.1.286 (Claude Code)`; prófað með 2.1.287, `2.1.286`, `2.1.2860 …`, bilum, auka línum og tómu.
- **Úttaksformið** passar við raunverulegt `claude --version` (2.1.286 úr skrifborðsforritinu).
- **`worker.yml` er beinagrind og óvirk:**
  - `if: vars.WORKER_ENABLED == 'true'`, sem er óstillt;
  - kveikt aðeins með `repository_dispatch`;
  - `permissions: contents: read`;
  - engin secrets og ekkert environment;
  - ekkert `claude -p` í neinu workflow (prófað).
- **Óstaðfest:** að npm-pakkinn setjist upp á runner. Ekkert var sótt; fyrsta keyrsla staðfestir
  það og útgáfuathugunin fellur annars.

## Prófaúttak (`npm test` á `16025a1`)
```
tests 143 · pass 143 · fail 0 · cancelled 0 · skipped 0
control-plane 28 · p2a-github-loop 19 · p2b-github-wiring 5 · p3-escalation 14 · p3-lot1-agents 16
p3-lot2-replay 19 · p3-lot2-sdk-judge 16 · p3-pre3 23 (ný) · single-writer 3
```
- Local harness og crash/restart enda enn á sama SHA (`a7f682e…`).
- Nettilgildra er virk í hverju prófaferli.

## Staðfesting
- **Ekkert net:**
  - nettilgildran í allri svítunni;
  - engin `process.env` eða `fetch(` í `src/`;
  - `child_process` aðeins í `src/gitDiff.js` (staðbundið git, prófað).
- **Engir lyklar:** engin secrets í neinu workflow (prófað); canary-prófin úr Lot 2 standa.
- **Ekkert á `co/` og ekkert í `main`.** Push-niðurstaða er neðst.

## Áhætta og eftirfylgni
1. **Endurræsing eftir `/approve` (B8):** lúppan heldur í dag fyrst áfram við næstu
   orchestrator-keyrslu. Í Lot 3 sendir approval-workflow `repository_dispatch` (`GITHUB_TOKEN` má
   það), og orchestrator hlustar á það.
2. **`approval.yml` deilir concurrency-hópi** með orchestrator, svo fyrri niðurstaðan um að aðeins
   ein bíðandi keyrsla haldist á líka við hér. Lagfæring er í Lot 3 (§4a).
3. **Live staðfesting** á issue-opnun, `/approve` og CLI-uppsetningu kemur eftir merge og fyrsta
   tilvik.

## Push
_(fyllt út eftir push)_
