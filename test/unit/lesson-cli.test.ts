import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTeamCli } from "../../src/cli/team";
import { openDatabase } from "../../src/state/db";
import { LessonsRepository, type LessonRole } from "../../src/state/lessons";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-lesson-cli-"));
  directories.push(directory);
  return directory;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  json(): any;
}

async function cli(cwd: string, argv: readonly string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runTeamCli(argv, {
    cwd,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout || stderr) };
}

interface Seed {
  readonly ids: {
    readonly proposedDev: number;
    readonly approvedDev: number;
    readonly wildcardStale: number;
    readonly qaLowHit: number;
    readonly rejectedDocs: number;
    readonly proposedRetire: number;
  };
  readonly texts: {
    readonly proposedDev: string;
    readonly approvedDev: string;
    readonly wildcardStale: string;
    readonly qaLowHit: string;
    readonly rejectedDocs: string;
    readonly proposedRetire: string;
  };
}

async function seed(rootDir: string): Promise<Seed> {
  const texts = {
    proposedDev: "Run the documented migration checks before merging the schema change.",
    approvedDev: "Use the Stack Profile test command before marking the task complete.",
    wildcardStale: "Keep the release notes current for every shipped change.",
    qaLowHit: "Verify the release candidate with the documented acceptance checklist.",
    rejectedDocs: "Update the changelog after every documentation review.",
    proposedRetire: "Record the verification evidence beside each completed change.",
  };
  const { db } = await openDatabase(path.join(rootDir, "team.db"));
  try {
    const now = "2026-01-01T00:00:00.000Z";
    const lessons = new LessonsRepository(db, () => now);
    const add = (
      role: LessonRole,
      text: string,
      status: "proposed" | "approved" | "rejected",
      evidence?: string,
      hitCount = 0,
    ): number => {
      const id = lessons.insert({
        role,
        text,
        stackTag: "*",
        ...(evidence === undefined ? {} : { evidence }),
      });
      if (status !== "proposed") lessons.setStatus(id, status, now);
      if (hitCount > 0) db.run("UPDATE lessons SET hit_count = ? WHERE id = ?", [hitCount, id]);
      return id;
    };

    return {
      ids: {
        proposedDev: add("developer", texts.proposedDev, "proposed"),
        approvedDev: add("developer", texts.approvedDev, "approved", "implement-report.md"),
        wildcardStale: add("*", texts.wildcardStale, "approved", undefined, 5),
        qaLowHit: add("qa", texts.qaLowHit, "approved", undefined, 1),
        rejectedDocs: add("docs", texts.rejectedDocs, "rejected"),
        proposedRetire: add("tester", texts.proposedRetire, "proposed"),
      },
      texts,
    };
  } finally {
    db.close();
  }
}

describe("team lessons CLI", () => {
  test("lists lessons and filters by status", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const seedData = await seed(rootDir);

    const all = await cli(projectDir, ["lessons", "--root", rootDir]);
    expect(all.code).toBe(0);
    expect(all.json()).toMatchObject({ ok: true, status: null, count: 6 });
    expect(all.json().lessons.map((lesson: any) => lesson.id)).toEqual([
      seedData.ids.proposedDev,
      seedData.ids.approvedDev,
      seedData.ids.wildcardStale,
      seedData.ids.qaLowHit,
      seedData.ids.rejectedDocs,
      seedData.ids.proposedRetire,
    ]);

    const proposed = await cli(projectDir, ["lessons", "--status", "proposed", "--root", rootDir]);
    expect(proposed.code).toBe(0);
    expect(proposed.json()).toMatchObject({ ok: true, status: "proposed", count: 2 });
    expect(proposed.json().lessons.map((lesson: any) => lesson.id)).toEqual([
      seedData.ids.proposedDev,
      seedData.ids.proposedRetire,
    ]);

    const explicit = await cli(projectDir, ["lessons", "list", "--status=approved", "--root", rootDir]);
    expect(explicit.code).toBe(0);
    expect(explicit.json()).toMatchObject({ status: "approved", count: 3 });

    const invalid = await cli(projectDir, ["lessons", "--status", "unknown", "--root", rootDir]);
    expect(invalid.code).toBe(2);
    expect(invalid.json()).toMatchObject({ ok: false, code: "usage" });
    expect(invalid.json().error).toContain("--status must be one of");

    expect((await cli(projectDir, ["lessons", "list", "extra", "--root", rootDir])).code).toBe(2);
    expect((await cli(projectDir, ["lessons", "nope", "--root", rootDir])).code).toBe(2);

    const help = await cli(projectDir, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("team lessons [--status <status>]");
    expect(help.stdout).toContain("team lessons export");
    expect(help.stdout).toContain("team lessons stale");
  });

  test("approves, rejects, retires, and reports idempotent decisions", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const seedData = await seed(rootDir);

    const approved = await cli(projectDir, [
      "lessons", "approve", String(seedData.ids.proposedDev), "--root", rootDir,
    ]);
    expect(approved.code).toBe(0);
    expect(approved.json()).toMatchObject({
      ok: true,
      action: "approve",
      previous_status: "proposed",
      changed: true,
      lesson: { id: seedData.ids.proposedDev, status: "approved" },
    });
    expect(approved.json().lesson.decided_at).toEqual(expect.any(String));

    const again = await cli(projectDir, [
      "lessons", "approve", String(seedData.ids.proposedDev), "--root", rootDir,
    ]);
    expect(again.code).toBe(0);
    expect(again.json()).toMatchObject({
      ok: true,
      action: "approve",
      previous_status: "approved",
      changed: false,
      lesson: {
        id: seedData.ids.proposedDev,
        status: "approved",
        decided_at: approved.json().lesson.decided_at,
      },
    });

    const retired = await cli(projectDir, [
      "lessons", "retire", String(seedData.ids.proposedDev), "--root", rootDir,
    ]);
    expect(retired.code).toBe(0);
    expect(retired.json()).toMatchObject({
      action: "retire",
      previous_status: "approved",
      changed: true,
      lesson: { status: "retired" },
    });

    const rejected = await cli(projectDir, [
      "lessons", "reject", String(seedData.ids.approvedDev), "--root", rootDir,
    ]);
    expect(rejected.code).toBe(0);
    expect(rejected.json()).toMatchObject({
      action: "reject",
      previous_status: "approved",
      changed: true,
      lesson: { status: "rejected" },
    });

    const invalidRetire = await cli(projectDir, [
      "lessons", "retire", String(seedData.ids.proposedRetire), "--root", rootDir,
    ]);
    expect(invalidRetire.code).toBe(1);
    expect(invalidRetire.json()).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(invalidRetire.json().error).toContain("Only approved lessons can be retired");

    const missing = await cli(projectDir, ["lessons", "approve", "999", "--root", rootDir]);
    expect(missing.code).toBe(1);
    expect(missing.json()).toMatchObject({ ok: false, code: "lesson_not_found" });

    expect((await cli(projectDir, ["lessons", "approve", "abc", "--root", rootDir])).code).toBe(2);
    expect((await cli(projectDir, ["lessons", "approve", "--root", rootDir])).code).toBe(2);
    expect((await cli(projectDir, [
      "lessons", "approve", String(seedData.ids.proposedRetire), "--status", "approved", "--root", rootDir,
    ])).code).toBe(2);
  });

  test("exports approved lessons by role and prunes obsolete role files", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const seedData = await seed(rootDir);
    const exportDir = path.join(rootDir, "lessons-export");

    const exported = await cli(projectDir, ["lessons", "export", "--root", rootDir]);
    expect(exported.code).toBe(0);
    expect(exported.json()).toMatchObject({
      ok: true,
      directory: exportDir,
      count: 3,
      roles: ["*", "developer", "qa"],
      removed: [],
    });
    expect(exported.json().files).toHaveLength(3);

    const all = readFileSync(path.join(exportDir, "all.md"), "utf8");
    expect(all).toContain("# Approved lessons: all roles");
    expect(all).toContain(seedData.texts.wildcardStale);
    expect(all).not.toContain(seedData.texts.proposedDev);
    expect(all).not.toContain(seedData.texts.rejectedDocs);

    const developer = readFileSync(path.join(exportDir, "developer.md"), "utf8");
    expect(developer).toContain("# Approved lessons: developer");
    expect(developer).toContain(seedData.texts.approvedDev);
    expect(developer).not.toContain(seedData.texts.qaLowHit);
    expect(developer).not.toContain(seedData.texts.wildcardStale);
    expect(developer).not.toContain(seedData.texts.proposedDev);
    expect(developer).not.toContain(seedData.texts.rejectedDocs);

    const qa = readFileSync(path.join(exportDir, "qa.md"), "utf8");
    expect(qa).toContain(seedData.texts.qaLowHit);

    const retireDev = await cli(projectDir, [
      "lessons", "retire", String(seedData.ids.approvedDev), "--root", rootDir,
    ]);
    expect(retireDev.code).toBe(0);
    const rejectQa = await cli(projectDir, [
      "lessons", "reject", String(seedData.ids.qaLowHit), "--root", rootDir,
    ]);
    expect(rejectQa.code).toBe(0);

    const pruned = await cli(projectDir, ["lessons", "export", "--root", rootDir]);
    expect(pruned.code).toBe(0);
    expect(pruned.json()).toMatchObject({
      count: 1,
      roles: ["*"],
      removed: ["developer.md", "qa.md"],
    });
    expect(existsSync(path.join(exportDir, "developer.md"))).toBe(false);
    expect(existsSync(path.join(exportDir, "qa.md"))).toBe(false);
    expect(existsSync(path.join(exportDir, "all.md"))).toBe(true);

    const retireAll = await cli(projectDir, [
      "lessons", "retire", String(seedData.ids.wildcardStale), "--root", rootDir,
    ]);
    expect(retireAll.code).toBe(0);
    const empty = await cli(projectDir, ["lessons", "export", "--root", rootDir]);
    expect(empty.code).toBe(0);
    expect(empty.json()).toMatchObject({ count: 0, roles: [], files: [], removed: ["all.md"] });
    expect(readdirSync(exportDir)).toEqual([]);

    expect((await cli(projectDir, ["lessons", "export", "extra", "--root", rootDir])).code).toBe(2);
    expect((await cli(projectDir, ["lessons", "export", "--status", "approved", "--root", rootDir])).code)
      .toBe(2);
  });

  test("reports high-hit approved lessons without evidence and never mutates them", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const seedData = await seed(rootDir);

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const lessons = new LessonsRepository(db);
      const whitespaceEvidence = lessons.insert({
        role: "*",
        text: "Use a reviewed checklist before closing the delivery run.",
        evidence: "   ",
        stackTag: "typescript",
      });
      lessons.setStatus(whitespaceEvidence, "approved", "2025-12-01T00:00:00.000Z");
      db.run("UPDATE lessons SET hit_count = 6 WHERE id = ?", [whitespaceEvidence]);
      db.run("UPDATE lessons SET hit_count = 9 WHERE id = ?", [seedData.ids.approvedDev]);
      db.run("UPDATE lessons SET hit_count = 20 WHERE id = ?", [seedData.ids.proposedDev]);
      db.run("UPDATE lessons SET hit_count = 20 WHERE id = ?", [seedData.ids.rejectedDocs]);
    } finally {
      db.close();
    }

    const stale = await cli(projectDir, ["lessons", "stale", "--root", rootDir]);
    expect(stale.code).toBe(0);
    expect(stale.json()).toMatchObject({
      ok: true,
      report_only: true,
      criteria: {
        status: "approved",
        min_hit_count: 5,
        evidence: "missing",
      },
      count: 2,
    });
    expect(stale.json().lessons.map((lesson: any) => lesson.id)).toEqual([
      7,
      seedData.ids.wildcardStale,
    ]);
    expect(stale.json().lessons[0]).toMatchObject({
      reason: "high_hits_without_evidence",
      hit_count: 6,
      status: "approved",
      age_days: expect.any(Number),
    });

    const after = await cli(projectDir, ["lessons", "--root", rootDir]);
    expect(after.json().lessons.map((lesson: any) => lesson.status)).toEqual([
      "proposed",
      "approved",
      "approved",
      "approved",
      "rejected",
      "proposed",
      "approved",
    ]);

    const extra = await cli(projectDir, ["lessons", "stale", "extra", "--root", rootDir]);
    expect(extra.code).toBe(2);
  });
});
