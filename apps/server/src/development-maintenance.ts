import { z } from "zod";
const response = await fetch("http://localhost:3001/__dev/maintenance", {
  method: "POST",
  headers: { "x-mytuums-local-dev": "1" },
  signal: AbortSignal.timeout(15000),
});
if (response.status !== 202) throw new Error("Start pnpm dev before running local maintenance.");
const result = z.object({ id: z.string() }).parse(await response.json());
console.log(`Local maintenance Workflow started: ${result.id}`);
