/// <reference types="vite/client" />

/**
 * The `VITE_`-prefixed variables this app reads.
 *
 * Declaring them turns a typo into a type error instead of `undefined` at
 * runtime — `import.meta.env.VITE_ANYTHING` is otherwise `any` under Vite's
 * default `ImportMetaEnv`. All are optional: none is required for the app to
 * run, and each enables one configured integration.
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

  /**
   * Public GA4 measurement id. Unset disables analytics and its consent UI.
   * The Docker image also retains this public flag so the server can emit the
   * matching conditional Content-Security-Policy.
   */
  readonly VITE_GA_MEASUREMENT_ID?: string;
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

/**
 * `gifenc` (issue #201) ships no types of its own and has none published to
 * DefinitelyTyped. This covers exactly the exports `lib/gif-pipeline.ts`
 * calls — not the whole surface documented in its README (dithering options,
 * `prequantize`, `nearestColor*`, manual-mode `first`/`bytesView`) — so an
 * unused option silently typo'd would still be caught by nothing, but every
 * option this app actually passes is checked.
 */
declare module "gifenc" {
  // Variable-length rather than a strict RGB/RGBA tuple: `rgb565`/`rgb444`
  // return 3-length colors and `rgba4444` returns 4-length colors, and the
  // pipeline reads `color[3]` only after requesting the latter.
  export type GifColor = readonly number[];
  export type GifPalette = ReadonlyArray<GifColor>;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: "rgb565" | "rgb444" | "rgba4444";
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaColor?: number;
    },
  ): GifPalette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;

  export interface GifWriteFrameOptions {
    palette?: GifPalette;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    dispose?: number;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: GifWriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
  }

  export function GIFEncoder(options?: {
    initialCapacity?: number;
    auto?: boolean;
  }): GifEncoderInstance;
}
