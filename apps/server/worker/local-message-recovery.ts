import { createMessageRecoveryKeys } from "@my-tuums/api/cloudflare-app";

// PUBLIC SYNTHETIC KEY: local development and disposable E2E only. Never import from a hosted entrypoint.
export function localMessageRecoveryKeys() {
  return createMessageRecoveryKeys(
    '{"active":"local-test-only","keys":{"local-test-only":{"kty":"EC","crv":"P-256","x":"IDp31IAbVBTjBtJQW-HS89eQz62F7CLtdEHP8EOsW98","y":"okxT6mSRyYHCyUqDm2DXFu1IQ_t80DZfAeYwM9Fy2zE","d":"ql-Ex6BrCp1crchREntH-hTqYXmrzNBhb1jLXqbeEJM"}}}',
  );
}
