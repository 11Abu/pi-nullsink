# Upstream asks — nullsink

Date: 2026-07-03
Audience: the nullsink client (operator of nullsink.is).
Context: v0.3 documents Tor routing via pi's own proxy support (see README → "Routing through
Tor"). Two asks would make that story stronger; neither blocks us today.

## Ask 1 — publish a `.onion` (primary)

Stand up a v3 onion service for `nullsink.is` and publish the address.

- **Why.** Today a Tor user still exits to the clearnet host: an exit node sees the TLS stream, and
  networks that block Tor exits can stall requests. A `.onion` keeps the whole path inside Tor —
  no exit node, no exit-blocking failure mode.
- **Our side is ready.** The extension's Base URL already accepts any origin, so users can point at
  the onion the day it exists — no release required from us.
- **Acceptance.** The onion URL is documented in your README / trust-model as the canonical Tor
  endpoint. We then document the pairing (set Base URL to the `.onion`, keep `httpProxy` on Tor) in
  our README.

## Ask 2 — link pi-nullsink once it's on npm (secondary)

Once pi-nullsink is published, link it from your README / docs as the terminal client.

- **Why.** Distribution beats features — the people who want an account-less, crypto-paid proxy are
  already reading your docs; a one-line pointer reaches them where they are.
- **Acceptance.** A link to the npm package (or this repo) from your README, or a short "clients"
  section.
