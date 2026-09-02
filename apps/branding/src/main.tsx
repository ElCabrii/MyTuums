import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getLocale } from "@/paraglide/runtime.js";
import { App } from "@/app";
import { applyTheme, readStoredTheme } from "@/lib/theme";
import "./index.css";

// Both document-level decisions run before the first render: the theme so a
// dark-mode visitor never sees a white flash behind the static background in
// index.html, the language so `lang` matches what Paraglide is about to emit.
applyTheme(readStoredTheme() ?? "system");
document.documentElement.lang = getLocale();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
