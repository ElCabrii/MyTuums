import { getIp } from "better-auth/api";

/** Written only by the HTTP boundary after verifying the deployment's proxy. */
export const CLIENT_IP_HEADER = "x-mytuums-client-ip";

export const clientIpOptions = { ipAddressHeaders: [CLIENT_IP_HEADER] };

/** Share Better Auth's IPv4/IPv6 normalization and IPv6 /64 budgets with RPC. */
export function getClientIp(headers: Headers): string | null {
  return getIp(headers, { advanced: { ipAddress: clientIpOptions } });
}
