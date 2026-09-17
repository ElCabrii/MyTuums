/**
 * IGDB credentials for the Node maintenance CLIs (`pnpm games:add`) — the one
 * sanctioned `.env` read in maintenance tooling.
 *
 * The maintenance environment's rule is that operator commands never load
 * `.env`: the file carries `DATABASE_URL`, `POSTGRES_*` and provider secrets,
 * and a maintenance process must select its D1/R2 pair by environment name,
 * never by whatever that file happens to point at. The IGDB keys are the one
 * exception that cannot violate that rule's purpose — they name an external
 * API, not a database or bucket — so this module extracts exactly
 * `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` from dotenv-shaped text and
 * nothing else. The real environment always takes precedence (see
 * `scripts/add-game.ts`); a file that does not exist is simply absent.
 */

/** dotenv-shaped line: `KEY=value`, optional matching quotes around the value. */
function parseLine(line: string): { key: string; value: string } | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!match) return null;
  let value = match[2];
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

/**
 * Reads only the two IGDB keys from dotenv text. Every other line — comments,
 * blanks, and any other variable — is ignored by construction, so a caller
 * cannot accidentally import the rest of the file's environment.
 */
export function parseIgdbEnvCredentials(text: string): {
  clientId?: string;
  clientSecret?: string;
} {
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  for (const line of text.split("\n")) {
    if (clientId !== undefined && clientSecret !== undefined) break;
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.key === "IGDB_CLIENT_ID" && clientId === undefined) clientId = parsed.value;
    else if (parsed.key === "IGDB_CLIENT_SECRET" && clientSecret === undefined)
      clientSecret = parsed.value;
  }
  return clientId === undefined && clientSecret === undefined ? {} : { clientId, clientSecret };
}
