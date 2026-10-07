# Evidence — CO-P3-FREE-002 (staðbundinn runner + keyrsluskrifta fyrir fría leið)
Status: FOR QA
Updated: 2026-10-07
Owner: Claude Code (framkvæmd) · rýni: PM
Canonical source: NO. Evidence; staðan er í docs/PROJECT_STATUS.json og docs/clubOrchestra_verkefna_og_vinnuplan.md (v1.5)

**Grein:** `feat/co-p3-free-002` (ofan á `feat/co-p3-free-001`). **Kóði, próf og skjöl:** commit
`07237ae35ab3793c2d66f8a667f76dbdfc34b6c0`.

**Niðurstaða:**
- Samþykkt (a) er byggt: `src/agents/live.js` og `harness/run-local-free.js`.
- Viðbætur 1–3 eru útfærðar: slóðareglur og lespróf, plan fyrir próf 2, og innskráningar- og kvótaathugun.
- Prófasvítan er **171/171 græn**, þar af 16 ný. Þau keyra raunveruleg ferli, git-klón og commit, en
  gegn **fölsuðum CLI-forritum**: ekkert módel og ekkert net.
- **Ekkert módelkall var gert.** Engin innskráning, enginn kostnaður. Ekkert á `co/` eða í `main`.
- **Próf 1 er tilbúið en ekki keyrt.** Ási ræsir það eftir innskráningu (skref hér að neðan).

## 1) Hvað var byggt
| Hluti | Hvað hann gerir |
|---|---|
| `src/agents/live.js` | Eina agent-skráin sem ræsir `codex`/`claude`. Neitar að keyra í CI (`CI`/`GITHUB_ACTIONS`). Umhverfi barnaferla er **leyfislisti**, svo enginn lykill, token, base-URL eða `NODE_OPTIONS` kemst í gegn; `CODEX_HOME` er sett sérstaklega. Hún notar `shell: false`, tímamörk sem drepa ferlatréð (Codex 3 mín., Claude 10 mín.) og þak á úttak (4 MB). Skema-, settings- og `-o`-skrár fara í scratch-möppu **utan** klónsins; óútfylltur staðgengill stöðvar kallið áður en ferli fer af stað. |
| Hamur `local-subscription` (`limits.js`, `spendGuard.js`) | Tekur aðeins `{ subscription: true }`-færslur og 0 USD þök, og worker-reglur aðeins `Read(./…)`/`Edit(./…)`. Greidd leið er því ekki stillanleg. Guard hafnar API-lykla-Claude (`claude-code-headless`) áður en ferli fer af stað. |
| `config/agent-limits.local-free.json` | Mörk staðbundnu keyrslunnar: planner 4 köll, worker 2, `Read(./**)`, `Edit(./**)`. Sjálfgefin config (CI, orchestrator) er óbreytt: `mock`. |
| Claude á áskrift (`claudeCode.js`) | `-p --safe-mode --restricted --tools Read,Edit,Write,Glob,Grep --strict-mcp-config --settings {SETTINGS_FILE} --output-format json --permission-prompts none --allowedTools Read(./**),Edit(./**)`. Settings: `permissions.blockReadsOutsideWorkingDirectories: true`. |
| Kvóta- og innskráningarkóðar (`errors.js`, `codexExec.js`, `claudeCode.js`) | `QUOTA_EXHAUSTED` og `AUTH_REQUIRED`, greint úr texta CLI. Óþekktur texti fellur samt lokað (`PLANNER_EXIT`, `WORKER_*`). |
| `AgentPlanner` `goal` | Verklýsing eigandans fer í plan-kallið sem gögn. Handoff er staðfest eins og áður. |
| `harness/run-local-free.js` | Keyrslan sjálf. Án `--start` gerir hún ekkert. |

## 2) Viðbót 1: lesaðgangur og slóðareglur
**Setningafræði, staðfest:**
- `claude --help` 2.1.289 sýnir aðeins dæmið `"Bash(git *) Edit"` fyrir `--allowedTools`. Slóðareglur
  eru ekki í help.
- Í **skjölun** (code.claude.com/docs/en/permissions, sótt 2026-10-07):
  - `Read`/`Edit`-reglur nota gitignore-setningafræði, og `./path` er miðað við núverandi möppu.
  - Reglur úr CLI-fánum eru festar við aðalvinnumöppuna.
  - **`Edit`-regla nær líka yfir `Write`-verkfærið. `Write(path)`-regla er samþykkt en aldrei
    skoðuð**, og ræsing varar við henni.
- Þess vegna er `Write(./**)` úr beiðni PM útfærð sem `Edit(./**)`. Valideringin hafnar `Write(...)`.

**Lagskipt vörn, því ein regla dugar ekki:**
1. `--restricted` (help 2.1.289): fjarlægir Bash, PowerShell, REPL og önnur kóðaverkfæri. Hún bindur
   skráaverkfæri við vinnumöppur, hunsar user/project/local settings og lætur aðeins manneskju samþykkja
   skrif í settings, git og tool-config.
2. `--tools Read,Edit,Write,Glob,Grep` (help): engin skel.
3. `--settings` með `blockReadsOutsideWorkingDirectories: true`. Skjölun segir að sú stilling láti
   skráaverkfæri neita slóðum utan vinnumöppu í öllum heimildahömum, og help segir að `--settings`
   gildi áfram undir `--restricted`.
4. `--allowedTools Read(./**),Edit(./**)` og `--permission-prompts none`.
5. cwd er einnota klón í `%TEMP%`, án remote og án `--add-dir`.

**Frávik frá samþykktu FREE-001-plani (þrengir, víkkar ekki):** worker fær **ekkert** `Bash(npm test)` eða
`Bash(git …)`. Ástæða: `Bash(git diff *)` leyfir t.d. `git diff --no-index <skrá utan klóns>`, og skjölun
segir að Bash-reglur séu ekki öryggismörk. Í staðinn gerir **runner** þetta:
- athugar raunverulegu breytinguna: hver skrá innan `allowed_scope`, engin vernduð, `.git/config` og
  hooks óbreytt;
- committar á `co/<task>` án hooks;
- keyrir prófin og skráir raunverulega niðurstöðu (rautt verður FAIL, sem fer sem endurgjöf til
  planner).

**„Virkar“-skilyrðið** er **lespróf**, fyrsta Claude-kallið í prófi 1:
- Kanaríska með slembitóka er skrifuð **utan** klónsins (`%TEMP%\co-free-<tími>\outside\co-free-canary.txt`).
  Worker er beðinn um að lesa hana með Read-verkfærinu.
- Úrskurðirnir eru:

  | Úrskurður | Skilyrði | Afleiðing |
  |---|---|---|
  | **LEAK** | Tókinn sést í úttaki | Keyrslan stöðvast; ekkert verk hafið |
  | **VERIFIED** | Í `permission_denials` er Read/Glob/Grep-höfnun á kanaríslóðina | Sannað í keyrsluskrá |
  | **UNVERIFIED** | Hvorugt | Merkt óstaðfest; próf 1 heldur áfram eins og PM leyfði |
- Svar workers er skráð orðrétt í `report.md`.

**Óstaðfest (heiðarlega):**
- Að 2.1.289 samþykki fánasamsetninguna í raunkeyrslu. Ég prófaði `--version` með bull-fána, og hann
  var líka samþykktur, svo `--version` sannar ekki fánana. Það staðfesti aðeins að `--settings`-skráin
  sé lesin. Ef samsetningin bregst, stöðvast keyrslan á lesprófinu (`PROBE_FAILED`), áður en nokkurt verk
  hefst.
- JSON-sniðið á `permission_denials` í raunkeyrslu. Fake-prófin nota skjalfest SDK-snið (`tool_name`,
  `tool_input`); ef það er annað verður úrskurðurinn UNVERIFIED, ekki falskt VERIFIED.
- Leshömlur Codex utan klónsins. `read-only` þýðir engin skrif, ekki lesbann.
- **Eftirstandandi áhætta:** prófin keyra kóða sem worker skrifaði, með notandaréttindum Ása. Á undan
  koma umfangsathugun, einnota klón og umhverfi án lykla. Sér Windows-notandi eða sandbox væri sterkara;
  það er sér ákvörðun (SECURITY_MODEL §4b2).

## 3) Viðbót 3: innskráning og kvóti
- **Áður en nokkurt módelkall er gert:**
  - `claude --version` og `codex --version` eru skráð.
  - `claude auth status --json`: ekki innskráð → `CLAUDE_NOT_LOGGED_IN`; API/Console-aðgangur →
    `CLAUDE_API_KEY_AUTH`; óþekkt snið → `CLAUDE_AUTH_UNKNOWN`. Í síðasta tilfellinu skoðar Ási úttakið
    og keyrir aftur með `--accept-claude-auth`.
  - `codex login status` (einangruð `CODEX_HOME`): verður að nefna ChatGPT; API-lykill →
    `CODEX_API_KEY_AUTH`; annað → `CODEX_NOT_LOGGED_IN`.
- **Kvóta er ekki hægt að lesa án kalls** (engin slík skipun í help). Því eru fyrstu köll hvors
  veitanda höfð ódýr og áhrifalaus:
  - Claude: lesprófið.
  - Codex: fyrsta planið, sem breytir engu.
  - Kvóta- eða innskráningarvilla þar stöðvar keyrsluna **strax**, áður en nokkurt verk hefst, með
    skilaboðunum „Kvóti áskriftar er búinn … Keyrslan stöðvuð strax“.
  - Klárist kvóti síðar í lúppunni, verður hún BLOCKED með `QUOTA_EXHAUSTED` og sömu skilaboðum.
    Engin endurtekning.
- Texti CLI fyrir kvóta og innskráningu er **óstaðfestur**, því engin raunkeyrsla var leyfð. Óþekktur
  texti fellur samt lokað, með almennum kóða.

## 4) Skref fyrir Ása (próf 1). Ekkert af þessu hefur verið gert.
1. **Claude:** `claude auth status`. Á að sýna áskrift (claude.ai). Ef ekki: `claude auth login --claudeai`.
2. **Codex** (einangrað, ekki `~/.codex`), í PowerShell:
   ```
   $env:CODEX_HOME = "D:\Verkefni\clubOrchestra-lab\runs\tools\codex-home"
   D:\Verkefni\clubOrchestra-lab\runs\tools\codex\node_modules\.bin\codex.cmd login
   ```
   Veldu ChatGPT í vafranum, **ekki** `--with-api-key`.
3. **Ræsa:** `node harness/run-local-free.js --start`. Þetta er eina skipunin sem gerir módelkall.
   - Notaðu `--claude <slóð>` ef claude.exe finnst ekki sjálfkrafa. Skriftan velur hæstu útgáfuna undir
     `%APPDATA%\Claude\claude-code`.
4. **Úttak:** `%TEMP%\co-free-<tími>\report.md` og `run-log.json`. Ég bý til evidence úr þeim.

**Röð keyrslunnar:**
1. útgáfur;
2. innskráningar;
3. skyndimynd af vinnumöppu Ása;
4. klón (`git clone --no-hardlinks`, remote fjarlægt);
5. `npm ci --ignore-scripts --offline`. Ég prófaði það staðbundið í klóni: virkar, `openai` úr
   skyndiminni;
6. grunn-CI (verður að vera grænt);
7. **lespróf** (Claude-kall 1);
8. Codex planar → Claude breytir → runner athugar umfang, committar og prófar → CI → Codex rýnir →
   lokaplan → **COMPLETE**;
9. lokaathuganir.

**Áætluð notkun:** Claude 2 köll (lespróf + verk), mest 3. Codex 3 köll, mest 4 á lykil.

**„Virkar“ ef öll atriði halda** (þau eru reiknuð sjálfkrafa í `report.md`):

| Lykill | Skilyrði |
|---|---|
| `baseline_ci_green` | Grunn-CI grænt |
| `read_outside_denied` | VERIFIED, eða UNVERIFIED (merkt) |
| `plan_schema_valid_and_auto` | Codex-plan stenst skema og er AUTO |
| `worker_json_parsed` | Claude-JSON þáttast |
| `commit_on_task_branch` | Commit á `co/CO-FREE-001` |
| `task_output_correct` | `work/CO-FREE-001.md` = „hello from clubOrchestra“ |
| `ci_green` | CI grænt |
| `review_accept_and_complete` | Codex ACCEPT og COMPLETE |
| `no_protected_path` | Engin vernduð slóð snert |
| `ledger_zero_usd` | Ledger 0 USD |
| `owner_workdir_unchanged` | Vinnumappa Ása óbreytt |
| `no_key_in_child_env` | Enginn lykill í umhverfi barnaferla |

Inngrip Ása á meðan keyrslu stendur á að vera 0.

## 5) Viðbót 2: plan fyrir próf 2 (EKKI framkvæmt, ekki í kóða)
**Verk (CO-FREE-002):** lítil raunveruleg JS-eining í `work/`. Tillaga: `work/slugify.js` með
`slugify(text)`:
- lágstafir;
- íslenskir stafir umritaðir: þ→th, æ→ae, ð→d, ö→o, á→a o.s.frv.;
- bil og tákn → `-`;
- engin tvöföld `-` og engin `-` í endum;
- tómur strengur → `''`.

Prófin `work/slugify.test.js` (node:test) eru **skrifuð fyrirfram af mér og læst**:
- þau eru í `allowed_scope` sem lesanleg, en runner hafnar breytingu á þeim (`SCOPE_VIOLATION`);
- CI fyrir verkið verður `node --test work/`.

**Af hverju þetta kallar fram leiðréttingu:**
- Prófin ná yfir jaðartilvik sem fyrsta tilraun missir oft af: `ð`, `þ`, samsett bil og tákn í endum.
- Rautt próf verður FAIL hjá runner, og ástæðan fer til Codex sem endurgjöf. Codex endurplanar og
  Claude lagar: „Claude lagar eftir CI“.
- Codex getur líka hafnað (REJECT) við rýni, t.d. ef README-lína vantar (`acceptance_criteria`).
- **Ef fyrsta tilraun stenst allt** telst það heiðarleg niðurstaða, ekki falsað. Þá er „hafnað a.m.k.
  einu sinni“ ekki uppfyllt og ég legg til harðara verk. Ég bý **ekki** til tilbúna villu.

**Mælingar (sömu og í prófi 1, auk):**
- fjöldi tilrauna worker og REJECT/FAIL-lota;
- köll á hvorn veitanda;
- veggtími;
- **tími Ása á verkinu:** tími frá ræsingu til loka þar sem keyrslan beið eftir Ása. Mælt sem fjöldi
  OWNER-stöðvana (markmið 0) auk veggtíma ef stöðvað. Eina handtak Ása er `--start`.

**Breytingar sem þarf (sér samþykki):**
- verk 2 í `TASKS` með læstum prófaskrám;
- CI-skipun á verk;
- `max_calls_per_task`: worker 3.

## 6) Próf (16 ný; 171/171)
`test/p3-free-local.test.js`, með fölsuðum CLI (`test/fixtures/fake-cli/`). Þau hafna óhertri
worker-skipun og hætta með kóða 9 ef lykill berst þeim:
- **live runner:**
  - aðeins staðbundinn;
  - scratch utan klóns;
  - leyfislisti umhverfis (prófið setur `OPENAI_API_KEY` o.fl. og sannar að þau berist ekki);
  - staðgenglar og `-o`;
  - tímamörk, úttaksþak og óþekkt skipun.
- **Guard og config:**
  - lifandi runner aðeins fyrir áskriftarmódel;
  - replay-hamur hafnar honum;
  - greidd verð, þak > 0, `Bash(…)`, `Read(//…)`, `Read(~/…)`, `Edit(./../…)` og `Write(./**)` er öllu
    hafnað.
- **Hert worker-skipun:** kvóta- og innskráningarkóðar.
- **Keyrsluskriftan frá enda til enda:**
  - happy path: öll 12 atriðin `true`, lespróf VERIFIED, vinnumappa óbreytt, 0 USD, klón án remote;
  - LEAK stöðvar áður en planner er kallaður;
  - UNVERIFIED heldur áfram;
  - 4 innskráningartilvik stöðva án módelkalls;
  - kvóti hjá Claude (við lespróf) og hjá Codex (fyrsta plan);
  - skrif utan umfangs → CI aldrei keyrt;
  - engin breyting;
  - rautt grunn-CI;
  - án `--start` gerist ekkert.
- **Uppfærð öryggispróf:**
  - offline-prófið athugar `live.js` sérstaklega (innflutningur, `process.env` aðeins tvö sjálfgefin
    gildi, `shell: false`) og að enginn annar `src`-hluti noti hana;
  - harness-prófið leyfir `live.js` aðeins í `run-local-free.js`.

## Staðfesting
- `npm test` → **171/171** (16 nýir).
- Engin innskráning, ekkert módelkall, `claude`/`codex` aðeins með `--help`/`--version`.
- Ekkert á `co/`, ekkert í `main`, orchestrator ekki snertur.

## Push
- `feat/co-p3-free-002`.
