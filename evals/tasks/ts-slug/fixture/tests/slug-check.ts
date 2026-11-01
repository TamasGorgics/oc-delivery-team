import { expect, test } from "bun:test";

test("slugifies a title", async () => {
  const implementationPath = new URL("../src/slug", import.meta.url).href;
  const implementation = await import(implementationPath) as {
    readonly slugifyTitle: (value: string) => string;
  };
  expect(implementation.slugifyTitle("  Add Search & Filtering! ")).toBe("add-search-filtering");
});
