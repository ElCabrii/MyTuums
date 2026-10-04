import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const [destination] = process.argv.slice(2);
if (!destination) throw new Error("Usage: pnpm push:keys /absolute/path/outside/repository.json");
const repository = resolve(import.meta.dirname, "..");
const output = join(await realpath(dirname(resolve(destination))), basename(destination));
if (!isAbsolute(destination) || !relative(repository, output).startsWith(`..${sep}`)) {
  throw new Error("Store push signing secrets outside the repository.");
}
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
  "base64url",
);
await writeFile(output, JSON.stringify({ publicKey, privateJwk }), { flag: "wx", mode: 0o600 });
console.log(
  `Created push signing keys at ${output}. Store them in the environment's secret manager and keep a secure backup.`,
);
