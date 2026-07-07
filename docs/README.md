# pi-nullsink docs

Design and planning references for the extension. User-facing documentation lives in the
[top-level README](../README.md); this folder is for contributors and maintainers.

| Doc | What it is |
| --- | --- |
| [`design.md`](design.md) | The normative design & architecture reference — token format, the nullsink API contract, config schema v2, the hub, order lifecycle, and incognito. Cited by `src/token.ts` and `src/wallet.ts`. |
| [`upstream-asks.md`](upstream-asks.md) | Open requests to the nullsink operator (a `.onion` endpoint; a client link) that would strengthen the Tor story. Neither blocks a release. |

Earlier working documents — the v0.1 config/UI design, the v0.2 implementation plan, and the
v0.3 scoping proposal — were retired once shipped. They remain in the git history if you need
the provenance.
