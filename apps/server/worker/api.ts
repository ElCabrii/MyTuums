import { CORSPlugin, SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { appRouter, createContext, type ApiServices } from "@my-tuums/api/cloudflare-app";
import type { Auth } from "@my-tuums/auth";

/** Bind the real RPC router once per isolate, after HTTP admission has bounded its request. */
export function createWorkerApi(auth: Auth, services: ApiServices) {
  const handler = new RPCHandler(appRouter, {
    plugins: [
      new CORSPlugin({
        origin: [services.webOrigin],
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-CSRF-Token"],
      }),
      new SimpleCsrfProtectionHandlerPlugin(),
    ],
  });
  return async (request: Request, requestId: string): Promise<Response | null> => {
    const context = await createContext({ ...services, auth, headers: request.headers, requestId });
    const result = await handler.handle(request, { prefix: "/rpc", context });
    return result.response ?? null;
  };
}
