import { fileURLToPath } from "node:url";
import { createDevelopmentPlatform } from "./development-platform.js";

const platform = await createDevelopmentPlatform(
  fileURLToPath(new URL("../.wrangler/development", import.meta.url)),
);
console.log(
  "Local app and jobs ready. Open http://localhost:5173; captured email: http://localhost:3001/__dev/emails",
);
let closing: Promise<void> | undefined;
function close() {
  closing ??= platform.dispose();
  return closing;
}
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
