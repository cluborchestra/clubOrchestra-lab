# Evidence — CO-P3-FREE-001 (frí prófunarleið: könnun)
Status: STOPPED: bíður ákvörðunar PO (sjá „Til að losa stoppið“)
Updated: 2026-10-06
Owner: Claude Code (könnun) · rýni: PM
Canonical source: NO. Evidence

**Grein:** `feat/co-p3-free-001`, ofan á `feat/co-p3-pre3-001` (`09ee10c`). **Engin kóðabreyting.**
Engin innskráning, ekkert módelkall og enginn kostnaður. Aðeins `--version` og `--help` voru keyrð.
Ekkert á `co/` eða í `main`.

## Niðurstaða: HART STOPP fyrir lið 2 (Codex-adapter)
**Codex CLI er ekki uppsett** á þessari vél. Ég leitaði á:
- PATH;
- npm global;
- `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs` og `~/.codex`;
- Windows-pakkasafninu og `Program Files`.

ChatGPT- eða Codex-forrit fannst heldur ekki. Því er **ekkert** við `codex exec` hægt að staðfesta
(fána, JSON-form eða innskráningarleið). Að skrifa adapter gegn óstaðfestu viðmóti brýtur reglu
verkefnisins: fánar eru staðfestir gegn `--help` fyrir notkun. Liðir 2 og 3 voru því **ekki
hafnir**.

## 1a) Claude Code: áskriftarinnskráning með `claude -p`
| Atriði | Niðurstaða | Heimild |
|---|---|---|
| Útgáfa á vélinni | **2.1.289**. Skrifborðsforritið **uppfærði sig sjálft**: 2.1.286 er horfið, 2.1.288 og 2.1.289 eru komin. Flaggasettið er eins og í 2.1.286 nema `--client-data-url` hvarf (skiptir okkur ekki). | `claude --version`; samanburður á `--help` |
| Innskráning með áskrift | **STAÐFEST í help:** `claude auth login --claudeai` = „Use Claude subscription (default)“. `--console` = API-reikningur. | `claude auth login --help` |
| `-p` + `--output-format json` | Til. Ekkert í help bindur `-p` við API-lykil. **Óstaðfest** að það keyri með áskrift fyrr en eitt raunkall er gert (bannað hér). | `claude --help` |
| **`--bare` gengur EKKI** á fríu leiðinni | „Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper … (OAuth and keychain are never read)“. Worker-kallið okkar notar `--bare` í dag, svo það þarf að fjarlægja það á fríu leiðinni. | `claude --help` (`--bare`) |
| Í stað `--bare` | `--safe-mode`: slekkur á CLAUDE.md, skills, plugins, hooks, MCP og fleiru, en „**Auth** … and permissions work normally“. Það heldur prompt-injection-vörninni án API-lykils. | `claude --help` (`--safe-mode`) |
| `--max-budget-usd` með áskrift | „Maximum dollar amount to spend on **API calls**“. **Óstaðfest** hvort það takmarki nokkuð undir áskrift. Á fríu leiðinni eru `max_calls_per_task`, loop-detector og tímamörk raunverulega vörnin. | `claude --help` |

**1a: GO staðbundið, með fyrirvara.** Help styður áskrift sem sjálfgefna innskráningu. Eitt
raunverulegt `claude -p` á vél Ása staðfestir það, og það er liður 3.

## 1b) Codex CLI
| Atriði | Niðurstaða |
|---|---|
| Uppsett? | **NEI** |
| `codex --version`, `codex exec --help` | **Ekki hægt.** Forritið er ekki til staðar |
| `exec` (óvirk keyrsla), JSON/skipulagt úttak, innskráning með ChatGPT | **ÓSTAÐFEST.** Samkvæmt minni þekkingu á skjölun styður Codex CLI: <br>• `codex exec`; <br>• JSON-úttak (`--json`); <br>• JSON Schema fyrir lokasvar; <br>• „Sign in with ChatGPT“ fyrir Plus/Pro/Team. <br>Ekkert af því er staðfest hér, og fánaheiti geta hafa breyst. |

**1b: NO-GO** þar til Codex CLI er uppsett og `--version`/`--help` lesin.

## 1c) Áskriftarauðkenning í CI / headless
| | Staðbundið | CI (GitHub Actions) |
|---|---|---|
| Claude | Já: `auth login --claudeai` er sjálfgefið (help) | **Líklega:** `claude setup-token`, „Set up a long-lived authentication token (**requires Claude subscription**)“, er staðfest í help. *Hvernig* lykillinn er notaður í CI kemur ekki fram í help, svo það er **óstaðfest**. |
| Codex | Óstaðfest (ekki uppsett) | **Óstaðfest.** Samkvæmt minni þekkingu mælir OpenAI með API-lykli fyrir CI og ChatGPT-innskráningu fyrir staðbundna notkun |

**Öryggisathugasemd (OWNER/security) fyrir CI-leiðina:**
- **Áskriftarlykill nær yfir allan aðganginn.** Áskriftar- eða setup-token-lykill er ekki
  takmarkaður við eitt verkefni eins og API-lykill. Ef hann lekur fæst aðgangur að Claude- eða
  ChatGPT-aðgangi Ása.
- **Repo-ið er opið.** Í CI væri slíkur lykill GitHub-secret.
- **Kvóti:** áskriftin er einnig notuð af Ása sjálfum, svo kvótinn er sameiginlegur.
- **Skilmálar:** það er óstaðfest hvort skilmálar áskrifta leyfi sjálfvirka CI-notkun. Það er Ása
  að athuga.

**Tillaga:** frí leið = **aðeins staðbundið á vél Ása** fyrst. CI með áskriftarlyklum er sér
ákvörðun Ása.

## 4) GO / NO-GO
| Liður | Úrskurður |
|---|---|
| 1a Claude Code + áskrift | **GO (staðbundið)**, með fyrirvara um eitt raunkall. Fjarlægja þarf `--bare` og nota `--safe-mode`. |
| 1b Codex CLI + ChatGPT | **NO-GO / HART STOPP:** ekki uppsett, ekkert staðfest |
| 1c CI með áskrift | **Óstaðfest + öryggisákvörðun Ása.** Mælt er með staðbundinni prófun fyrst. |

## Til að losa stoppið (ákvörðun Ása; enginn kostnaður)
1. **Leyfa uppsetningu Codex CLI.** Það er frítt niðurhal en samt niðurhal, og krefst því
   samþykkis.
   - Samkvæmt minni þekkingu er það `npm install -g @openai/codex` (pakkaheiti óstaðfest).
   - Ási getur sett það upp sjálfur, eða leyft mér það.
   - Uppsetning kallar ekki á módel. Síðan keyri ég aðeins `codex --version`, `codex --help`,
     `codex exec --help` og `codex login --help`.
2. **Útgáfufesting Claude:** skrifborðsforritið uppfærir sig sjálft (2.1.286 → 2.1.289 á einum
   degi). Fyrir staðbundna prófun þarf annaðhvort:
   - **(a)** að festa á útgáfuna sem er uppsett þann dag (`check-claude-version` les
     `config/agent-limits.json`), eða
   - **(b)** sérstaka fasta uppsetningu (niðurhal).

   Það er ákvörðun Ása.
3. **Eftir það:** liður 2 (Codex-adapter gegn staðfestu `--help`, replay-fixtures og próf) og liður
   3 (staðbundið prófunarplan).

## Það sem var keyrt (allt les-eingöngu)
- `claude --version` og `claude --help` (2.1.289, sha256 `a58ca2282c013122…`);
- `claude setup-token --help`, `claude auth --help`, `claude auth login --help` og
  `claude auth status --help`;
- leit að `codex`: ekkert fannst.

**Ekki keyrt:**
- `claude auth status`: það les innskráningarstöðu, sem liggur utan „aðeins --help“;
- `claude -p` og `setup-token` sjálft;
- hvaðeina sem kallar á módel eða skráir inn.
