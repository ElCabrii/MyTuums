# MyTuums — the product

**For development setup, architecture, and conventions → [README.md](README.md).**

## What it is

MyTuums is a Twitter-style social app: short posts, likes, replies, a follow
graph, and profiles — with real authentication. It runs as a single origin:
one API serves the SPA, auth, and media, so there is no CORS surface to
manage.

## Features

- Posts, likes, replies, follows, and user profiles
- Full auth, composed with better-auth: email/password, OAuth (Google, Discord,
  Twitch), two-factor, passkeys, one-tap sign-in
- Moderation: a role hierarchy (user → moderator → staff → admin), a report
  queue, post removals, timed suspensions and permanent bans, an append-only
  audit log, and an email-linked appeal path — see [CONTEXT.md](CONTEXT.md) for
  the vocabulary
- User blocks: mutual, silent, and private — not a moderation action
- Image uploads with MIME sniffing and WebP dimension validation, served via
  S3 presigned URLs
- i18n in English and French (Paraglide), light/dark theme
- Rate limiting keyed on the signed-in user; keyset-paginated feeds

## How it runs

- **Production:** Railway in the EU — Postgres and S3-compatible object
  storage in the same region as the app.
- **CI:** GitHub Actions — lint, unit, integration, Playwright e2e, Docker
  build, and a weekly agentic security scan whose findings land in GitHub
  code scanning.

## Security posture

- One-origin architecture (no cross-origin API surface)
- Environment validated at boot — a partial OAuth or S3 credential pair
  refuses to start the server
- Weekly agentic security scan (DeepSeek-powered) + a written policy in
  [SECURITY.md](SECURITY.md)
- Environments are separated: non-production tooling never touches the
  production bucket (the e2e suite deletes objects by prefix during cleanup)
