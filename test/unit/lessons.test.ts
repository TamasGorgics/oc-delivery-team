import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import deliveryTeam from "../../src/index";
import { openDatabase } from "../../src/state/db";
import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  LessonsRepository,
  MAX_LESSONS_PER_RUN,
  lessonSimilarity,
  normalizeLessonStack,
  validateLessonText,
} from "../../src/state/lessons";
import { createFakeContext, type FakeContextHarness } from "../fakes/ctx";

interface Harness {
  readonly fake: FakeContextHarness;
  readonly projectDir: string;
  readonly rootDir: string;
}

type ToolOutput = Record<string, any>;

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Best-effort cleanup for deliberately broken fixtures.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-lessons-"));
  directories.push(directory);
  return directory;
}

async function setup(): Promise<Harness> {
  const projectDir = tempProject();
  const fake = createFakeContext({ projectDirectory: projectDir });
  const cleanup = await deliveryTeam.setup(fake.context);
  if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
  cleanups.push(cleanup);
  return { fake, projectDir, rootDir: path.join(projectDir, ".team") };
}

function output(result: { output?: unknown }): ToolOutput {
  return (result.output ?? {}) as ToolOutput;
}

async function call(
  harness: Harness,
  name: string,
  input: unknown = {},
  context: { sessionID?: string; agent?: string; id?: string } = {},
): Promise<ToolOutput> {
  return output(await harness.fake.invokeTool(name, input, context));
}

async function withLessons<T>(
  harness: Harness,
  fn: (lessons: LessonsRepository) => T,
): Promise<T> {
  const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
  try {
    return fn(new LessonsRepository(db));
  } finally {
    db.close();
  }
}

describe("lesson validation", () => {
  test("accepts short imperative sentences and normalizes whitespace", () => {
    expect(validateLessonText("  Use   the Stack Profile commands before running tests.  ")).toEqual({
      ok: true,
      text: "Use the Stack Profile commands before running tests.",
    });
    expect(validateLessonText("Do not run commands without checking the exit code."))
      .toMatchObject({ ok: true });
    expect(validateLessonText("Don't skip the gate check before advancing the phase."))
      .toMatchObject({ ok: true });
    expect(validateLessonText("Don’t skip the gate check before advancing the phase."))
      .toMatchObject({ ok: true });
  });

  test("rejects short, long, multi-line, declarative, and question text", () => {
    expect(validateLessonText("Use the profile.")).toMatchObject({ ok: false });
    expect(validateLessonText(`Use ${"x".repeat(300)}`)).toMatchObject({ ok: false });
    expect(validateLessonText("Use the profile.\nRun the tests.")).toMatchObject({ ok: false });
    expect(validateLessonText("The team should use the Stack Profile before running tests.")).toMatchObject({
      ok: false,
      message: expect.stringContaining("imperative verb"),
    });
    expect(validateLessonText("Should the team use the Stack Profile before running tests?")).toMatchObject({
      ok: false,
    });
  });

  test("normalizes stack tags and rejects malformed tags", () => {
    expect(normalizeLessonStack(undefined)).toBe("*");
    expect(normalizeLessonStack(" TypeScript ")).toBe("typescript");
    expect(normalizeLessonStack("c++")).toBe("c++");
    expect(normalizeLessonStack("not a tag!")).toBeUndefined();
    expect(normalizeLessonStack("-leading")).toBeUndefined();
  });

  test("scores near-identical lessons above the duplicate threshold", () => {
    const score = lessonSimilarity(
      "Use the Stack Profile commands before running tests.",
      "Use Stack Profile commands before running the tests.",
    );
    expect(score).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY_THRESHOLD);
    expect(lessonSimilarity(
      "Use the Stack Profile commands before running tests.",
      "Record a decision note after the human approves the specification.",
    )).toBeLessThan(DUPLICATE_SIMILARITY_THRESHOLD);
  });
});

describe("lesson repository", () => {
  test("inserts, lists, counts per run, updates status, and detects duplicates through FTS", async () => {
    const harness = await setup();
    const started = await call(harness, "team_start", { title: "Lesson repository" });
    const runId = started.run as string;
    const text = "Use the Stack Profile commands before running tests.";

    const repository = await withLessons(harness, (lessons) => {
      const id = lessons.insert({ role: "*", text, sourceRun: runId, stackTag: "typescript" });
      return { id, duplicate: lessons.findDuplicate("*", text)?.id, count: lessons.countForRun(runId) };
    });

    expect(repository).toEqual({ id: 1, duplicate: 1, count: 1 });
    const updated = await withLessons(harness, (lessons) => lessons.setStatus(1, "approved"));
    expect(updated).toMatchObject({ id: 1, status: "approved", decided_at: expect.any(String) });
    expect(await withLessons(harness, (lessons) => lessons.list({ status: "proposed" }))).toEqual([]);
    expect(await withLessons(harness, (lessons) => lessons.list({ status: "approved", role: "*" })))
      .toMatchObject([{ id: 1, stack_tag: "typescript" }]);
  });

  test("ignores rejected lessons when detecting duplicates", async () => {
    const harness = await setup();
    const text = "Record evidence paths for every recurring delivery failure.";

    const result = await withLessons(harness, (lessons) => {
      const id = lessons.insert({ role: "*", text, stackTag: "*" });
      lessons.setStatus(id, "rejected");
      return { id, duplicate: lessons.findDuplicate("*", text) };
    });

    expect(result).toEqual({ id: 1, duplicate: undefined });
  });
});

describe("team_lesson_propose", () => {
  test("stores a proposal with run, role, stack, and trace identity", async () => {
    const harness = await setup();
    const started = await call(harness, "team_start", { title: "Proposal run" });
    const runId = started.run as string;

    const result = await call(harness, "team_lesson_propose", {
      role: "developer",
      text: "Use the Stack Profile commands before running tests.",
      evidence: "test-report.md",
      stack: "TypeScript",
    }, { sessionID: "session-1", agent: "retro", id: "call-propose" });

    expect(result).toMatchObject({
      ok: true,
      run: runId,
      lesson_id: 1,
      role: "developer",
      stack_tag: "typescript",
      status: "proposed",
    });

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      const lessons = new LessonsRepository(db);
      expect(lessons.get(1)).toMatchObject({
        role: "developer",
        text: "Use the Stack Profile commands before running tests.",
        evidence: "test-report.md",
        source_run: runId,
        stack_tag: "typescript",
        status: "proposed",
        hit_count: 0,
      });
      const event = db.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE kind = 'lesson.proposed'",
      );
      expect(JSON.parse(event?.data_json ?? "{}")).toMatchObject({
        lesson_id: 1,
        role: "developer",
        stack_tag: "typescript",
        proposal_count: 1,
      });
    } finally {
      db.close();
    }
  });

  test("returns the existing id for a near-duplicate instead of inserting it", async () => {
    const harness = await setup();
    await call(harness, "team_start", { title: "Duplicate run" });
    const first = await call(harness, "team_lesson_propose", {
      role: "*",
      text: "Use the Stack Profile commands before running tests.",
    });
    expect(first).toMatchObject({ ok: true, stack_tag: "*", status: "proposed" });

    const duplicate = await call(harness, "team_lesson_propose", {
      role: "*",
      text: "Use Stack Profile commands before running the tests.",
    });
    expect(duplicate).toMatchObject({
      ok: false,
      code: "duplicate_lesson",
      existing_id: first.lesson_id,
      existing_status: "proposed",
    });
    expect(await withLessons(harness, (lessons) => lessons.list())).toHaveLength(1);
  });

  test("enforces the per-run proposal cap", async () => {
    const harness = await setup();
    const started = await call(harness, "team_start", { title: "Cap run" });
    const runId = started.run as string;

    await withLessons(harness, (lessons) => {
      for (let index = 0; index < MAX_LESSONS_PER_RUN; index += 1) {
        lessons.insert({
          role: "*",
          text: `Use unique lesson ${index} to keep the process predictable.`,
          sourceRun: runId,
          stackTag: "*",
        });
      }
    });

    const capped = await call(harness, "team_lesson_propose", {
      role: "developer",
      text: "Record evidence paths for every recurring delivery failure.",
    });
    expect(capped).toMatchObject({
      ok: false,
      code: "proposal_cap_reached",
      run: runId,
      cap: MAX_LESSONS_PER_RUN,
    });
    expect(await withLessons(harness, (lessons) => lessons.countForRun(runId))).toBe(MAX_LESSONS_PER_RUN);
  });

  test("rejects invalid roles, text, and stack tags without writing rows", async () => {
    const harness = await setup();
    await call(harness, "team_start", { title: "Invalid proposals" });

    expect(await call(harness, "team_lesson_propose", {
      role: "hacker",
      text: "Use the Stack Profile commands before running tests.",
    })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await call(harness, "team_lesson_propose", {
      role: "*",
      text: "Too short.",
    })).toMatchObject({ ok: false, code: "invalid_lesson" });
    expect(await call(harness, "team_lesson_propose", {
      role: "*",
      text: "Use the Stack Profile commands before running tests.",
      stack: "not a tag!",
    })).toMatchObject({ ok: false, code: "invalid_input" });

    expect(await withLessons(harness, (lessons) => lessons.list())).toEqual([]);
  });

  test("stays unavailable for approval; the tool list only exposes propose", async () => {
    const harness = await setup();
    const names = [...harness.fake.state.tools.keys()];
    expect(names).toContain("team_lesson_propose");
    expect(names.filter((name) => /approve|reject|retire/.test(name))).toEqual([]);
  });
});
