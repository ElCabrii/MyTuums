# Security policy

MyTuums is a Twitter-style social app (posts, likes, follows, profiles, auth).
This document also serves as policy context for the agentic security scanner
(cyberseek) — keep the attack-surface notes factual.

## Reporting

- For sensitive issues, use GitHub's private vulnerability reporting (Security
  tab). Anything less sensitive can go in a regular issue.
- There is no bug bounty. Coordinated disclosure within 30 days is appreciated.

## Supported surface

- `main` is the only supported branch; production runs on Railway (EU region).

## Attack surface notes

- **Media uploads** are the primary untrusted input: the MIME-sniffing +
  WebP-dimension validation path, the presigned-upload flow, and `/media/`
  serving are the hot spots.
- **Auth** is better-auth composition (OAuth providers, two-factor, passkeys)
  in `packages/auth`; the OAuth callback trust decisions live there.
- The **API** (`apps/server`, `packages/api`) handles all user input; rate
  limiting keys on the signed-in user; there is no anonymous surface.
