import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { localeDocumentEffect } from "@/atoms/locale";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

beforeEach(() => {
  document.documentElement.lang = "";
  document.title = "";
  document.head.querySelector('meta[name="description"]')?.remove();
  const meta = document.createElement("meta");
  meta.setAttribute("name", "description");
  meta.setAttribute("content", "");
  document.head.appendChild(meta);
});

describe("localeDocumentEffect", () => {
  // Depends on no atoms and runs once per document load — switching locale
  // reloads the document (see `setLocale()`'s default), so there is no
  // in-place locale change this effect needs to react to.
  it("sets html lang, document.title, and the meta description on mount", () => {
    const store = createStore();
    const unsub = store.sub(localeDocumentEffect, () => {});

    expect(document.documentElement.lang).toBe(getLocale());
    expect(document.title).toBe(m.app_document_title());
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      m.app_document_description(),
    );

    unsub();
  });
});
