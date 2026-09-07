/**
 * The Google Cloud Translation adapter for the post-translation POC
 * (issue #310) — the provider slice only: a small `Translator` seam plus the
 * pure factory that builds the Cloud Translation Advanced v3 implementation.
 *
 * Fixed wire rules, all load-bearing for the POC's privacy and billing
 * posture: requests go to the EU multi-regional endpoint
 * (`translate-eu.googleapis.com`), never the global one, with the parent
 * location `europe-west1` and the pre-trained NMT model
 * (`projects/<project>/locations/europe-west1/models/general/nmt`). There is
 * deliberately no fallback: a request that cannot be served from the EU
 * endpoint fails rather than silently processing elsewhere.
 *
 * Source-language detection is the API's, not ours: `sourceLanguageCode` is
 * omitted so every response carries the detection, which the caller reads
 * off `detectedLanguageCode` and stores with the cached result. There is no
 * local French/English heuristic and no source-language column on `post`.
 *
 * This module is a pure factory, exactly like `./storage.ts` — it reads no
 * environment of its own. `context.ts` builds the single process-wide
 * instance from the `GOOGLE_TRANSLATION_*` group and threads it onto every
 * `Context`, and tests inject a fake client factory through the same config,
 * so no test ever reaches Google. Nothing here logs text or credentials:
 * failure messages carry counts only, never content.
 */
import { TranslationServiceClient, protos } from "@google-cloud/translate";
import { z } from "zod";

type TranslateTextRequest = protos.google.cloud.translation.v3.ITranslateTextRequest;
type TranslateTextResponse = protos.google.cloud.translation.v3.ITranslateTextResponse;

/** The EU multi-regional endpoint — the only endpoint this adapter dials. */
export const GOOGLE_TRANSLATION_API_ENDPOINT = "translate-eu.googleapis.com";

/** The EU region every parent and model resource is built from. */
export const GOOGLE_TRANSLATION_LOCATION = "europe-west1";

/**
 * The stable cache identity of this provider/model pair. Stored as the
 * `provider_model` half of the translation cache key, so switching models
 * (NMT today, something else later) invalidates existing rows cleanly:
 * bump this when the model resource below changes.
 */
export const GOOGLE_TRANSLATION_MODEL = "google-nmt-europe-west1";

/**
 * Wall-clock ceiling on one `translateText` call, passed through the
 * client's supported per-call options. Translation is a view-time overlay
 * behind its own short deadline, so a hung provider call must fail fast
 * rather than hold a feed render open.
 */
export const GOOGLE_TRANSLATION_TIMEOUT_MS = 5_000;

/** The only viewer locales the POC translates into. */
export type TranslationTargetLocale = "en" | "fr";

/** One translated input, in the same position as its source. */
export interface TranslationResult {
  content: string;
  detectedSourceLocale: string | null;
}

/**
 * The translation seam threaded on `Context`. `model` is the cache identity
 * above; `translate` preserves input order one-to-one and throws on a
 * short/long or content-less response rather than handing a misaligned or
 * empty string to any renderer.
 */
export interface Translator {
  readonly model: string;
  translate(
    contents: readonly string[],
    targetLocale: TranslationTargetLocale,
  ): Promise<TranslationResult[]>;
}

/**
 * The narrow surface of `TranslationServiceClient` this adapter uses — the
 * half of the seam tests drive with a fake. Typed structurally so a fake
 * needs only the one promise-shaped method, not the client's callback
 * overloads.
 */
export interface TranslateTextClient {
  translateText(
    request: TranslateTextRequest,
    options?: { timeout?: number },
  ): Promise<[TranslateTextResponse, ...unknown[]]>;
}

/** The client options this adapter always constructs the provider with. */
export interface TranslateTextClientOptions {
  apiEndpoint: string;
  projectId: string;
  credentials: { client_email: string; private_key: string };
}

/**
 * How the provider client is constructed — the seam that lets tests capture
 * the constructor wiring (the EU endpoint pin, the credential handoff)
 * without reaching the network.
 */
export interface TranslateTextClientFactory {
  createClient(options: TranslateTextClientOptions): TranslateTextClient;
}

/** Everything needed to talk to Cloud Translation as one service account. */
export interface GoogleTranslatorConfig {
  projectId: string;
  clientEmail: string;
  /**
   * The service account's PEM private key. Environment variables often carry
   * it with escaped newlines, so those are normalized before handoff — the
   * value itself is never logged.
   */
  privateKey: string;
  /** Override for tests; defaults to `GOOGLE_TRANSLATION_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Override so a test can drive translation without reaching Google. */
  clientFactory?: TranslateTextClientFactory;
}

/** Raised when the provider answers with the wrong shape — counts only, never text. */
export class GoogleTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTranslationError";
  }
}

/** A provider deadline, separated so content-free metrics can classify it. */
export class GoogleTranslationTimeoutError extends GoogleTranslationError {
  constructor() {
    super("Google translation timed out.");
    this.name = "GoogleTranslationTimeoutError";
  }
}

// The wire contract, parsed where the bytes arrive (the same boundary rule
// `./igdb.ts` follows): every field the provider may omit is optional or
// nullable here, and an empty `translatedText` is refused — a content-less
// result must throw, not render. `detectedLanguageCode` normalizes an absent
// or empty detection to `null` so callers branch on one shape.
const googleTranslationSchema = z.object({
  translatedText: z.string().min(1),
  detectedLanguageCode: z
    .string()
    .nullish()
    .transform((code) => (code !== null && code !== undefined && code.length > 0 ? code : null)),
});

const googleTranslateTextResponseSchema = z.object({
  translations: z.array(googleTranslationSchema),
});

const googleDeadlineErrorSchema = z.object({
  code: z.union([z.literal(4), z.literal("DEADLINE_EXCEEDED")]),
});

const defaultClientFactory: TranslateTextClientFactory = {
  // Rebuilt field by field (rather than spread) so exactly the three pinned
  // values cross into the provider's own options — and as a fresh literal,
  // which is what the client's index-signed options type accepts.
  createClient: (options) =>
    new TranslationServiceClient({
      apiEndpoint: options.apiEndpoint,
      projectId: options.projectId,
      credentials: {
        client_email: options.credentials.client_email,
        private_key: options.credentials.private_key,
      },
    }),
};

/**
 * The production factory. Builds the client against the fixed EU endpoint
 * with the service-account credentials, then returns the `Translator` that
 * translates bounded batches through the NMT model with source detection.
 */
export function createGoogleTranslator(config: GoogleTranslatorConfig): Translator {
  const timeoutMs = config.timeoutMs ?? GOOGLE_TRANSLATION_TIMEOUT_MS;
  const privateKey = config.privateKey.includes("\\n")
    ? config.privateKey.replace(/\\n/g, "\n")
    : config.privateKey;
  const factory = config.clientFactory ?? defaultClientFactory;
  const client = factory.createClient({
    apiEndpoint: GOOGLE_TRANSLATION_API_ENDPOINT,
    projectId: config.projectId,
    credentials: { client_email: config.clientEmail, private_key: privateKey },
  });
  const parent = `projects/${config.projectId}/locations/${GOOGLE_TRANSLATION_LOCATION}`;
  const model = `projects/${config.projectId}/locations/${GOOGLE_TRANSLATION_LOCATION}/models/general/nmt`;

  return {
    model: GOOGLE_TRANSLATION_MODEL,
    async translate(contents, targetLocale): Promise<TranslationResult[]> {
      if (contents.length === 0) return [];
      let response: TranslateTextResponse;
      try {
        [response] = await client.translateText(
          {
            parent,
            contents: [...contents],
            mimeType: "text/plain",
            targetLanguageCode: targetLocale,
            model,
          },
          { timeout: timeoutMs },
        );
      } catch (error) {
        if (googleDeadlineErrorSchema.safeParse(error).success) {
          throw new GoogleTranslationTimeoutError();
        }
        throw new GoogleTranslationError("Google translation request failed.");
      }
      const parsed = googleTranslateTextResponseSchema.safeParse(response);
      if (!parsed.success || parsed.data.translations.length !== contents.length) {
        const received = parsed.success ? parsed.data.translations.length : 0;
        throw new GoogleTranslationError(
          `Google translation returned ${received} result(s) for ${contents.length} input(s).`,
        );
      }
      return parsed.data.translations.map((translation) => ({
        content: translation.translatedText,
        detectedSourceLocale: translation.detectedLanguageCode,
      }));
    },
  };
}
