# club PROJECT DOCUMENTATION STANDARD
Status: REFERENCE
Updated: 2026-10-05
Owner: Product Owner
Source: ChatGPT (umsjón club-skjölunar)
Canonical source: YES fyrir skjölunarreglur

_Vistað orðrétt eins og það barst frá PM/PO 2026-10-05. Breytist aðeins að ákvörðun Product Owner._

```text
=== club PROJECT DOCUMENTATION STANDARD ===
Use for clubOrchestra and future club-* projects unless an approved exception exists.
Do not invent historical standards. Items not previously defined are labelled NEW STANDARD.

1. REQUIRED CORE DOCUMENTS (docs/)
1) docs/clubX_verkefna_og_vinnuplan.md — primary human-readable project plan and
   long-form source of truth: purpose, scope, goals, current status, architecture
   overview, phases/work packages, NOW/NEXT/LATER, blockers, acceptance status,
   roadmap, important decisions, change history. Do NOT create competing master plans.
2) docs/PROJECT_STATUS.json — machine-readable current-state source of truth:
   release/runtime state, main/deployed distinction, capability state, blockers, gates,
   current work package, next steps, automation/admin status. Rules: verified state only;
   no fabricated live status; historical and current separate; planned != implemented;
   merged != deployed; deployed != verified live; verified live != accepted.
3) docs/PM_HANDOFF.md — concise operational derivative: current runtime truth, current
   main, deployed version, active blockers, NOW/NEXT/LATER, PO decisions required,
   release/security gates. NOT a second plan. Short.
4) docs/DOCUMENTATION_INVENTORY.md — canonical docs, internal engineering docs,
   customer-facing docs, legal/authorization docs, reports, branding requirements,
   document status, source-of-truth relationships.
RECOMMENDED WHEN RELEVANT:
5) docs/PRESENTATION_HANDOFF.md — only with PowerPoint/PDF/training/demo; must
   distinguish LIVE / VERIFIED LIVE / READY_NOT_DEPLOYED / PLANNED / FUTURE.
6) docs/CLAUDECODE_NEXT_EXECUTION.md — one exact next implementation package only;
   not a backlog or second plan.
7) docs/COMMERCIAL_READINESS.md — only if customer-facing/beta/commercial.

2. NAMES THAT SHOULD NOT BE REQUIRED
clubX_samantekt_verkefnis_vX.X / clubX_verkefna_og_vinnuplan_vX.X /
clubX_virknilysing_verkefnis_vX.X are NOT mandatory separate files.
Replacement: verkefna_og_vinnuplan.md (canonical) + PROJECT_STATUS.json + PM_HANDOFF.md.
Separate "samantekt" only with a clear audience. Separate "virknilýsing" only if a formal
functional spec is required, and it must not duplicate the master plan.
NEW STANDARD: one canonical plan over three overlapping versioned files.

3. VERSIONING (NEW STANDARD)
No version in filenames (git holds history). Version lives in header/change history: vMAJOR.MINOR.
MINOR: meaningful doc change, new work package, new feature/status section, changed
architecture detail, new accepted requirement, changed roadmap/status, release-state update.
MAJOR: project model materially changes, new architecture generation, significant scope
change, substantial restructure, new lifecycle/product generation.
No bump for typo/formatting/whitespace/link fixes. Document version != app/runtime version.

4. FORMAT AND LOCATION
Canonical engineering docs: Markdown docs/*.md; structured status docs/PROJECT_STATUS.json.
DOCX only for formal/customer/legal needs, under docs/authorization/, docs/customer/,
docs/legal/. PDF = output format, not source. Google Docs not canonical unless PO
chooses; if one exists, git docs must state which copy is authoritative.

5. MAIN PLAN STRUCTURE — docs/clubX_verkefna_og_vinnuplan.md
# clubX — Verkefna- og vinnuplan
1 Kjarni/Tilgangur · 2 Markmið · 3 Scope (included/excluded) · 4 Ófrávíkjanlegar reglur ·
5 Núverandi arkitektúr (current only) · 6 Núverandi staða (verified) ·
7 Capability/feature status (LIVE / VERIFIED / READY_NOT_DEPLOYED / PLANNED / FUTURE) ·
8 NOW · 9 NEXT · 10 LATER/BACKLOG · 11 Blockers (actual only) · 12 Acceptance/verification ·
13 Product Owner decisions required (real gates only) · 14 Roadmap/work packages ·
15 Architecture/technical decisions · 16 Security/privacy/operational constraints ·
17 Documentation and handoff rules · 18 Breytingaskrá.
Do not force empty sections.

6. PROJECT_STATUS.json STRUCTURE
{ "status_schema_version": 1, "updated_at": "...", "project": "...", "production": {},
  "current_work_package": "...", "capability_matrix": {}, "priorities": [],
  "next_steps": [], "blockers": [], "roadmap": {}, "operating_model": {},
  "external_beta": "...", "presentation_update_required": "..." }
Only relevant sections. Machine-readable, no prose dump, no secrets/credentials,
no invented status, current truth only.

7. PM_HANDOFF.md STRUCTURE
# clubX — PM handoff
CURRENT STATE · CURRENT PRODUCTION (if applicable) · ACCEPTANCE · OPEN WORK · NOW · NEXT ·
LATER · BLOCKERS · PRODUCT OWNER DECISIONS REQUIRED · IMPORTANT BOUNDARIES. Concise.

8. HEADERS (NEW STANDARD)
# <title>
Status: <status>
Updated: YYYY-MM-DD
Owner: <role/person>
Canonical source: <yes/no or parent source>
Optional: Version: vX.X
Derivatives name their canonical source, e.g.
docs/clubOrchestra_verkefna_og_vinnuplan.md + docs/PROJECT_STATUS.json.
No secrets or credentials in headers.

9. CHANGE HISTORY
Main plan has "## Breytingaskrá" with version, date, short description per entry.
Git is the authoritative technical history; record only meaningful document changes.

10. LANGUAGE (NEW SHARED STANDARD)
Project/PM/product docs: Icelandic by default; English technical terms allowed where
clearer (API, Worker, runtime, deploy, rollback, fail-closed, runner, pipeline, workflow,
evidence, scope, acceptance, audit, registry …). Code: English for identifiers, schemas,
API fields, technical filenames, comments. Customer material: per audience; if bilingual,
keep meaning parity.

11. BRANDING
Internal docs: no letterhead. Customer/formal docs: project's canonical branding.
Do not invent logos/colours/identity. Brand assets → docs/brand/ + inventory.

12. SOURCE-OF-TRUTH PRECEDENCE
1 fresh repository/runtime/release evidence · 2 PROJECT_STATUS.json ·
3 verkefna_og_vinnuplan.md · 4 PM_HANDOFF.md · 5 presentation/customer derivatives.
On conflict: don't guess, prefer newer verified evidence, record the inconsistency,
fix the derivative.

13. ANTI-DUPLICATION
Do NOT keep multiple docs all claiming to be summary/plan/functional description/
status/roadmap unless each has a clearly different audience. Default: ONE canonical
plan + ONE structured status file + small specialized derivatives.

14. NOT YET DEFINED CROSS-PROJECT (adopted as new defaults unless PO says otherwise)
Exact version-increment rules · mandatory Google Docs · mandatory separate samantekt ·
mandatory separate virknilýsing · identical section numbering across projects ·
universal bilingual requirement · universal branding folder structure.

15. clubOrchestra INITIAL SETUP
docs/: clubOrchestra_verkefna_og_vinnuplan.md, PROJECT_STATUS.json, PM_HANDOFF.md,
DOCUMENTATION_INVENTORY.md. Add only if needed: PRESENTATION_HANDOFF.md,
CLAUDECODE_NEXT_EXECUTION.md, COMMERCIAL_READINESS.md. Subfolders as needed:
docs/architecture/, docs/authorization/, docs/customer/, docs/brand/, docs/runbooks/.
No empty bureaucracy.
=== END STANDARD ===
```
