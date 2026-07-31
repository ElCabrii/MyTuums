import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouter } from "@my-tuums/api";

// In dev, Vite proxies /rpc -> http://localhost:3001/rpc
// In prod, configure this to your deployed server URL
const link = new RPCLink({
  url: "/rpc",
});

export const client = createORPCClient<AppRouter>(link);

export const orpc = createTanstackQueryUtils(client);
