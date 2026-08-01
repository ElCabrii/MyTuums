# Legal documents — read this first

This folder contains draft legal documents for MyTuums, written for your specific situation: an individual, non-profit, France-published social app, hosted on Railway (EU region). They are a strong starting draft grounded in the actual codebase (what data is collected, how auth works, what's hosted where) and in current French/EU law as of August 2026 — **not a substitute for a lawyer**. For a project with real users' personal data, a one-off consultation with a French avocat (many offer fixed-price document reviews) before publishing is a reasonable investment even for a non-profit.

## Files

| File | Purpose |
|---|---|
| `mentions-legales.fr.md` | The mandatory French "legal notice" (LCEN). French-only — this is a filing type the law doesn't expect in translation. |
| `privacy-policy.fr.md` / `privacy-policy.en.md` | RGPD/GDPR-compliant privacy policy. French is the authoritative version; English is a courtesy translation. |
| `terms-of-service.fr.md` / `terms-of-service.en.md` | Conditions Générales d'Utilisation / Terms of Service. Same authority rule. |

## Filled-in placeholders

All five documents now use:

- **Domain:** `mytuums.com` — an assumption based on the contact email below. **Confirm this is actually your domain before publishing** — if not, find-and-replace `mytuums.com` across the folder.
- **Contact email:** `contact@mytuums.com` — for privacy requests, content reports, and legal correspondence.

One placeholder remains, inside a commented-out alternative paragraph in `mentions-legales.fr.md`: `[Prénom NOM]` / `[adresse]`, only relevant if you ever abandon the anonymous-editor option (see below).

## The anonymity choice you made — and one thing you must actually do

You chose to stay anonymous on the public-facing legal notice. That's legally available to you under **Article 1‑1, II of the LCEN** (added by the SREN law, n° 2024‑449 of 21 May 2024): a non-professional individual editor can withhold their name from the public *provided they have given their real identity to their hosting provider*.

**This only works if it's actually true.** The identity on file with Railway (your account name, and if applicable your billing details) has to be your genuine legal identity — not a handle or pseudonym. If your Railway account isn't in your real name, the anonymity clause in `mentions-legales.fr.md` would be citing a legal basis you haven't actually satisfied, which defeats the purpose and could look worse than not claiming it at all if it were ever tested. **Check your Railway account details before you publish this notice.**

The trade-off worth understanding: if a dispute or legal process ever requires identifying you, French authorities have to go through Railway — a US company — rather than a French host, which is slower (mutual legal assistance, not a domestic request). That's the cost of the anonymity option; it doesn't remove your identity, it just adds a step and a border to reaching it.

## Contact email — make sure `contact@mytuums.com` actually exists

The documents publish `contact@mytuums.com` throughout. Before this goes live, make sure that address actually delivers somewhere you'll see it — set up forwarding at your domain registrar (usually free) to your real inbox, rather than letting privacy/legal requests vanish into an unconfigured mailbox.

## Wired into the app

`/privacy`, `/terms`, and `/mentions-legales` are live routes (`apps/web/src/routes/`), rendering the same text as the `.md` files here via components in `apps/web/src/components/legal/`. The footer links now point at them instead of `#`. `/privacy` and `/terms` switch between the French and English content based on the site's current locale (same mechanism as the footer's language picker); `/mentions-legales` is French-only, matching the `.md` version.

**These are now two representations of the same text** — the `.md` files here (useful for review, diffing, or sending to a lawyer) and the JSX in `apps/web/src/components/legal/`. Any future wording change has to be made in both places; nothing keeps them in sync automatically.

## What's *not* in here yet

- **Cookie banner**: not needed today — the only cookie is BetterAuth's strictly-necessary session cookie, which is exempt from consent under CNIL guidance (info only, no banner required). If you ever add analytics or ads, the Privacy Policy's cookie section needs updating first and a consent banner becomes mandatory.
- **A working account-deletion flow**: the Privacy Policy promises erasure "within 30 days" of a request. Right now that would have to be you, manually, running a delete against the `user` row (which cascades to posts/likes/follows/sessions per the schema). That's fine at hobby scale, but it's a promise you're on the hook for.

## Everything these documents assume about the app

Derived from the current codebase, not guessed: email/password auth via BetterAuth (no OAuth, no email verification currently enabled), username + display name + optional avatar, posts/replies/likes/follows all public, session cookies expire after 7 days of inactivity (BetterAuth default), no analytics, no ads, no third-party email-sending service, no data sold, single processor (Railway, EU region for compute + Postgres). If any of that changes, the documents need a matching update — that's true of every privacy policy, not a flaw in this one.
