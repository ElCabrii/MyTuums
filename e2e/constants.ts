// Synthetic configuration shared by the test Worker and Playwright. Never read
// application credentials or production resource IDs from the shell here.
export const E2E_WEB_ORIGIN = "http://localhost:5273";
export const E2E_SERVER_ORIGIN = "http://localhost:3101";
export const E2E_AUTH_SECRET = "playwright-e2e-secret-at-least-32-characters";
export const E2E_ACCESS_ISSUER = "https://e2e-team.cloudflareaccess.com";
export const E2E_ACCESS_AUDIENCE = "e".repeat(64);
export const E2E_DATABASE_ID = "mytuums_e2e_test";
export const E2E_BUCKET_NAME = "mytuums-e2e_test";
