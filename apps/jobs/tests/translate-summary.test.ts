import { expect, it } from "vitest";
import { translateGameSummary } from "../src/translate-summary.js";

it("preserves every sentence when the model drops sentences or truncates oversized requests", async () => {
  const paragraph = "Explore a world of shadows and steal hidden treasures. ".repeat(10).trim();
  const source = `${paragraph}\n\n${"a".repeat(350)}. The final sentence must survive.`;
  const result = await translateGameSummary(source, (chunk) =>
    Promise.resolve((chunk.slice(0, 300).split(/(?<=[.!?])\s/)[0] ?? "").toUpperCase()),
  );
  expect(result.replaceAll(/\s/g, "")).toBe(source.toUpperCase().replaceAll(/\s/g, ""));
  expect(result.split("\n\n")).toHaveLength(2);
  expect(result.endsWith("THE FINAL SENTENCE MUST SURVIVE.")).toBe(true);
});

it("rejects the entire description when any chunk is empty or fails", async () => {
  const source = `${"Explore the world. ".repeat(20)}The final sentence.`;
  for (const failure of ["", "   ", new Error("Provider unavailable")]) {
    await expect(
      translateGameSummary(source, (chunk) => {
        if (!chunk.includes("final sentence")) return Promise.resolve("Explorez le monde.");
        return failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure);
      }),
    ).rejects.toThrow();
  }
});
