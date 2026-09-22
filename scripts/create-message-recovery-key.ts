import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const [destination, keyId] = process.argv.slice(2);
if (!destination || !keyId || !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) {
  throw new Error(
    "Usage: pnpm messages:recovery-key /absolute/path/outside/repository.json key-id",
  );
}
const repository = resolve(import.meta.dirname, "..");
const output = join(await realpath(dirname(resolve(destination))), basename(destination));
if (!isAbsolute(destination) || !relative(repository, output).startsWith(`..${sep}`)) {
  throw new Error("Store recovery secrets outside the repository.");
}
const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
  "deriveBits",
]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
await writeFile(
  output,
  JSON.stringify({ active: keyId, keys: { [keyId]: { kty, crv, x, y, d } } }),
  {
    flag: "wx",
    mode: 0o600,
  },
);
console.log(
  `Created recovery keyring at ${output}. Store it in the environment's secret manager; keep a secure backup.`,
);
