# Evidence — CO-P3-FREE-001 (frí prófunarleið á núverandi áskriftum)
Status: FOR QA
Updated: 2026-10-07
Owner: Claude Code (framkvæmd) · rýni: PM
Canonical source: NO. Evidence; staðan er í docs/PROJECT_STATUS.json og docs/clubOrchestra_verkefna_og_vinnuplan.md (v1.4)

**Grein:** `feat/co-p3-free-001` (ofan á `feat/co-p3-pre3-001`). **Kóði og skjöl:** commit
`d6b65140cd96567adf782e605fdd56e20945919f`.

**Niðurstaða:** stoppið er losað.
- Codex CLI er uppsett, og exec-hamur, skipulagt úttak og read-only eru staðfest í `--help`.
- Planner-adapter fyrir `codex exec` og áskriftarhamur fyrir Claude-worker eru útfærðir og prófaðir í
  replay.
- Prófasvítan er **155/155 græn**, þar af 9 ný.
- **Enginn nýr kostnaður:** engin innskráning, ekkert módelkall, engin API-inneign. Ekkert á `co/` eða
  í `main`.
- Staðbundin raunprófun er **aðeins plan** (liður 3, hér að neðan).

*Saga:* fyrri útgáfa þessarar skrár (2026-10-06) var HART STOPP, því Codex CLI var ekki uppsett. PM
opnaði hliðið 2026-10-07.

## 1) Codex CLI: uppsetning og könnun
**Uppsetning:** opinbera npm-leiðin, pakkinn `@openai/codex`.
- **Repo:** github.com/openai/codex; útgefandi OpenAI; Apache-2.0.
- **Útgáfa:** nákvæmlega **0.160.1** (nýjasta stöðuga).
- **Aðferð:** `npm install --save-exact --ignore-scripts @openai/codex@0.160.1` í
  **`runs/tools/codex/`**. Sú mappa er inni í repo-inu og gitignored. Ekkert er sett upp globalt og
  ekkert utan verkefnisins er snert.
- **Pakkar:** 2.
  - `@openai/codex@0.160.1`: `sha512-f1yrJhwgimKQI1kYQlxdPJcFwkNZxZrbz7Hf89EAcnLqkQ7TiESzr2FgSZn13Ga5RuHjlVUfurzwq10wk9zw2g==`
  - `@openai/codex-win32-x64@0.160.1-win32-x64`: `sha512-yyqykHtHNhm0ZViofGozz9a4ffUyXDsiyRu9Q2hPNg/cu4uzSsovNr5kDmzBXPFWAilmlZuNkwpw1W7uae2nlg==`
- **Einangrun:** `CODEX_HOME` = `runs/tools/codex-home` (gitignored), svo ekkert var lesið úr eða
  skrifað í `~/.codex` Ása. Sú mappa er enn ekki til.

**Keyrt (aðeins):** `codex --version` (`codex-cli 0.160.1`), `codex --help`, `codex exec --help`,
`codex login --help`, `codex logout --help` og `codex features --help`.

| Spurning | Svar | Heimild |
|---|---|---|
| Óvirk keyrsla | **JÁ:** `codex exec` = „Run Codex non-interactively“; fyrirmæli úr stdin með `-` | `codex exec --help` |
| Skipulagt / JSON-úttak | **JÁ:** `--output-schema <FILE>` („JSON Schema file describing the model's final response shape“), `-o/--output-last-message <FILE>` og `--json` (JSONL-atburðir) | `codex exec --help` |
| Planner les aðeins | **JÁ:** `-s/--sandbox read-only` (val: read-only, workspace-write, danger-full-access). `--search` (vefleit) er sjálfgefið af, og við sendum það ekki. | `codex exec --help`, `codex --help` |
| Einangrun frá stillingum Ása | **JÁ:** `--ignore-user-config` („auth still uses CODEX_HOME“), `--ignore-rules`, `--ephemeral` og `-C/--cd` | `codex exec --help` |
| Innskráning | `codex login` hefur `--with-api-key`, `--with-access-token`, `--device-auth` og undirskipunina `status`. **Óstaðfest í help:** að `codex login` án fána sé „Sign in with ChatGPT“ (help segir það ekki berum orðum; skjölun segir að svo sé) | `codex login --help` |
| CI með ChatGPT-aðgangi | Tæknilega mögulegt (`--with-access-token`, `CODEX_ACCESS_TOKEN`), en **NEI í bili** að ákvörðun Ása | `codex login --help` |

**Adapterinn notar viljandi ekki:**
- `--json`, því form JSONL-atburðanna er óstaðfest. Lokasvarið er lesið úr `-o`-skránni.
- `--search`, `--add-dir` eða `--approve-for-me`.
- neinn `--dangerously-*` fána.

**1b: GO.**

## 1a + 4) Claude Code á áskrift og `--safe-mode`
Útgáfa á vélinni er **2.1.289**. Skrifborðsforritið uppfærir sig sjálft, og 2.1.286 er horfið.
| Atriði | Niðurstaða | Heimild |
|---|---|---|
| Áskrift sjálfgefin | **STAÐFEST:** `claude auth login --claudeai` = „Use Claude subscription (default)“ | `claude auth login --help` |
| `--bare` | **Bannar áskrift:** „auth is strictly ANTHROPIC_API_KEY or apiKeyHelper … (OAuth and keychain are never read)“. Ekki notað á fríu leiðinni. | `claude --help` |
| `--safe-mode` hleður EKKI | **STAÐFEST:** CLAUDE.md, skills, uppsett plugins, hooks, MCP-þjónar, sérsniðnar skipanir og agentar, output styles, workflows o.fl. („all customizations … disabled“). „Auth … and permissions work normally“, þ.e. áskriftin virkar. | `claude --help` (`--safe-mode`) |
| Notandastillingar (`settings.json`) | **ÓSTAÐFEST:** help segir ekki berum orðum að þær séu ekki lesnar, og „permissions work normally“ bendir til að reglur þaðan gildi. **Trygging:** `--setting-sources project`, sem hleður aðeins stillingar einnota klónsins (enga `user`/`local`), og `--strict-mcp-config` (engir MCP-þjónar). Báðir fánar eru staðfestir í help. | `claude --help` |
| Áhrif í raunkeyrslu | Óstaðfest þar til fyrsta staðbundna keyrslan sýnir það (liður 3, skref 6) | — |

**Worker-kall á fríu leiðinni**, prófað:
```
claude -p --safe-mode --setting-sources project --strict-mcp-config --output-format json \
  --permission-prompts none --allowedTools "Read,Edit,Write,Bash(npm test),Bash(git status),Bash(git diff *),Bash(git add *),Bash(git commit *)" \
  --append-system-prompt "<WORKER_SYSTEM>"     (handoff á stdin)
```
`--max-budget-usd` er sleppt á áskrift. Áhrif þess eru óstaðfest, og 0-þak gæti stöðvað keyrsluna.
Guard telur samt hvert kall.

**1a: GO staðbundið.**

## 1c, 2, 3 (ákvarðanir PO)
- **Áskriftarlyklar í CI: NEI í bili.** Skráð í PROJECT_STATUS sem ákvörðun Ása eftir staðbundna
  prófun.
- **Útgáfur staðbundið:** engin festing. `claude --version` og `codex --version` eru skráðar í upphafi
  hverrar staðbundinnar keyrslu (liður 3, skref 4). Festingin gildir aðeins í CI.

## 2) Adapter + replay (útfært)
**`src/agents/codexExec.js` (`CodexExecClient`):** sama mynstur og `claudeCode.js`, með innspýttum
runner, án ferla, `process.env` eða lykla. Kallið:
```
codex exec --sandbox read-only --cd {WORKDIR} --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules \
  --output-schema {SCHEMA_FILE} --output-last-message {OUTPUT_FILE} --color never -    (fyrirmæli á stdin)
```
- **Skema og verð:**
  - sama strict plan- og review-skema og Responses-adapterinn (`src/agents/schemas.js`);
  - verðtegundin `subscription`: 0 USD á kall, en kallið er talið.
- **Claude:** `ClaudeCodeHeadlessClient({ auth: 'subscription' })`.
- **Valkostir sem haldast:** Responses-API-adapterinn og API-lykla-hamur Claude (`--bare`).
- **Fixtures:** 9 í `test/fixtures/lot2/codex/`. Haus á hverri: dagsetning, `codex-cli 0.160.1`,
  „hand-authored, NOT captured from a live codex run“.

**Próf (`test/p3-free-path.test.js`, 9):**
| Próf | Niðurstaða |
|---|---|
| Codex-kall: nákvæmir fánar; ekkert `--json`/`--search`/`--add-dir`/`--dangerously-*`/skrifhamur; skemu = PLAN/REVIEW | ✔ |
| Claude á áskrift: ekkert `--bare`/`--max-budget-usd`; `--safe-mode --setting-sources project --strict-mcp-config`; API-lykla-hamur óbreyttur | ✔ |
| Full lúppa: Codex planar og rýnir, Claude vinnur, CI hliðar → COMPLETE, **0 USD**, öll köll talin | ✔ |
| REJECT frá Codex → endurgjöf → ný tilraun | ✔ |
| Escalation-reglan gildir (Codex: OWNER/scope → bið, enginn worker) | ✔ |
| Texti í stað JSON, exit ≠ 0, engin `-o`-skrá, timeout → BLOCKED | ✔ |
| 0 USD ≠ ótakmarkað: `max_calls_per_task` stöðvar **fyrir** kall | ✔ |
| Live-runner (ekki replay) hafnað áður en ferli fer af stað | ✔ |
| Áskriftarfærsla er ekki verð; sjálfgefin config er áfram lokuð (mock, 0 USD) | ✔ |

## 5) Einnota mappa og worker-mörk (hönnun; framkvæmt í lið 3)
- **Sérklón:** keyrslan fer fram í **sérklóni í tímabundinni möppu**,
  `%TEMP%\co-free-<tími>\repo`, búnu til með `git clone --no-hardlinks <þetta repo>`. Klónunin er
  staðbundin, án netumferðar. Control-plane-state fer í `%TEMP%\co-free-<tími>\control`. Ekkert er
  skrifað í vinnumöppu Ása.
- **Worker** (`claude`) keyrir með:
  - cwd = klónið, án `--add-dir`;
  - `--permission-prompts none`, svo allt sem þyrfti leyfi (t.d. skrif utan cwd) er hafnað sjálfkrafa;
  - fastan `--allowedTools`-lista.

  Control plane athugar auk þess **verndaðar slóðir á raunverulegum diff**.
- **Planner** (`codex`) keyrir með `--sandbox read-only --cd <klón>`.
- **Runner** fjarlægir `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` og `CODEX_ACCESS_TOKEN` úr umhverfi
  barnaferla. Ef lykill er til staðar gæti CLI annars notað API-reikning í stað áskriftar, og það
  kostar.
- **Óstaðfest takmörkun:** les-aðgangur Claude utan cwd. Skrif eru takmörkuð af leyfum, en lestur utan
  möppunnar er ekki sannaður lokaður. Sterkari einangrun, t.d. sér Windows-notandi eða sandbox, er
  sér ákvörðun.

## 3) Plan fyrir staðbundna prófun (EKKI framkvæmt)
**Forsenda: samþykki Ása á tveimur atriðum.**
1. Ég byggi staðbundna runnerinn `src/agents/live.js`. Það er eina undanþegna skráin, og hún er þegar
   vernduð. Hún ræsir `codex`/`claude`, skrifar skema- og `-o`-skrár, fjarlægir API-lykla úr
   umhverfi og setur tímamörk.
2. Ég byggi `harness/run-local-free.js`. Hvorugt er gert enn.

**Skref fyrir Ása (einu sinni):**
1. **Claude:** í PowerShell, `claude auth status`. Það á að sýna Claude-áskrift (claude.ai), ekki
   Console/API. Ef ekki: `claude auth login --claudeai`.
2. **Codex** (einangruð innskráning, ekki í `~/.codex`):
   ```
   $env:CODEX_HOME = "D:\Verkefni\clubOrchestra-lab\runs\tools\codex-home"
   D:\Verkefni\clubOrchestra-lab\runs\tools\codex\node_modules\.bin\codex.cmd login
   ```
   Veldu innskráningu með ChatGPT í vafranum. **Ekki** `--with-api-key`. Athugaðu síðan með
   `... codex.cmd login status`. `auth.json` lendir í `runs/tools/codex-home`, sem er gitignored og
   fer aldrei í git.
3. Gakktu úr skugga um að `OPENAI_API_KEY` og `ANTHROPIC_API_KEY` séu **ekki** stillt í skelinni. Runnerinn
   fjarlægir þá líka.

**Keyrslan (ein skipun, eitt verk):** `node harness/run-local-free.js`
4. Skrifar `claude --version` og `codex --version` í keyrsluskrá.
5. Býr til einnota klón + state í `%TEMP%`.
6. **Verk:** „Create `work/CO-FREE-001.md` with the line `hello from clubOrchestra`“ (implement,
   AUTO).
   - Codex planar (read-only) og gefur handoff, sem control plane staðfestir.
   - Claude vinnur í klóninum og committar á `co/CO-FREE-001`.
   - „CI“ = `npm test` í klóninum.
   - Codex rýnir → ACCEPT → næsta plan = ekkert → **COMPLETE**.
7. Skilar evidence-skrá með:
   - útgáfum;
   - audit;
   - ledger (köll, 0 USD);
   - `git status` vinnumöppu Ása (á að vera óbreytt);
   - diff klónsins.

**Áætluð kvótanotkun:**
- **Codex:** 3 köll (plan, rýni, lokaplan), mest 4, hvert með lítið inntak (nokkur þúsund tókar).
- **Claude:** 1 `-p`-lota, mest 2, örfáar umferðir (ein skrá + commit).
- Nákvæm tala er óstaðfest. Claude-JSON skilar `usage`, sem verður skráð. Codex gefur ekki usage í
  `-o`, svo þar telst aðeins fjöldi kalla.

**Hvernig stöðvað er:**
- Ctrl+C hvenær sem er.
- Sjálfvirkt BLOCKED við:
  - hvaða villu sem er;
  - `max_calls_per_task` (planner 4, worker 2);
  - tímamörk (Codex 3 mín. á kall, Claude 10 mín.);
  - loop-detector;
  - snertingu verndaðrar slóðar.
- Engar endurtekningar umfram mörk.
- Að lokum má eyða `%TEMP%\co-free-*`.

**„Virkar“ ef ÖLL atriðin halda:**
- útgáfur skráðar;
- Codex-plan stenst skema og er AUTO;
- Claude-JSON þáttast;
- commit er á `co/CO-FREE-001` í klóninum;
- `npm test` er grænt í klóninum;
- Codex ACCEPT og state = COMPLETE;
- **vinnumappa Ása er óbreytt**;
- engin vernduð slóð snert;
- ledger sýnir 0 USD;
- enginn API-lykill notaður.

**„Virkar ekki“ ef eitthvað af þessu gerist** (stöðvast, evidence skrifað, ekkert reynt aftur
sjálfkrafa):
- auth-villa, eða CLI krefst API-lykils;
- Codex-svar stenst ekki skema;
- `claude -p` hafnar áskrift eða JSON-formið er annað en í fixtures;
- worker reynir að skrifa utan klóns eða í verndaða slóð;
- tímamörk;
- kvóti búinn.

## GO / NO-GO
| Liður | Úrskurður |
|---|---|
| 1a Claude Code á áskrift | **GO (staðbundið).** Áskrift sjálfgefin; `--safe-mode` í stað `--bare`; notandastillingar tryggðar með `--setting-sources project` |
| 1b Codex CLI á ChatGPT | **GO.** Uppsett; exec, `--output-schema` og `read-only` staðfest. ChatGPT-innskráning er verk Ása (skref 2). |
| 1c Áskrift í CI | **NEI í bili** (ákvörðun Ása) |
| 4 `--safe-mode` | CLAUDE.md, hooks, MCP og plugins: **staðfest** óhlaðið. Notandastillingar: **óstaðfest**, tryggt með `--setting-sources project` + `--strict-mcp-config` |
| 5 Einnota mappa | Hannað (klón í `%TEMP%`, cwd-bundinn worker, read-only planner); framkvæmt í lið 3 |

## Staðfesting
- **Ekkert net:** utan npm-niðurhalsins sem PM samþykkti og lestrar á npm-lýsigögnum.
- Hvorki innskráning né módelkall.
- Engir lyklar.
- Prófasvítan, 155/155, keyrir með nettilgildru. `child_process` er enn aðeins í `src/gitDiff.js`.
- Ekkert á `co/` eða í `main`. Push-niðurstaða er neðst.

## Push
_(fyllt út eftir push)_
