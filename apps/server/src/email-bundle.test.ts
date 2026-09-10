import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "tsup";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("renders auth emails in the production ESM bundle without dynamic require errors", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "mytuums-email-bundle-"));
  try {
    // Source-level rendering tests cannot detect CommonJS dependencies broken
    // by the server's ESM bundling. Execute the artifact with plain Node.
    await build({
      config: fileURLToPath(new URL("../tsup.config.ts", import.meta.url)),
      entry: {
        email: fileURLToPath(new URL("../../../packages/auth/src/email.ts", import.meta.url)),
      },
      outDir,
      outExtension: () => ({ js: ".mjs" }),
      silent: true,
    });

    const moduleUrl = pathToFileURL(path.join(outDir, "email.mjs")).href;
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { passwordResetEmail, verificationEmail, otpEmail } from ${JSON.stringify(moduleUrl)};
      const link = "https://example.com/verify?token=test-only";
      const messages = await Promise.all([
        passwordResetEmail(link, "en"),
        verificationEmail(link, "en"),
        otpEmail("000000", "en"),
      ]);
      console.log(JSON.stringify(messages.map(({ html, text }) => ({
        html: html.includes("<html"),
        text: text.length > 0,
      }))));
    `,
      ],
      { env: { NODE_ENV: "production" } },
    );

    expect(JSON.parse(stdout)).toEqual([
      { html: true, text: true },
      { html: true, text: true },
      { html: true, text: true },
    ]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 30_000);
