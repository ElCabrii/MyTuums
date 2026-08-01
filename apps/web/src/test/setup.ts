import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `globals: false` in vitest.config.ts means Testing Library's own auto
// cleanup (which hooks the global `afterEach`) never registers, so unmounting
// between tests has to be wired up explicitly. Without it, every render stays
// in the document and queries like `getByRole` start failing with "found
// multiple elements".
afterEach(() => {
  cleanup();
});
