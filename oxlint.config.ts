import { defineConfig } from "oxlint";

/**
 * Repo-wide Oxlint config. Oxlint complements the repository's type-aware
 * ESLint config with the vendored anti-slop plugin
 * (tools/oxlint/anti-slop), whose rules reject low-evidence patterns that
 * ESLint does not cover.
 */
export default defineConfig({
  ignorePatterns: [
    // Project-local agent tooling — installed skills, hooks and generated
    // agent configuration are not application source.
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".pi-lens/**",
    ".playwright-mcp/**",
    ".roo/**",
    ".windsurf/**",
    // The vendored plugin itself.
    "tools/oxlint/anti-slop/**",
    // Mirrors of the ESLint flat config's ignores. Oxlint already skips
    // .gitignore-matched paths, but these are declared explicitly so the
    // two linters agree even if .gitignore changes.
    "**/node_modules/**",
    "**/dist/**",
    "**/.turbo/**",
    "apps/web/src/paraglide/**",
    "packages/db/drizzle/**",
    "e2e/test-results/**",
    "e2e/playwright-report/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
