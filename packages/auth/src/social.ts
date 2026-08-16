/**
 * OAuth providers, each registered only when its credentials are present.
 *
 * See ./env.ts for why absence is the default rather than an error. The
 * practical consequence is that `configuredSocialProviders` is the honest list
 * of what this deployment can actually do — the web app reads the same idea off
 * `VITE_*` variables to decide which buttons to render, so a provider without
 * secrets shows no button rather than a button that fails at the token
 * exchange.
 *
 * None of these map a username. That is deliberate: the `username` plugin does
 * not populate `user.username` on social sign-up and has no auto-generation
 * option, and this app keys every profile URL, follow list and
 * `user.byUsername` lookup on that column. Rather than invent a handle nobody
 * chose, a social sign-up lands with `username` null and the web app's
 * `/welcome` gate asks for one before the account is usable. See
 * `apps/web/src/hooks/use-require-handle.ts`.
 */
import type { BetterAuthOptions } from "better-auth";
import { oauthCredentials } from "./env.js";

type SocialProviders = NonNullable<BetterAuthOptions["socialProviders"]>;

const google = oauthCredentials("GOOGLE");
const discord = oauthCredentials("DISCORD");
const twitch = oauthCredentials("TWITCH");

/** The OAuth providers this deployment is actually configured for, keyed by provider id (file header explains the why). */
export const socialProviders: SocialProviders = {};

if (google) {
  socialProviders.google = {
    ...google,
    // Without this, Google silently reuses whichever account the browser
    // is already signed into, which on a shared machine signs the person
    // in as somebody else with no visible choice. It is also what makes
    // "wrong account" recoverable without clearing cookies.
    prompt: "select_account",
  };
}

if (discord) {
  socialProviders.discord = {
    ...discord,
    // Discord accounts verified by phone alone return no email, and
    // Better Auth requires one on every user row — without this the flow
    // dies with `error=email_not_found` after the person has already
    // consented. `.invalid` is reserved by RFC 2606 precisely so it can
    // never route, which keeps a placeholder from being mistaken for a
    // contact address by anything that later sends mail.
    mapProfileToUser: (profile) => ({
      email: profile.email ?? `${profile.id}@discord.invalid`,
    }),
  };
}

if (twitch) {
  socialProviders.twitch = {
    ...twitch,
    mapProfileToUser: (profile) => ({
      email: profile.email ?? `${profile.sub}@twitch.invalid`,
    }),
  };
}

/** Provider ids this deployment has credentials for, in the order they should be offered. */
export const configuredSocialProviders = Object.keys(socialProviders);

/**
 * Providers whose accounts may be linked automatically to an existing user
 * with the same email address.
 *
 * This is the security-load-bearing half of `account.accountLinking`. Automatic
 * linking on an email match is an account-takeover primitive when the provider
 * does not itself verify that the person owns the address: anyone able to set
 * an arbitrary email on a provider account could claim a MyTuums account by
 * signing in through it.
 *
 * Google and Discord both expose a trustworthy verification signal. Twitch is
 * excluded on purpose: the exclusion makes a matching-email sign-in require
 * the provider's own email to be verified — when it is not, the attempt is
 * REFUSED ("account not linked" — better-auth's oauth2/link-account.mjs)
 * rather than silently linked. When BOTH the Twitch email and the local
 * account's email are verified, the link still happens silently, exactly as
 * it would for a trusted provider.
 *
 * Being on this list does not mean the link happens silently for everyone:
 * `accountLinking.requireLocalEmailVerified` defaults to `true`, so an
 * existing account whose email is unverified is still asked to link
 * deliberately — and most local accounts ARE unverified (sign-up does not
 * require verification). This list only says the provider is trusted enough
 * for implicit linking to be *offered* at all; the verified-email gate above
 * it decides per account.
 */
export const trustedProviders = ["google", "discord"].filter((id) =>
  configuredSocialProviders.includes(id),
);
