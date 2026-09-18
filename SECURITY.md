# Security & Privacy

AIPM is built to be safe to run on a real desktop, including regulated ones (banking, healthcare,
government). This document states exactly what it does and does not do.

## Threat model & posture

- **Loopback only.** The backend listens on `127.0.0.1:9147` and rejects requests whose `Host` header
  is not local. It is never bound to `0.0.0.0` and is not reachable from the network.
- **Read-only by default.** All perception endpoints are GET. The action tier (`ui_act`,
  `ui_invoke`, `ui_set_value`, `ui_select_option`, `ui_send_keys`, `ui_drag`, `focus_window`, plus
  `ui_capture`) is **off** until the user enables it *and* allow-lists each app.
  Denied actions return `action_denied` with guidance — they never silently execute.
- **No pixels leave the machine.** AIPM reads structured UI Automation state, not screenshots. The
  only image path is `POST /ui/capture`: it crops one element's rect on request, refuses without a
  target (it never photographs the window or the screen by omission), sits behind the same opt-in
  action tier, and never leaves loopback.
- **Metadata only in logs.** The audit log records *which* endpoint an agent called and the target
  element — never screen content and never the typed value. Secrets (`api_key=`) and user-typed values
  (`value=`) are masked before anything is written to the in-memory ring buffer or persisted to disk.

## Tamper-evident ledger (integrity)

Effective actions and task/action outcomes are appended to a **hash-chained** audit ledger:

- Each entry stores the SHA-256 hash of the previous entry (`prev`); the first entry's `prev` is 64
  zeros (genesis). Preimage: `seq | ts | event | app | action | prev`.
- `GET /ledger/verify` recomputes the whole chain and reports `intact`, the number of entries, and the
  **first tampered entry** if any — so a single altered, inserted, removed, or reordered line is
  detected and located.
- The check is reproducible **offline in any language** (e.g. Python `hashlib`) with no vendor code, so
  an external auditor confirms integrity without trusting us. Aligns with EU AI Act Art. 12 (logging).

**Honest limit:** v1 is a pure hash-chain. It detects tampering and locates it, but does **not**, by
itself, stop a *full rewrite* of the entire chain by someone with write access to the file. v2 adds an
identity signature (HMAC/Ed25519) and off-machine anchoring of the chain head. The timestamp is the
machine clock, not a trusted timestamp authority.

## Cryptography

- The paid license uses **Ed25519**; the **private key never ships** in any distributable — released
  binaries carry the public key only.
- The purchase webhook verifies **HMAC-SHA256** with constant-time comparison.

## Reporting a vulnerability

Please open a private report via GitHub Security Advisories on this repository, or email the address on
the maintainer's GitHub profile. Do not file public issues for security problems. We aim to acknowledge
within a few days — this is a small, independent project, so please set expectations accordingly.
