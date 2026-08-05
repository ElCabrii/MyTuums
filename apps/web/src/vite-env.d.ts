/// <reference types="vite/client" />

/**
 * The `VITE_`-prefixed variables this app reads.
 *
 * Declaring them turns a typo into a type error instead of `undefined` at
 * runtime — `import.meta.env.VITE_ANYTHING` is otherwise `any` under Vite's
 * default `ImportMetaEnv`. All three are optional: none of them is required
 * for the app to run, they only switch on auth options that need matching
 * server-side credentials.
 *
 * Anything here is PUBLIC. Vite inlines these values into the bundle, so a
 * secret placed in one is a secret published to every visitor — which is why
 * only Google's One Tap *client id* appears (a public identifier by design)
 * and no client secret does.
 */
interface ImportMetaEnv {
  /**
   * Google OAuth client id, needed in the browser because Google's One Tap
   * script runs in the page. Unset disables the One Tap prompt.
   * @see shouldOfferOneTap in src/lib/auth-client.ts
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string;

  /**
   * Comma-separated OAuth provider ids to show sign-in buttons for, e.g.
   * `google,discord`. Must match the providers actually configured with
   * credentials on the server — see packages/auth/src/social.ts.
   */
  readonly VITE_SOCIAL_PROVIDERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The `version` field of apps/web/package.json, inlined by the `define` block
 * in vite.config.ts at build time. Unlike the `VITE_` variables above it does
 * not come from an env file — package.json is the single source of truth, so
 * the footer's "v0.4.2" and the header's stage tag always match the release
 * the bundle was built from.
 */
declare const __APP_VERSION__: string;
