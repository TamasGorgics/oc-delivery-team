import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "../..");

function readPackageJson(): Record<string, any> {
  return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<string, any>;
}

describe("package metadata and tarball", () => {
  test("declares the plugin entry, CLI binary, and published file allowlist", () => {
    const packageJson = readPackageJson();
    expect(packageJson.name).toBe("opencode-delivery-team");
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.exports?.["."]?.import).toBe("./src/index.ts");
    expect(packageJson.exports?.["."]?.types).toBe("./src/index.ts");
    expect(packageJson.bin?.team).toBe("./src/cli/team.ts");
    expect(packageJson.files).toEqual(expect.arrayContaining(["src", "evals", "docs", "CHANGELOG.md"]));
  });

  test("npm pack excludes tests, local state, and development-only files", () => {
    const result = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: packageRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ERR!");
    const packed = JSON.parse(result.stdout) as Array<{ readonly files: Array<{ readonly path: string }> }>;
    const files = packed[0]?.files.map((entry) => entry.path) ?? [];
    expect(files).toEqual(expect.arrayContaining([
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "src/index.ts",
      "src/cli/team.ts",
      "src/evals/runner.ts",
      "evals/tasks/ts-slug/task.md",
      "docs/architecture.md",
      "docs/release.md",
      "docs/api-notes.md",
    ]));
    for (const excluded of ["test", ".opencode", ".team", "node_modules", "SPEC.md", "ROADMAP.md", "bun.lock"]) {
      expect(files.some((file) => file === excluded || file.startsWith(`${excluded}/`))).toBe(false);
    }
  });
});
