#!/usr/bin/env node
// Documentation checker for the agent-facing docs. Dependency-free on purpose:
// it runs in CI's `check` job before anything is installed beyond the workspace,
// and a doc check that needs its own dependency tree stops being run locally.
//
// Every check answers one question: "would an agent following this document be
// led somewhere that does not exist, or told something the code contradicts?"
// Parsing stays deliberately conservative — machine-readable markers
// (`<!-- docs:check=... -->`) instead of guessing at prose — so the checker
// stays maintainable as the prose changes.

import { readFileSync, readdirSync, statSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import { join, resolve, posix } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SELF = "scripts/check-docs.mjs";

const failures = [];

/** Record one actionable failure: where it is, what is wrong, and what to do. */
function fail(file, message, fix) {
  failures.push({ file, message, fix });
}

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel) => existsSync(join(ROOT, rel));

// --------------------------------------------------------------------------
// Expectations
// --------------------------------------------------------------------------

/** Documents that must exist, with the `##` headings each must carry. */
const REQUIRED_DOCS = {
  "README.md": [
    "Stack",
    "Prerequisites",
    "Setup",
    "Common commands",
    "Repository layout",
    "Documentation",
  ],
  "AGENTS.md": [
    "Repository",
    "Non-negotiable rules",
    "Task routing",
    "Cross-cutting invariants",
    "Generated files",
    "Verification matrix",
    "Further reading",
  ],
  "SECURITY.md": ["Reporting", "Supported versions", "Scope"],
  "docs/architecture.md": [
    "Workspace ownership",
    "Development topology",
    "Production topology",
    "HTTP route order",
    "oRPC context",
    "Client state ownership",
    "Auth and sessions",
    "Media",
    "Moderation",
    "Schemas and migrations",
    "Test topology",
  ],
  "docs/product.md": [
    "Accounts and authentication",
    "Posts, replies, likes, follows",
    "Profiles and search",
    "Media",
    "Locale and theme",
    "Blocks",
    "Moderation",
    "Appeals",
    "Glossary",
  ],
  "docs/operations.md": [
    "Environment file",
    "Local development",
    "Railway",
    "Build-time and runtime configuration",
    "Docker image",
    "Migrations",
    "Observability",
    "CI and smoke checks",
    "Maintenance",
  ],
  "docs/security.md": [
    "Trust boundaries",
    "Exposed surfaces",
    "Authentication and sessions",
    "Rate limiting",
    "Media",
    "Privacy projection",
    "Moderation authority",
    "Configuration and secrets",
    "Test and environment isolation",
  ],
  ".github/AGENTS.md": ["Responsibility", "Start here", "Change map", "Invariants", "Verification"],
  "apps/server/AGENTS.md": [
    "Responsibility",
    "Start here",
    "Change map",
    "Invariants",
    "Verification",
  ],
  "apps/web/AGENTS.md": [
    "Responsibility",
    "Start here",
    "Change map",
    "Invariants",
    "Verification",
  ],
  "packages/api/AGENTS.md": [
    "Responsibility",
    "Start here",
    "Change map",
    "Invariants",
    "Verification",
  ],
  "packages/auth/AGENTS.md": [
    "Responsibility",
    "Start here",
    "Change map",
    "Invariants",
    "Verification",
  ],
  "packages/db/AGENTS.md": [
    "Responsibility",
    "Start here",
    "Change map",
    "Invariants",
    "Verification",
  ],
  "e2e/AGENTS.md": ["Responsibility", "Start here", "Change map", "Invariants", "Verification"],
};

/** Documents deleted by the documentation rewrite. A live reference to one is a dead end. */
const REMOVED_DOCS = ["CONTEXT.md", "PRODUCT.md"];

/**
 * Generated artefacts. They are absent from a fresh clone (so link checking must
 * tolerate them) and no document may tell an agent to edit one by hand.
 */
const GENERATED_PATHS = [
  "apps/web/src/routeTree.gen.ts",
  "apps/web/src/paraglide",
  "packages/db/src/schema/auth.ts",
  "packages/db/drizzle",
  "pnpm-lock.yaml",
];

/** Paths a document may legitimately mention although a fresh clone has no such file. */
const ABSENT_PATH_ALLOWLIST = new Set([
  ...GENERATED_PATHS,
  "apps/web/dist",
  "apps/web/node_modules",
  "apps/server/dist",
  "apps/server/dist/migrate.js",
  "packages/db/drizzle/meta/_journal.json",
  "e2e/.auth",
  "e2e/playwright-report",
  "lighthouse-reports",
]);

/** The root agent guide is a router, not a manual. Past this it stops being read in full. */
const ROOT_AGENTS_MAX_BYTES = 9000;

/** pnpm subcommands that are not workspace scripts. */
const PNPM_BUILTINS = new Set([
  "install",
  "add",
  "remove",
  "exec",
  "dlx",
  "run",
  "why",
  "update",
  "store",
  "list",
  "outdated",
  "approve-builds",
]);

// --------------------------------------------------------------------------
// File collection
// --------------------------------------------------------------------------

// Tool-owned and build-output trees. Their contents are generated — a README
// the Paraglide compiler writes into `project.inlang/` is not this repository's
// documentation, and holding it to these rules just fails the build after an
// unrelated `pnpm build`.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  "paraglide",
  "project.inlang",
  "drizzle",
  "test-results",
  "playwright-report",
  ".auth",
]);

/** Every file under `dir`, skipping build output, dependencies and generated trees. */
function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? posix.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(rel, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(rel);
    }
  }
  return out;
}

const allFiles = walk("");

// Symlinks are skipped: every CLAUDE.md points at the AGENTS.md beside it, and
// following them would report each finding twice under two names.
const isSymlink = (rel) => lstatSync(join(ROOT, rel)).isSymbolicLink();
const markdownFiles = allFiles.filter((f) => f.endsWith(".md") && !isSymlink(f));

const SCANNED_TEXT = /\.(md|ts|tsx|mjs|js|json|ya?ml)$/;
const scannedTextFiles = allFiles.filter(
  (f) => SCANNED_TEXT.test(f) && f !== SELF && !isSymlink(f),
);

// --------------------------------------------------------------------------
// 1. Required documents and headings
// --------------------------------------------------------------------------

for (const [doc, headings] of Object.entries(REQUIRED_DOCS)) {
  if (!exists(doc)) {
    fail(
      doc,
      "required document is missing",
      `create ${doc} with the headings ${headings.join(", ")}`,
    );
    continue;
  }
  const body = read(doc);
  const present = [...body.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((m) => m[1]);
  for (const heading of headings) {
    if (!present.some((h) => h.toLowerCase().includes(heading.toLowerCase()))) {
      fail(doc, `missing required heading "${heading}"`, `add a "## ${heading}" section to ${doc}`);
    }
  }
}

// Every top-level section of the architecture document must say where the
// authoritative code lives, or the document becomes an unverifiable retelling.
if (exists("docs/architecture.md")) {
  const body = read("docs/architecture.md");
  const sections = body.split(/^## /m).slice(1);
  for (const section of sections) {
    const title = section.split("\n", 1)[0].trim();
    if (title === "Further reading") continue;
    if (!/^\s*\*\*Source of truth:?\*\*/m.test(section)) {
      fail(
        "docs/architecture.md",
        `section "${title}" has no "Source of truth" line`,
        "add a `**Source of truth:** `path/to/file`` line naming the authoritative repository paths",
      );
    }
  }
}

// --------------------------------------------------------------------------
// 2. Relative Markdown links, and the anchors they point at
// --------------------------------------------------------------------------

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Heading text with the inline markup GitHub strips before slugging: link and
 * image syntax collapse to their text, code spans and emphasis markers go.
 */
function headingText(raw) {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .trim();
}

/**
 * GitHub's heading anchor: lowercase, punctuation dropped, whitespace to
 * hyphens. Letters, digits, `_` and `-` survive — everything else does not.
 */
function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * Every anchor a Markdown body defines, in GitHub's scheme. Fenced blocks are
 * skipped: a `# comment` inside a shell example is not a heading, and treating
 * it as one would invent anchors that GitHub never renders.
 *
 * Repeated headings get the `-1`, `-2`, … suffixes GitHub appends, with the
 * first occurrence keeping the bare slug.
 */
function anchorsFromMarkdown(body) {
  const anchors = new Set();
  const seen = new Map();
  let fence = null;

  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (fence === null) fence = char;
      else if (fence === char) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;

    const slug = slugify(headingText(heading[2]));
    if (!slug) continue;

    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
  }

  return anchors;
}

const anchorCache = new Map();

/** `anchorsFromMarkdown` for a repository-relative Markdown file, memoised. */
function anchorsOf(rel) {
  let anchors = anchorCache.get(rel);
  if (!anchors) {
    anchors = anchorsFromMarkdown(read(rel));
    anchorCache.set(rel, anchors);
  }
  return anchors;
}

/** The fragment as an anchor: percent-decoded when it decodes cleanly. */
function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * The verdict on one link: `null` when it is fine, otherwise the failure to
 * report. Pure — the filesystem arrives through `fileExists`/`anchorsFor` — so
 * the self-tests below can exercise every branch without touching disk.
 */
function linkProblem(doc, target, { fileExists, anchorsFor }) {
  if (/^(https?:|mailto:)/.test(target)) return null;

  const hash = target.indexOf("#");
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  const fragment = hash === -1 ? "" : decodeFragment(target.slice(hash + 1));

  // A bare `#fragment` points into the document it is written in.
  const targetDoc = pathPart ? posix.normalize(posix.join(posix.dirname(doc), pathPart)) : doc;

  if (pathPart && !fileExists(targetDoc)) {
    return {
      message: `broken relative link "${target}"`,
      fix: `point it at a file that exists (resolved to ${targetDoc})`,
    };
  }

  // Anchors only mean something in Markdown; anything else is opaque here.
  if (!fragment || !targetDoc.endsWith(".md")) return null;

  if (!anchorsFor(targetDoc).has(fragment)) {
    const where = pathPart ? targetDoc : "this document";
    return {
      message: `link "${target}" points at "#${fragment}", which is not a heading in ${where}`,
      fix: "use one of its headings, or fix the heading it should match",
    };
  }

  return null;
}

const liveLinkDeps = { fileExists: exists, anchorsFor: anchorsOf };

for (const doc of markdownFiles) {
  const body = read(doc);
  for (const match of body.matchAll(LINK)) {
    const problem = linkProblem(doc, match[1], liveLinkDeps);
    if (problem) fail(doc, problem.message, problem.fix);
  }
}

// --------------------------------------------------------------------------
// 3. Repository paths cited in inline code
// --------------------------------------------------------------------------

const CODE_SPAN = /`([^`\n]+)`/g;
const PATH_SHAPE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._*-]+)+\/?$/;
const TOP_LEVEL_DIRS = new Set(["apps", "packages", "e2e", "docs", "scripts", ".github"]);

/**
 * A code span that looks like it names a file in this repository, or null.
 * Glob segments are dropped down to the deepest directory that can be checked:
 * `src/paraglide/**` and `.auth/*.json` become `src/paraglide` and `.auth`.
 */
function candidatePath(span) {
  if (!PATH_SHAPE.test(span)) return null;
  const segments = span.replace(/\/$/, "").split("/");
  while (segments.length > 1 && segments[segments.length - 1].includes("*")) segments.pop();
  const cleaned = segments.join("/");
  if (cleaned.includes("*")) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (segments.length < 2) return null;
  if (!TOP_LEVEL_DIRS.has(first) && !/\.[A-Za-z0-9]+$/.test(last)) return null;
  return cleaned;
}

for (const doc of markdownFiles) {
  const body = read(doc);
  for (const match of body.matchAll(CODE_SPAN)) {
    const cleaned = candidatePath(match[1]);
    if (!cleaned) continue;
    const fromDoc = posix.normalize(posix.join(posix.dirname(doc), cleaned));
    if (ABSENT_PATH_ALLOWLIST.has(cleaned) || ABSENT_PATH_ALLOWLIST.has(fromDoc)) continue;
    if (exists(cleaned) || exists(fromDoc)) continue;
    fail(
      doc,
      `code span \`${match[1]}\` names a path that does not exist`,
      "correct the path or drop the backticks",
    );
  }
}

// --------------------------------------------------------------------------
// 4. Documented pnpm scripts exist in the manifests they belong to
// --------------------------------------------------------------------------

const manifestScripts = new Map();
for (const file of allFiles.filter((f) => f.endsWith("package.json"))) {
  try {
    const manifest = JSON.parse(read(file));
    if (manifest.name) manifestScripts.set(manifest.name, Object.keys(manifest.scripts ?? {}));
  } catch {
    fail(file, "package.json is not valid JSON", "fix the manifest");
  }
}
const rootScripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {});

const FILTERED = /pnpm\s+--filter\s+(@?[\w/@.-]+)\s+([\w:]+)/g;
const ROOT_SCRIPT = /pnpm\s+(?!--)([a-z][\w]*(?::[\w]+)*)/g;
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

/**
 * Only the command text of a document: fenced blocks and inline code spans.
 * Prose says things like "pnpm 10 + Turborepo", which is not a script call.
 */
function commandText(body) {
  const parts = [];
  for (const match of body.matchAll(FENCE)) parts.push(match[1]);
  for (const match of body.replace(FENCE, "").matchAll(CODE_SPAN)) parts.push(match[1]);
  return parts.join("\n");
}

for (const doc of markdownFiles) {
  const body = commandText(read(doc));
  for (const match of body.matchAll(FILTERED)) {
    const [, pkg, script] = match;
    if (PNPM_BUILTINS.has(script)) continue;
    const scripts = manifestScripts.get(pkg);
    if (!scripts) {
      fail(
        doc,
        `documents \`pnpm --filter ${pkg} ${script}\` but no workspace package is named ${pkg}`,
        "use the package's real name",
      );
      continue;
    }
    if (!scripts.includes(script)) {
      fail(
        doc,
        `documents \`pnpm --filter ${pkg} ${script}\` but that package has no "${script}" script`,
        `add the script to ${pkg} or correct the document`,
      );
    }
  }
  for (const match of body.matchAll(ROOT_SCRIPT)) {
    const script = match[1];
    if (PNPM_BUILTINS.has(script)) continue;
    if (!rootScripts.includes(script)) {
      fail(
        doc,
        `documents \`pnpm ${script}\` but the root package.json has no such script`,
        "add the script or document the --filter form instead",
      );
    }
  }
}

// --------------------------------------------------------------------------
// 5. CLAUDE.md is a pointer, never a second source of truth
// --------------------------------------------------------------------------

const agentGuides = markdownFiles.filter((f) => f === "AGENTS.md" || f.endsWith("/AGENTS.md"));

for (const guide of agentGuides) {
  const dir = posix.dirname(guide) === "." ? "" : posix.dirname(guide);
  const pointer = dir ? posix.join(dir, "CLAUDE.md") : "CLAUDE.md";
  if (!exists(pointer)) {
    fail(pointer, "AGENTS.md has no adjacent CLAUDE.md", `symlink it: ln -s AGENTS.md ${pointer}`);
    continue;
  }
  const stats = lstatSync(join(ROOT, pointer));
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(join(ROOT, pointer));
    if (target !== "AGENTS.md") {
      fail(
        pointer,
        `symlink points at "${target}" instead of the adjacent AGENTS.md`,
        `re-link it: ln -sf AGENTS.md ${pointer}`,
      );
    }
    continue;
  }
  const body = read(pointer).trim();
  if (body.length > 200) {
    fail(
      pointer,
      "is a regular file with independent content",
      "replace it with a symlink to the adjacent AGENTS.md, or a one-line pointer",
    );
  } else if (!body.includes("AGENTS.md")) {
    fail(pointer, "does not point at AGENTS.md", "make it a symlink to the adjacent AGENTS.md");
  }
}

// --------------------------------------------------------------------------
// 6. Root agent guide size budget
// --------------------------------------------------------------------------

// Guarded: a missing AGENTS.md is already reported by the required-document
// phase above. Calling statSync unconditionally threw ENOENT here and killed
// the run before any of the accumulated failures could be printed.
if (exists("AGENTS.md")) {
  const rootAgentsBytes = statSync(join(ROOT, "AGENTS.md")).size;
  if (rootAgentsBytes > ROOT_AGENTS_MAX_BYTES) {
    fail(
      "AGENTS.md",
      `is ${String(rootAgentsBytes)} bytes, over the ${String(ROOT_AGENTS_MAX_BYTES)}-byte routing budget`,
      "move implementation detail into a subtree AGENTS.md or docs/",
    );
  }
}

// --------------------------------------------------------------------------
// 7. References to removed documents
// --------------------------------------------------------------------------

for (const file of scannedTextFiles) {
  const body = read(file);
  for (const removed of REMOVED_DOCS) {
    if (body.includes(removed)) {
      fail(
        file,
        `references the removed document ${removed}`,
        "link to docs/product.md, docs/architecture.md or the owning AGENTS.md instead",
      );
    }
  }
}

// --------------------------------------------------------------------------
// 8. Documented API groups match the router
// --------------------------------------------------------------------------

/** The bullet list following a `<!-- docs:check=<name> -->` marker, as backticked identifiers. */
function markedList(doc, name) {
  if (!exists(doc)) return null;
  const body = read(doc);
  const marker = `<!-- docs:check=${name} -->`;
  const start = body.indexOf(marker);
  if (start === -1) return null;
  const rest = body.slice(start + marker.length);
  const items = [];
  for (const line of rest.split("\n")) {
    const bullet = /^[-*]\s+`([^`]+)`/.exec(line.trim());
    if (bullet) {
      items.push(bullet[1]);
      continue;
    }
    if (line.trim() === "") continue;
    if (items.length > 0) break;
  }
  return items;
}

const routerSource = read("packages/api/src/router.ts");
const routerBody = /export const appRouter = \{([\s\S]*?)\n\};/.exec(routerSource);
if (!routerBody) {
  fail(
    "packages/api/src/router.ts",
    "could not locate the `export const appRouter = {` literal",
    "keep the router a plain object literal so the docs can be checked against it",
  );
} else {
  const groups = [...routerBody[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
  const documented = markedList("docs/architecture.md", "router-groups");
  if (documented === null) {
    fail(
      "docs/architecture.md",
      "has no <!-- docs:check=router-groups --> marker",
      "mark the router-group list so it can be checked against packages/api/src/router.ts",
    );
  } else {
    const sorted = [...documented].sort();
    if (sorted.join(",") !== groups.join(",")) {
      fail(
        "docs/architecture.md",
        `documented router groups [${sorted.join(", ")}] differ from packages/api/src/router.ts [${groups.join(", ")}]`,
        "update the marked list to match the router",
      );
    }
  }
}

// --------------------------------------------------------------------------
// 9. Documented VITE_* build args match the Dockerfile
// --------------------------------------------------------------------------

const dockerfile = read("apps/server/Dockerfile");
const dockerArgs = [...dockerfile.matchAll(/^ARG\s+(VITE_\w+)/gm)].map((m) => m[1]).sort();
const documentedArgs = markedList("docs/operations.md", "vite-build-args");
if (documentedArgs === null) {
  fail(
    "docs/operations.md",
    "has no <!-- docs:check=vite-build-args --> marker",
    "mark the Docker build-argument list so it can be checked against apps/server/Dockerfile",
  );
} else {
  const sorted = [...documentedArgs].sort();
  if (sorted.join(",") !== dockerArgs.join(",")) {
    fail(
      "docs/operations.md",
      `documented VITE_* build args [${sorted.join(", ")}] differ from apps/server/Dockerfile [${dockerArgs.join(", ")}]`,
      "update the marked list to match the Dockerfile's ARG lines",
    );
  }
}

// --------------------------------------------------------------------------
// 10. No document tells an agent to hand-edit a generated file
// --------------------------------------------------------------------------

const EDIT_VERB = /\b(edit|modify|change|update|write to|regenerate by hand|hand-edit)\b/i;
const NEGATION = /\b(never|not|don't|do not|no|instead of|rather than|without)\b/i;

for (const doc of markdownFiles) {
  const lines = read(doc).split("\n");
  lines.forEach((line, index) => {
    for (const generated of GENERATED_PATHS) {
      if (!line.includes(generated)) continue;
      if (!EDIT_VERB.test(line)) continue;
      const beforeVerb = line.slice(0, line.search(EDIT_VERB));
      if (NEGATION.test(line)) continue;
      if (NEGATION.test(beforeVerb)) continue;
      fail(
        `${doc}:${String(index + 1)}`,
        `appears to instruct editing the generated file ${generated}`,
        "document the generator command instead",
      );
    }
  });
}

// --------------------------------------------------------------------------
// 11. Self-tests for the anchor logic
// --------------------------------------------------------------------------
//
// The anchor rules are the one part of this checker with enough logic to be
// wrong in a way the repository's own documents would not reveal — they only
// prove the cases they happen to contain. These run on every invocation
// (they are pure and take microseconds), so a regression fails CI here rather
// than by quietly accepting a dead link.

function selfTestFailures() {
  const problems = [];
  const check = (name, actual, expected) => {
    if (actual !== expected) problems.push(`${name}: expected ${expected}, got ${actual}`);
  };

  const SAME_FILE = [
    "# Title",
    "## Generated files",
    "## HTTP route order and access gates",
    "```bash",
    "# not a heading — inside a fence",
    "```",
    "## Notes",
    "## Notes",
    "## Notes",
  ].join("\n");

  const OTHER_FILE = ["# Other", "## Router groups", "### Deep heading"].join("\n");

  const anchors = anchorsFromMarkdown(SAME_FILE);

  // Slugging: lowercase, spaces to hyphens, punctuation dropped.
  check("slug: spaces", anchors.has("generated-files"), true);
  check("slug: long heading", anchors.has("http-route-order-and-access-gates"), true);
  check("slug: punctuation dropped", slugify("Posts, replies, likes!"), "posts-replies-likes");
  check("slug: code span stripped", slugify(headingText("`docs:check` runs")), "docscheck-runs");

  // Fenced blocks are not headings. Asserted against the identical text
  // outside a fence, so this cannot pass merely because the slug is wrong.
  check("fence: bare heading counts", anchorsFromMarkdown("# Fenced").has("fenced"), true);
  check("fence: fenced heading ignored", anchorsFromMarkdown("```\n# Fenced\n```").size, 0);
  check("fence: tilde fence ignored", anchorsFromMarkdown("~~~\n# Fenced\n~~~").size, 0);

  // Duplicate headings take GitHub's -1/-2 suffixes.
  check("duplicate: first is bare", anchors.has("notes"), true);
  check("duplicate: second is -1", anchors.has("notes-1"), true);
  check("duplicate: third is -2", anchors.has("notes-2"), true);
  check("duplicate: no -3", anchors.has("notes-3"), false);

  const deps = {
    fileExists: (rel) => rel === "docs/other.md" || rel === "docs/diagram.svg",
    anchorsFor: (rel) =>
      rel === "docs/other.md" ? anchorsFromMarkdown(OTHER_FILE) : anchorsFromMarkdown(SAME_FILE),
  };
  const problemFor = (target) => linkProblem("docs/self.md", target, deps);

  // Same-file anchors.
  check("same-file valid", problemFor("#generated-files"), null);
  check("same-file invalid", problemFor("#no-such-heading") !== null, true);

  // Cross-file anchors.
  check("cross-file valid", problemFor("other.md#router-groups"), null);
  check("cross-file invalid", problemFor("other.md#nope") !== null, true);
  check("cross-file missing file", problemFor("missing.md#router-groups") !== null, true);

  // Percent-encoded fragments resolve to the same anchor.
  check("encoded fragment", problemFor("other.md#router%2Dgroups"), null);

  // Untouched behaviour: external links and non-Markdown targets.
  check("external http", problemFor("https://example.com#anything"), null);
  check("external mailto", problemFor("mailto:a@b.c"), null);
  // A fragment on a non-Markdown target is not ours to validate: the file
  // exists, and the anchor is opaque, so this must stay silent.
  check("non-markdown fragment ignored", problemFor("diagram.svg#layer1"), null);

  return problems;
}

for (const problem of selfTestFailures()) {
  fail(
    SELF,
    `self-test failed — ${problem}`,
    "the anchor rules regressed; fix them before trusting this run",
  );
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

if (failures.length === 0) {
  console.log(`docs:check — ${String(markdownFiles.length)} Markdown files, no problems found.`);
  process.exit(0);
}

console.error(`docs:check — ${String(failures.length)} problem(s):\n`);
for (const { file, message, fix } of failures) {
  console.error(`  ${file}`);
  console.error(`    ${message}`);
  console.error(`    fix: ${fix}\n`);
}
process.exit(1);
