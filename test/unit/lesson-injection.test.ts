import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../src/config";
import deliveryTeam from "../../src/index";
import {
  createLessonInjectionHandler,
  injectApprovedLessons,
  LESSON_SECTION_HEADER,
  type LessonInjectionEvent,
} from "../../src/hooks/lessons";
import { openDatabase, type TeamDatabase } from "../../src/state/db";
import { LessonsRepository, type LessonRole } from "../../src/state/lessons";
import { runArtifactPath } from "../../src/state/paths";
import { RunRepository } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";
import type { ToolRuntime } from "../../src/tools/runtime";
import { createFakeContext, type FakeContextHarness } from "../fakes/ctx";

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

interface Harness {
  readonly fake: FakeContextHarness;
  readonly projectDir: string;
  readonly rootDir: string;
}

type ToolOutput = Record<string, any>;

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-injection-"));
  directories.push(directory);
  return directory;
}

async function setup(options?: unknown): Promise<Harness> {
  const projectDir = tempProject();
  const fake = createFakeContext({ projectDirectory: projectDir, ...(options === undefined ? {} : { options }) });
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

async function withRepo<T>(
  harness: Harness,
  fn: (lessons: LessonsRepository, db: TeamDatabase) => T,
): Promise<T> {
  const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
  try {
    return fn(new LessonsRepository(db), db);
  } finally {
    db.close();
  }
}

async function latestEvent(
  harness: Harness,
  kind: string,
): Promise<Record<string, any> | undefined> {
  return withRepo(harness, (_lessons, db) => {
    const row = db.get<{ data_json: string }>(
      "SELECT data_json FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
      [kind],
    );
    return row ? JSON.parse(row.data_json) as Record<string, any> : undefined;
  });
}

function insertLesson(
  lessons: LessonsRepository,
  role: LessonRole,
  text: string,
  stackTag: string,
  status: "approved" | "proposed" | "retired" | "rejected" = "approved",
): number {
  const id = lessons.insert({ role, text, stackTag });
  if (status !== "proposed") lessons.setStatus(id, status);
  return id;
}

/** Remove insertion-time jitter so fallback ordering is deterministic in tests. */
function pinCreatedAt(db: TeamDatabase, ids: readonly number[]): void {
  if (ids.length === 0) return;
  db.run(
    `UPDATE lessons SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
}

function sectionText(event: { system: unknown }): string {
  const system = event.system;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) throw new Error("Expected an array system value.");
  return system.map((part) => {
    if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
      return (part as { text: string }).text;
    }
    return "";
  }).join("");
}

describe("request-hook lesson injection", () => {
  test("injects only approved, role- and stack-scoped lessons, records hits, and traces IDs", async () => {
    const harness = await setup();
    const started = await call(harness, "team_start", { title: "Preparation review" });
    const runId = started.run as string;
    writeFileSync(
      runArtifactPath(harness.rootDir, runId, "spec.md"),
      [
        "# Migration plan",
        "Run the sqlite migration verification before merging.",
        "<!-- team-footer -->",
        "STATUS: APPROVED",
        "<!-- /team-footer -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const matchedText = "Run the sqlite migration verification before committing the database change.";
    const wildcardText = "Keep the handoff notes concise for every shipped change.";
    const qaText = "Verify the sqlite migration with the documented acceptance checklist.";
    const pythonText = "Run pytest for the Python package before packaging the wheel.";
    const ids = await withRepo(harness, (lessons) => ({
      matched: insertLesson(lessons, "developer", matchedText, "*"),
      wildcard: insertLesson(lessons, "*", wildcardText, "*"),
      qa: insertLesson(lessons, "qa", qaText, "*"),
      python: insertLesson(lessons, "developer", pythonText, "python"),
    }));

    const proposedText = "Run the sqlite migration verification after the schema changes are drafted.";
    const proposed = await call(
      harness,
      "team_lesson_propose",
      { role: "developer", text: proposedText },
      { sessionID: "session-1", agent: "retro" },
    );
    expect(proposed).toMatchObject({ ok: true, status: "proposed" });
    const proposedId = proposed.lesson_id as number;

    const event = await harness.fake.invokeContextHook("developer", {}, {
      sessionID: "session-1",
      system: [{ type: "text", text: "Base system." }],
    });
    const text = sectionText(event);

    expect(event.system).toHaveLength(2);
    expect(text).toContain(LESSON_SECTION_HEADER);
    expect(text).toContain(`- [developer] ${matchedText}`);
    expect(text).toContain(`- [*] ${wildcardText}`);
    expect(text.indexOf(matchedText)).toBeLessThan(text.indexOf(wildcardText));
    expect(text).not.toContain(qaText);
    expect(text).not.toContain(pythonText);
    expect(text).not.toContain(proposedText);

    const rows = await withRepo(harness, (lessons) => lessons.list());
    const hits = new Map(rows.map((row) => [row.id, row.hit_count]));
    expect(hits.get(ids.matched)).toBe(1);
    expect(hits.get(ids.wildcard)).toBe(1);
    expect(hits.get(ids.qa)).toBe(0);
    expect(hits.get(ids.python)).toBe(0);
    expect(hits.get(proposedId)).toBe(0);

    const trace = await latestEvent(harness, "lessons.injected");
    expect(trace).toMatchObject({
      lesson_ids: [ids.matched, ids.wildcard],
      count: 2,
      chars: matchedText.length + wildcardText.length,
      top_n: 8,
      budget_chars: 4000,
      role: "developer",
      languages: [],
      spec_used: true,
      session_id: "session-1",
      agent: "developer",
      phase: "brainstorm",
    });
  });

  test("filters by role, wildcard role, and stored stack languages", async () => {
    const harness = await setup();
    const started = await call(harness, "team_start", { title: "Stack aware delivery" });
    const runId = started.run as string;
    await withRepo(harness, (_lessons, db) => {
      const runs = new RunRepository(db);
      runs.setStackJson(runId, JSON.stringify({
        version: 1,
        source: "researcher",
        components: [{
          name: "web",
          root: ".",
          languages: ["TypeScript"],
          frameworks: [],
          packageManager: null,
          commands: {},
          globs: {},
        }],
      }));
    });

    const ids = await withRepo(harness, (lessons, db) => {
      const inserted = {
        devTs: insertLesson(
          lessons,
          "developer",
          "Run the documented migration checks before merging the schema change.",
          "typescript",
        ),
        devPython: insertLesson(
          lessons,
          "developer",
          "Run pytest for the local helper package before publishing it.",
          "python",
        ),
        wildcardTs: insertLesson(
          lessons,
          "*",
          "Record the verification evidence beside each completed change.",
          "typescript",
        ),
        wildcardAny: insertLesson(
          lessons,
          "*",
          "Keep the handoff notes concise for every completed handoff.",
          "*",
        ),
        qaTs: insertLesson(
          lessons,
          "qa",
          "Check the signed build artifact before announcing the candidate.",
          "typescript",
        ),
      };
      pinCreatedAt(db, Object.values(inserted));
      return inserted;
    });

    const developerEvent = await harness.fake.invokeContextHook("developer", {}, {
      sessionID: "session-1",
      system: [],
    });
    const developerText = sectionText(developerEvent);
    expect(developerText.indexOf(`- [developer] Run the documented`)).toBeLessThan(
      developerText.indexOf(`- [*] Record the verification`),
    );
    expect(developerText).toContain(`- [*] Keep the handoff notes`);
    expect(developerText).not.toContain("pytest");
    expect(developerText).not.toContain("signed build artifact");

    const unknownEvent = await harness.fake.invokeContextHook("external-reviewer", {}, {
      sessionID: "session-1",
      system: [],
    });
    const unknownText = sectionText(unknownEvent);
    expect(unknownText).toContain("Record the verification evidence");
    expect(unknownText).toContain("Keep the handoff notes");
    expect(unknownText).not.toContain("Run the documented migration checks");
    expect(unknownText).not.toContain("signed build artifact");

    const roleWildcardTrace = await latestEvent(harness, "lessons.injected");
    expect(roleWildcardTrace).toMatchObject({
      lesson_ids: [ids.wildcardTs, ids.wildcardAny],
      role: null,
      languages: ["typescript"],
    });

    await call(harness, "team_start", { title: "Unprofiled delivery" }, {
      sessionID: "session-2",
      agent: "developer",
    });
    const unprofiledEvent = await harness.fake.invokeContextHook("developer", {}, {
      sessionID: "session-2",
      system: [],
    });
    const unprofiledText = sectionText(unprofiledEvent);
    expect(unprofiledText).toContain("Keep the handoff notes");
    expect(unprofiledText).not.toContain("Record the verification evidence");
    expect(unprofiledText).not.toContain("Run the documented migration checks");

    const unprofiledTrace = await latestEvent(harness, "lessons.injected");
    expect(unprofiledTrace).toMatchObject({
      lesson_ids: [ids.wildcardAny],
      role: "developer",
      languages: [],
    });
  });

  test("enforces lessons.topN and orders by hit count, then id", async () => {
    const harness = await setup({ lessons: { topN: 2 } });
    await call(harness, "team_start", { title: "Priority queue" });

    const texts = [
      "Use the first approved reminder to keep delivery predictable.",
      "Record the second approved reminder to keep delivery consistent.",
      "Keep the third approved reminder concise for every handoff.",
    ];
    const ids = await withRepo(harness, (lessons, db) => {
      const first = insertLesson(lessons, "*", texts[0] as string, "*");
      const second = insertLesson(lessons, "*", texts[1] as string, "*");
      const third = insertLesson(lessons, "*", texts[2] as string, "*");
      db.run("UPDATE lessons SET hit_count = 1 WHERE id = ?", [first]);
      db.run("UPDATE lessons SET hit_count = 5 WHERE id = ?", [second]);
      db.run("UPDATE lessons SET hit_count = 3 WHERE id = ?", [third]);
      return { first, second, third };
    });

    const event = await harness.fake.invokeContextHook("developer", {}, {
      sessionID: "session-1",
      system: [],
    });
    const text = sectionText(event);
    expect(text).toContain(texts[1] as string);
    expect(text).toContain(texts[2] as string);
    expect(text).not.toContain(texts[0] as string);

    const trace = await latestEvent(harness, "lessons.injected");
    expect(trace).toMatchObject({
      lesson_ids: [ids.second, ids.third],
      count: 2,
      top_n: 2,
    });

    const rows = await withRepo(harness, (lessons) => lessons.list());
    expect(rows.map((row) => row.hit_count)).toEqual([1, 6, 4]);
  });

  test("stops at the first lesson that would exceed lessons.budgetChars", async () => {
    const firstText = "Use the first approved reminder to keep delivery predictable.";
    const secondText = "Record the second approved reminder to keep delivery consistent.";
    const budgetChars = firstText.length + 10;
    const harness = await setup({ lessons: { topN: 8, budgetChars } });
    await call(harness, "team_start", { title: "Quota boundary" });

    const ids = await withRepo(harness, (lessons, db) => {
      const inserted = {
        first: insertLesson(lessons, "*", firstText, "*"),
        second: insertLesson(lessons, "*", secondText, "*"),
      };
      pinCreatedAt(db, Object.values(inserted));
      return inserted;
    });

    const event = await harness.fake.invokeContextHook("developer", {}, {
      sessionID: "session-1",
      system: [],
    });
    const text = sectionText(event);
    expect(text).toContain(firstText);
    expect(text).not.toContain(secondText);

    const trace = await latestEvent(harness, "lessons.injected");
    expect(trace).toMatchObject({
      lesson_ids: [ids.first],
      count: 1,
      chars: firstText.length,
      budget_chars: budgetChars,
    });

    const rows = await withRepo(harness, (lessons) => lessons.list());
    expect(rows.map((row) => row.hit_count)).toEqual([1, 0]);
  });

  test("does not inject when the budget cannot fit the first lesson", async () => {
    const harness = await setup({ lessons: { budgetChars: 10 } });
    await call(harness, "team_start", { title: "Tiny budget" });
    await withRepo(harness, (lessons) => {
      insertLesson(lessons, "*", "Use a lesson that is clearly longer than the tiny budget.", "*");
    });

    const event = await harness.fake.invokeContextHook("developer", {}, {
      sessionID: "session-1",
      system: [{ type: "text", text: "Base system." }],
    });
    expect(sectionText(event)).toBe("Base system.");
    expect(await latestEvent(harness, "lessons.injected")).toBeUndefined();

    const rows = await withRepo(harness, (lessons) => lessons.list());
    expect(rows.map((row) => row.hit_count)).toEqual([0]);
  });
});

interface DirectHarness {
  readonly rootDir: string;
  readonly db: TeamDatabase;
  readonly runs: RunRepository;
  readonly lessons: LessonsRepository;
  readonly runtime: ToolRuntime;
}

async function withDirectRuntime<T>(fn: (harness: DirectHarness) => T): Promise<T> {
  const rootDir = tempProject();
  const { db } = await openDatabase(":memory:");
  try {
    const runs = new RunRepository(db);
    runs.createRun({
      id: "run-1",
      title: "Shape compatibility",
      sessionId: "session-1",
      projectDir: rootDir,
      phase: "brainstorm",
    });
    runs.bindSession("session-1", "run-1", "developer");
    const lessons = new LessonsRepository(db);
    const config = parseConfig({ root: rootDir }, rootDir);
    const runtime: ToolRuntime = {
      config,
      db,
      trace: new Tracer(db),
      runs,
      lessons,
      modelSnapshot: { roles: {}, events: [] },
    };
    return fn({ rootDir, db, runs, lessons, runtime });
  } finally {
    db.close();
  }
}

describe("system-shape compatibility", () => {
  test("appends the section to string, array, and single-part system values", async () => {
    await withDirectRuntime(({ lessons, runtime }) => {
      const lessonText = "Use consistent evidence paths for every completion report.";
      const id = insertLesson(lessons, "*", lessonText, "*");
      const section = `- [*] ${lessonText}`;

      const stringEvent: LessonInjectionEvent & { system?: unknown } = {
        sessionID: "session-1",
        agent: "developer",
        system: "Base system.",
      };
      expect(injectApprovedLessons(runtime, stringEvent)).toMatchObject({ kind: "injected", lessonIds: [id] });
      expect(stringEvent.system).toBe(`Base system.\n\n${LESSON_SECTION_HEADER}\n${section}`);

      const parts = [{ type: "text", text: "Base system." }];
      const arrayEvent = { sessionID: "session-1", agent: "developer", system: parts };
      expect(injectApprovedLessons(runtime, arrayEvent)).toMatchObject({ kind: "injected", lessonIds: [id] });
      expect(parts).toEqual([
        { type: "text", text: "Base system." },
        { type: "text", text: `\n\n${LESSON_SECTION_HEADER}\n${section}` },
      ]);

      const singlePartEvent: LessonInjectionEvent & { system?: unknown } = {
        sessionID: "session-1",
        agent: "developer",
        system: { type: "text", text: "Base system." },
      };
      expect(injectApprovedLessons(runtime, singlePartEvent)).toMatchObject({ kind: "injected", lessonIds: [id] });
      expect(singlePartEvent.system).toEqual([
        { type: "text", text: "Base system." },
        { type: "text", text: `\n\n${LESSON_SECTION_HEADER}\n${section}` },
      ]);

      const unsupported = { sessionID: "session-1", agent: "developer", system: { type: "image", url: "x" } };
      expect(injectApprovedLessons(runtime, unsupported)).toEqual({
        kind: "skipped",
        reason: "system_shape",
      });
      expect(lessons.get(id)?.hit_count).toBe(3);
      const skipped = runtime.db?.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE kind = 'lessons.injection_skipped' ORDER BY id DESC LIMIT 1",
      );
      expect(JSON.parse(skipped?.data_json ?? "{}")).toMatchObject({
        reason: "system must be a string, a text part, or an array of text parts.",
        session_id: "session-1",
        agent: "developer",
      });
    });
  });

  test("injection handler never throws and traces unexpected failures", async () => {
    await withDirectRuntime(({ runtime }) => {
      const handler = createLessonInjectionHandler(runtime);
      expect(handler(null as unknown as LessonInjectionEvent)).toEqual({
        kind: "skipped",
        reason: "error",
      });
      const errorEvent = runtime.db?.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE kind = 'lessons.injection_error' ORDER BY id DESC LIMIT 1",
      );
      expect(JSON.parse(errorEvent?.data_json ?? "{}")).toMatchObject({
        message: expect.any(String),
      });

      const unavailable: ToolRuntime = { ...runtime, runs: null, lessons: null };
      expect(createLessonInjectionHandler(unavailable)({
        sessionID: "session-1",
        agent: "developer",
      })).toEqual({ kind: "skipped", reason: "database_unavailable" });
    });
  });
});
