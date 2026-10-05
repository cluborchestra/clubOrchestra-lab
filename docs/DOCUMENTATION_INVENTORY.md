# clubOrchestra — skjalayfirlit (DOCUMENTATION_INVENTORY)
Status: ACTIVE
Updated: 2026-10-05
Owner: PM
Canonical source: NO. Yfirlit; staðallinn er docs/CLUB_DOCUMENTATION_STANDARD.md

## Forgangsröð heimilda (staðall §12)
Ef skjölum ber ekki saman gildir:
1. ný staðfest evidence úr repo eða keyrslu;
2. `docs/PROJECT_STATUS.json`;
3. `docs/clubOrchestra_verkefna_og_vinnuplan.md`;
4. `docs/PM_HANDOFF.md`.

## Canonical skjöl
| Skjal | Hlutverk | Staða | Tungumál |
|---|---|---|---|
| [docs/clubOrchestra_verkefna_og_vinnuplan.md](clubOrchestra_verkefna_og_vinnuplan.md) | Aðalskjal: tilgangur, reglur, arkitektúr, staða, NOW/NEXT/LATER, ákvarðanir, breytingaskrá | ACTIVE, v1.0 | íslenska |
| [docs/PROJECT_STATUS.json](PROJECT_STATUS.json) | Vélrænt lesanleg núverandi staða, eingöngu staðfest | ACTIVE | enska (JSON-reitir) |
| [docs/CLUB_DOCUMENTATION_STANDARD.md](CLUB_DOCUMENTATION_STANDARD.md) | Skjölunarstaðall club-verkefna, orðréttur | REFERENCE, canonical fyrir skjölunarreglur | enska (orðréttur) |

## Afleidd skjöl
| Skjal | Unnið úr | Staða |
|---|---|---|
| [docs/PM_HANDOFF.md](PM_HANDOFF.md) | aðalskjal + PROJECT_STATUS.json | ACTIVE, stutt |
| docs/DOCUMENTATION_INVENTORY.md (þetta skjal) | staðall §1, lið 4 | ACTIVE |

## Innri tækniskjöl
| Skjal | Hlutverk | Staða | Tungumál |
|---|---|---|---|
| [README.md](../README.md) | Fyrir forritara: keyrsla, próf, layout, tæknilýsing | ACTIVE | enska (tæknilegt) |
| [SECURITY_MODEL.md](../SECURITY_MODEL.md) | Sérhæft öryggisskjal: lyklar og environments, ledger og concurrency, kill switches, Lot 3 checklist | ACTIVE; heldur sér sem sérhæft skjal | enska |
| config/agent-limits.json | Kostnaðarþök og rate-mörk. Stillingarskrá, ekki skjal; skráð hér af því að Ási setur þar tölur í Lot 3 | ACTIVE | — |

## Skýrslur og evidence
| Staður | Innihald | Staða |
|---|---|---|
| [evidence/](../evidence/) | Evidence fyrir hvert verk frá P3 Lot 2b: `CO-P3-LOT2B-001.md` | ACTIVE; Ási fær hlekk hingað |
| [docs/evidence/](evidence/) | Eldri evidence (P1–P2b): `p2b_live_run.md`, `sha_map.md`, sýnishorn af audit og state, prófaúttak | HISTORICAL; óbreytt |

Tveir evidence-staðir: `docs/evidence/` er frá P1–P2b. `evidence/` er staðurinn sem PM tilgreindi
frá og með Lot 2b. Sameining er ákvörðun Ása/PM; ekkert hefur verið flutt.

## Söguleg skjöl
| Skjal | Staða | Athugasemd |
|---|---|---|
| [clubOrchestra_verkefna_og_vinnuplan_v0.1.md](../clubOrchestra_verkefna_og_vinnuplan_v0.1.md) (rót) | HISTORICAL. Leyst af hólmi af aðalskjalinu v1.0 | Í eigu Ása, óbreytt. Í hausnum segist hún enn vera canonical, sem stangast á við staðal §13. **Ákvörðun Ása:** merkja hana *superseded* eða setja í skjalasafn. |

## Fjarlægt 2026-10-05 (staðall §2 og §13)
| Skjal | Hvert efnið fór |
|---|---|
| `docs/clubOrchestra_samantekt_verkefnis_v1.0.md` | Aðalskjal §1–§3, §6, §15 |
| `docs/clubOrchestra_virknilysing_verkefnis_v1.0.md` | Aðalskjal §4, §5, §16 |
| `docs/clubOrchestra_verkefna_og_vinnuplan_v1.0.md` | Aðalskjal §8–§14 |
| `CURRENT_STATUS.md` | Staða → `PROJECT_STATUS.json` + aðalskjal §6, §7, §12. Opin vinna og hlið → `PM_HANDOFF.md`. Engin tilvísunarskrá skilin eftir (§13). |

## Viðskiptavina-, laga- og leyfisskjöl
Ekki til. Verkefnið er innra og ekki á viðskiptavinastigi.

## Vörumerki
Engin krafa. Innri skjöl eru án bréfsefnis (staðall §11), og `docs/brand/` er ekki til.
