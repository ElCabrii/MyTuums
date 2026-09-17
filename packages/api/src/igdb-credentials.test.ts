import { describe, expect, it } from "vitest";
import { parseIgdbEnvCredentials } from "./igdb-credentials.js";

/**
 * The maintenance-`.env` boundary: the parser may hand out exactly the two
 * IGDB keys and nothing else. If it ever returns another variable — a
 * `DATABASE_URL`, a `NODE_ENV` — the caller has been handed the very
 * environment the maintenance rule exists to keep out.
 */
describe("parseIgdbEnvCredentials", () => {
  it("reads the two IGDB keys and no other variable from dotenv text", () => {
    const parsed = parseIgdbEnvCredentials(
      [
        "# local stack",
        "NODE_ENV=development",
        "DATABASE_URL=postgres://user:pass@localhost:5432/db",
        "IGDB_CLIENT_ID=client-id",
        "POSTGRES_PASSWORD=secret",
        "IGDB_CLIENT_SECRET=client-secret",
        "S",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({ clientId: "client-id", clientSecret: "client-secret" });
  });

  it("strips matching quotes and accepts export-prefixed lines", () => {
    const parsed = parseIgdbEnvCredentials(
      "IGDB_CLIENT_ID=\"quoted id\"\nexport IGDB_CLIENT_SECRET='single'",
    );
    expect(parsed).toEqual({ clientId: "quoted id", clientSecret: "single" });
  });

  it("keeps values that contain equals signs and carriage returns", () => {
    const parsed = parseIgdbEnvCredentials(
      "IGDB_CLIENT_ID=abc=def==\r\nIGDB_CLIENT_SECRET=padded==\r",
    );
    expect(parsed).toEqual({ clientId: "abc=def==", clientSecret: "padded==" });
  });

  it("returns an empty object when neither key is present", () => {
    expect(parseIgdbEnvCredentials("OTHER=value\n# comment\n")).toEqual({});
  });
});
