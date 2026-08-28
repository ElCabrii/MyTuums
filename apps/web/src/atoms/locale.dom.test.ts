import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { localeDocumentEffect } from "@/atoms/locale";
import { getLocale } from "@/paraglide/runtime.js";

beforeEach(() => {
  document.documentElement.lang = "";
});

describe("localeDocumentEffect", () => {
  // Depends on no atoms and runs once per document load — switching locale
  // reloads the document (see `setLocale()`'s default), so route-owned head
  // metadata is recomputed by TanStack Router from the new locale.
  it("sets html lang on mount without owning route metadata", () => {
    document.title = "route-owned title";
    const store = createStore();
    const unsub = store.sub(localeDocumentEffect, () => {});

    expect(document.documentElement.lang).toBe(getLocale());
    expect(document.title).toBe("route-owned title");

    unsub();
  });
});
