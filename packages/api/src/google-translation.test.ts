import type { protos } from "@google-cloud/translate";
import { describe, expect, it } from "vitest";
import {
  createGoogleTranslator,
  GOOGLE_TRANSLATION_API_ENDPOINT,
  GOOGLE_TRANSLATION_MODEL,
  GOOGLE_TRANSLATION_TIMEOUT_MS,
  GoogleTranslationError,
  GoogleTranslationTimeoutError,
  type TranslateTextClient,
  type TranslateTextClientFactory,
  type TranslateTextClientOptions,
} from "./google-translation.js";

/**
 * The provider slice of the translation POC (issue #310), pinned against a
 * fake client factory — Google is reached by exactly nothing here, and never
 * by CI. One behavioral fact per test.
 */

type TranslateTextResponse = protos.google.cloud.translation.v3.ITranslateTextResponse;
type TranslateCall = {
  request: Parameters<TranslateTextClient["translateText"]>[0];
  options: Parameters<TranslateTextClient["translateText"]>[1];
};

/** What `stubFactory` hands back: the factory to inject plus what it recorded. */
interface StubTranslator {
  factory: TranslateTextClientFactory;
  calls: TranslateCall[];
  clientOptions: TranslateTextClientOptions[];
}

/** A factory whose client answers from a script, recording every call. */
function stubFactory(script: Array<Error | TranslateTextResponse>): StubTranslator {
  const calls: TranslateCall[] = [];
  const clientOptions: TranslateTextClientOptions[] = [];
  let next = 0;
  const factory: TranslateTextClientFactory = {
    createClient: (options) => {
      clientOptions.push(options);
      const client: TranslateTextClient = {
        translateText: (request, callOptions) => {
          calls.push({ request, options: callOptions });
          const response = script[next];
          next += 1;
          if (response === undefined) throw new Error("unexpected extra translateText call");
          if (response instanceof Error) return Promise.reject(response);
          const tuple: [TranslateTextResponse] = [response];
          return Promise.resolve(tuple);
        },
      };
      return client;
    },
  };
  return { factory, calls, clientOptions };
}

const CONFIG = {
  projectId: "test-project",
  clientEmail: "translator@test-project.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
};

function response(
  translations: { translatedText?: string; detectedLanguageCode?: string | null }[],
): TranslateTextResponse {
  return { translations };
}

describe("createGoogleTranslator", () => {
  it("exposes the stable model identity used as the cache key", () => {
    const { factory } = stubFactory([]);
    expect(createGoogleTranslator({ ...CONFIG, clientFactory: factory }).model).toBe(
      GOOGLE_TRANSLATION_MODEL,
    );
  });

  it("builds the client against the EU endpoint with the service-account credentials", () => {
    const { factory, clientOptions } = stubFactory([]);
    createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]?.apiEndpoint).toBe(GOOGLE_TRANSLATION_API_ENDPOINT);
    expect(clientOptions[0]?.apiEndpoint).toBe("translate-eu.googleapis.com");
    expect(clientOptions[0]?.projectId).toBe("test-project");
    expect(clientOptions[0]?.credentials.client_email).toBe(CONFIG.clientEmail);
    expect(clientOptions[0]?.credentials.private_key).toBe(CONFIG.privateKey);
  });

  it("normalizes an escaped-newline private key before handoff", () => {
    const { factory, clientOptions } = stubFactory([]);
    createGoogleTranslator({
      ...CONFIG,
      privateKey: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n",
      clientFactory: factory,
    });

    expect(clientOptions[0]?.credentials.private_key).toBe(
      "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
    );
  });

  it("sends one EU-pinned NMT request with detection, preserving input order", async () => {
    const { factory, calls } = stubFactory([
      response([
        { translatedText: "Bonjour le monde", detectedLanguageCode: "en" },
        { translatedText: "Au revoir", detectedLanguageCode: "en" },
      ]),
    ]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    const results = await translator.translate(["Hello world", "Goodbye"], "fr");

    expect(calls).toHaveLength(1);
    const request = calls[0]?.request;
    expect(request?.parent).toBe("projects/test-project/locations/eu");
    expect(request?.model).toBe("projects/test-project/locations/eu/models/general/nmt");
    expect(request?.mimeType).toBe("text/plain");
    expect(request?.targetLanguageCode).toBe("fr");
    expect(request?.contents).toEqual(["Hello world", "Goodbye"]);
    expect("sourceLanguageCode" in (request ?? {})).toBe(false);
    expect(results).toEqual([
      { content: "Bonjour le monde", detectedSourceLocale: "en" },
      { content: "Au revoir", detectedSourceLocale: "en" },
    ]);
  });

  it("maps a missing or empty detection to null", async () => {
    const { factory } = stubFactory([
      response([
        { translatedText: "Bonjour" },
        { translatedText: "Salut", detectedLanguageCode: "" },
      ]),
    ]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    const results = await translator.translate(["Hello", "Hi"], "fr");

    expect(results).toEqual([
      { content: "Bonjour", detectedSourceLocale: null },
      { content: "Salut", detectedSourceLocale: null },
    ]);
  });

  it("bounds the provider call with the default short timeout", async () => {
    const { factory, calls } = stubFactory([
      response([{ translatedText: "Bonjour", detectedLanguageCode: "en" }]),
    ]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await translator.translate(["Hello"], "fr");

    expect(calls[0]?.options).toEqual({ timeout: GOOGLE_TRANSLATION_TIMEOUT_MS });
  });

  it("honors a configured timeout override", async () => {
    const { factory, calls } = stubFactory([
      response([{ translatedText: "Bonjour", detectedLanguageCode: "en" }]),
    ]);
    const translator = createGoogleTranslator({
      ...CONFIG,
      timeoutMs: 1234,
      clientFactory: factory,
    });

    await translator.translate(["Hello"], "fr");

    expect(calls[0]?.options).toEqual({ timeout: 1234 });
  });

  it("classifies the provider's deadline error without exposing its message", async () => {
    const deadline = Object.assign(new Error("provider detail"), { code: 4 });
    const { factory } = stubFactory([deadline]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate(["Hello"], "fr")).rejects.toEqual(
      new GoogleTranslationTimeoutError(),
    );
  });

  it("translates nothing without calling the provider", async () => {
    const { factory, calls } = stubFactory([]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate([], "fr")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("throws when the provider returns fewer results than inputs", async () => {
    const { factory } = stubFactory([
      response([{ translatedText: "Bonjour", detectedLanguageCode: "en" }]),
    ]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate(["Hello", "Goodbye"], "fr")).rejects.toThrow(
      GoogleTranslationError,
    );
  });

  it("throws when the provider returns more results than inputs", async () => {
    const { factory } = stubFactory([
      response([
        { translatedText: "Bonjour", detectedLanguageCode: "en" },
        { translatedText: "En trop", detectedLanguageCode: "en" },
      ]),
    ]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate(["Hello"], "fr")).rejects.toThrow(GoogleTranslationError);
  });

  it("throws when a result carries no translated text", async () => {
    const { factory } = stubFactory([response([{ detectedLanguageCode: "en" }])]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate(["Hello"], "fr")).rejects.toThrow(GoogleTranslationError);
  });

  it("throws when a result carries empty translated text", async () => {
    const { factory } = stubFactory([
      response([{ translatedText: "", detectedLanguageCode: "en" }]),
    ]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate(["Hello"], "fr")).rejects.toThrow(GoogleTranslationError);
  });

  it("throws when the provider answers without a translations array", async () => {
    const { factory } = stubFactory([{}]);
    const translator = createGoogleTranslator({ ...CONFIG, clientFactory: factory });

    await expect(translator.translate(["Hello"], "fr")).rejects.toThrow(GoogleTranslationError);
  });
});
