# SHA map — author/committer rewrite (2026-10-04)

Before the first push to https://github.com/cluborchestra/clubOrchestra-lab, the author and
committer of every commit were rewritten to
`clubOrchestra <337842026+cluborchestra@users.noreply.github.com>`. GitHub's email-privacy
protection (GH007) refused the original addresses. Nothing had been pushed before the rewrite.

Only identity metadata changed. Dates, messages, file contents and order are unchanged: each pair
below has an identical tree hash (checked with `git rev-parse <sha>^{tree}`).

| Task | Commit | Old SHA | New SHA |
|---|---|---|---|
| CO-P1-001 | control plane with simulated planner + worker | `3adae23` | `8ab84f3635c482d7ef0b0d1bd0f0530f1de52e7f` |
| CO-P1-001 | mark P1 IMPLEMENTED + TESTED (local) | `7799664` | `4b935cca3410e3f3cb9ce490587198b64f1e41f3` |
| CO-P2a-001 | GitHub loop mechanism, proven locally | `eea7f34` | `5ae4cd933b904cf7db5c86bc3e13b07953b429a8` |
| CO-P2b-001 | GitHub wiring with state branch; orchestrator disabled | `0ac21e5` | `68ecf84a7e5a4c3e9c83e365c3dc8ce12d281b8b` |
| — | orchestra-state initial scaffold | `bd31372` | `bd31372` (already noreply; unchanged) |

Older evidence and handoffs that cite an old SHA (for example "P1 = 7799664",
"P2a = eea7f34") refer to the same content as the new SHA in the same row.
