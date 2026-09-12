import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { preparePreviewImport, prepareProductionImport } from "./preview-import.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    streams: { type: "string" },
    output: { type: "string" },
    environment: { type: "string", default: "preview" },
  },
});
if (values.environment !== "preview" && values.environment !== "production")
  throw new Error("Unknown import environment.");
if (!values.source || !values.streams || !values.output)
  throw new Error(
    "Required: --source <private snapshot> --streams <verified mapping> --output <new private SQL file>.",
  );
try {
  const prepare =
    values.environment === "production" ? prepareProductionImport : preparePreviewImport;
  const prepared = prepare(
    await readFile(values.source, "utf8"),
    await readFile(values.streams, "utf8"),
    fileURLToPath(new URL("../drizzle-d1", import.meta.url)),
  );
  await writeFile(values.output, prepared.sql, { mode: 0o600, flag: "wx" });
  await writeFile(`${values.output}.report.json`, JSON.stringify(prepared.report, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      tables: prepared.report.tables.length,
      rows: prepared.report.totalRows,
      migrations: prepared.report.migrations.length,
    }),
  );
} catch (error) {
  // SQL/type validation errors may contain account data; only our content-free errors are safe.
  console.error("Migration preparation failed; no remote resource was changed.");
  if (
    error instanceof Error &&
    /^(Missing source table|Unknown source table|Unmapped source column|Reconciliation failed|Published video needs|Drain |Unsupported cross-table|Post parent)/.test(
      error.message,
    )
  )
    console.error(error.message);
  process.exitCode = 1;
}
