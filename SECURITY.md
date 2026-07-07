# Security Policy

pi-nullsink is a client for an anonymous, crypto-paid proxy: **a nullsink key is bearer money**, and
the extension makes explicit privacy claims. We take reports about either seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's private channel:

> **Security** tab → **Report a vulnerability**

on [11Abu/pi-nullsink](https://github.com/11Abu/pi-nullsink/security). If private reporting is
unavailable to you, contact the maintainers privately rather than filing publicly. We aim to
acknowledge a report within a few days and will coordinate a fix and disclosure with you.

**Never include a real API key** in a report — it is spendable and unrecoverable. A masked prefix
(`0sink_…`) or a freshly-minted throwaway key is enough to reproduce most issues.

## In scope

This repository is the **client extension**. A report is in scope when it concerns how the extension:

- handles or could leak the bearer key (the `0600` file, masking, logs, error output);
- violates **hash discipline** — sending the raw key anywhere but `/balance` and `/v1`;
- weakens the **fail-closed** proxy behavior — a request silently bypassing the configured proxy;
- **overstates the privacy boundary** (incognito, Tor) in a way that could mislead a user about their
  actual exposure.

The nullsink **service** (nullsink.is) is a separate project — see its
[trust model](https://github.com/nullsink/nullsink/blob/main/docs/trust-model.md) and report
service-side issues upstream.

## Supported versions

The latest released version receives fixes. Please reproduce on the current `main` before reporting.
