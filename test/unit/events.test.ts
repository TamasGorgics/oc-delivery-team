import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import deliveryTeam, { getDeliveryTeamSnapshot } from "../../src/index";
import { openDatabase } from "../../src/state/db";
import { RunRepository } from "../../src/state/runs";
import { createFakeContext, type FakeContextHarness } from "../fakes/ctx";

interface EventHarness {
  readonly fake: FakeContextHarness;
  readonly projectDir: string;
  readonly rootDir: string;
  readonly cleanup: () => Promise<void>;
}

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Deliberately broken setups still get best-effort cleanup.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup(options: {
  readonly projectDir?: string;
  readonly config?: unknown;
  readonly eventSubscribeError?: Error;
} = {}): Promise<EventHarness> {
  const projectDir = options.projectDir ?? mkdtempSync(path.join(os.tmpdir(), "delivery-team-events-"));
  if (!options.projectDir) directories.push(projectDir);
  const fake = createFakeContext({
    projectDirectory: projectDir,
    ...(options.config === undefined ? {} : { options: options.config }),
    ...(options.eventSubscribeError ? { eventSubscribeError: options.eventSubscribeError } : {}),
  });
  const cleanup = await deliveryTeam.setup(fake.context);
  if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
  const dispose = async (): Promise<void> => {
    await cleanup();
  };
  cleanups.push(dispose);
  return {
    fake,
    projectDir,
    rootDir: path.join(projectDir, ".team"),
    cleanup: dispose,
  };
}

async function repository<T>(h: EventHarness, run: (runs: RunRepository) => T): Promise<T> {
  const { db } = await openDatabase(path.join(h.rootDir, "team.db"));
  try {
    return run(new RunRepository(db));
  } finally {
    db.close();
  }
}

function output(result: { output?: unknown }): Record<string, any> {
  return (result.output ?? {}) as Record<string, any>;
}

const TIME = Date.parse("2026-01-01T10:00:00.000Z");

describe("session and message event ingestion", () => {
  test("tracks sessions, inherits runs from parents, and records step tokens and cost", async () => {
    const h = await setup();
    expect(h.fake.state.eventSubscribeCount).toBe(1);
    expect(getDeliveryTeamSnapshot(h.fake.context)?.events).toEqual({ status: "subscribed" });

    await h.fake.emit("session.created", {
      created: TIME,
      data: {
        sessionID: "parent",
        location: { directory: h.projectDir },
        agent: "team-lead",
        model: { providerID: "provider", id: "root-model" },
      },
    });
    const started = output(await h.fake.invokeTool(
      "team_start",
      { title: "Events" },
      { sessionID: "parent", agent: "team-lead" },
    ));
    expect(started.ok).toBe(true);
    const run = started.run as string;

    await h.fake.emit("session.created", {
      created: TIME + 1_000,
      data: {
        sessionID: "child",
        parentID: "parent",
        location: { directory: h.projectDir },
        agent: "developer",
      },
    });
    await h.fake.emit("session.agent.selected", {
      created: TIME + 2_000,
      data: { sessionID: "child", agent: "developer" },
    });
    await h.fake.emit("session.model.selected", {
      created: TIME + 3_000,
      data: { sessionID: "child", model: { providerID: "provider", id: "child-model", variant: "low" } },
    });
    await h.fake.emit("session.step.ended", {
      created: TIME + 4_000,
      data: {
        sessionID: "child",
        assistantMessageID: "message-1",
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        cost: 0.0125,
        finish: "stop",
      },
    });
    await h.fake.emit("session.idle", {
      created: TIME + 5_000,
      data: { sessionID: "child" },
    });

    const state = await repository(h, (runs) => ({
      parent: runs.getSession("parent"),
      child: runs.getSession("child"),
      messages: runs.listMessages(run),
      events: runs.listEvents(run, 100),
    }));

    expect(state.parent).toMatchObject({ run_id: run, agent: "team-lead" });
    expect(state.child).toMatchObject({
      run_id: run,
      parent_id: "parent",
      agent: "developer",
      started_at: new Date(TIME + 1_000).toISOString(),
      ended_at: new Date(TIME + 5_000).toISOString(),
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "message-1",
      session_id: "child",
      run_id: run,
      agent: "developer",
      model: "provider/child-model#low",
      tokens_in: 10,
      tokens_out: 20,
      cost: 0.0125,
      at: new Date(TIME + 4_000).toISOString(),
    });
    expect(state.events.map((event) => event.kind)).toContain("session.started");
    expect(state.events.map((event) => event.kind)).toContain("session.ended");
  });

  test("inherits a parent model when a child never selects one", async () => {
    const h = await setup();
    await h.fake.emit("session.created", {
      created: TIME,
      data: {
        sessionID: "parent",
        location: { directory: h.projectDir },
        agent: "team-lead",
        model: { providerID: "provider", id: "root-model" },
      },
    });
    const started = output(await h.fake.invokeTool(
      "team_start",
      { title: "Inheritance" },
      { sessionID: "parent", agent: "team-lead" },
    ));
    await h.fake.emit("session.created", {
      created: TIME + 1,
      data: {
        sessionID: "child",
        parentID: "parent",
        location: { directory: h.projectDir },
        agent: "developer",
      },
    });
    await h.fake.emit("session.step.ended", {
      created: TIME + 2,
      data: {
        sessionID: "child",
        assistantMessageID: "message-2",
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      },
    });

    const messages = await repository(h, (runs) => runs.listMessages(started.run as string));
    expect(messages[0]?.model).toBe("provider/root-model");
  });

  test("backfills descendant sessions and messages when the parent run is bound later", async () => {
    const h = await setup();
    await h.fake.emit("session.created", {
      created: TIME,
      data: {
        sessionID: "early-child",
        parentID: "late-parent",
        location: { directory: h.projectDir },
        agent: "developer",
      },
    });
    await h.fake.emit("session.step.ended", {
      created: TIME + 1,
      data: {
        sessionID: "early-child",
        assistantMessageID: "early-message",
        tokens: { input: 3, output: 4 },
        cost: 0.002,
      },
    });
    await h.fake.emit("session.created", {
      created: TIME + 2,
      data: {
        sessionID: "late-parent",
        location: { directory: h.projectDir },
        agent: "team-lead",
      },
    });
    const started = output(await h.fake.invokeTool(
      "team_start",
      { title: "Late parent binding" },
      { sessionID: "late-parent", agent: "team-lead" },
    ));

    const state = await repository(h, (runs) => ({
      child: runs.getSession("early-child"),
      messages: runs.listMessages(started.run as string),
    }));
    expect(state.child?.run_id).toBe(started.run);
    expect(state.messages).toMatchObject([{
      id: "early-message",
      session_id: "early-child",
      run_id: started.run,
      tokens_in: 3,
      tokens_out: 4,
      cost: 0.002,
    }]);
  });

  test("ignores sessions and events from other project directories", async () => {
    const h = await setup();
    await h.fake.emit("session.created", {
      created: TIME,
      data: {
        sessionID: "foreign",
        location: { directory: "/somewhere/else" },
        agent: "team-lead",
      },
    });
    await h.fake.emit("session.created", {
      created: TIME + 1,
      data: {
        sessionID: "local",
        location: { directory: h.projectDir },
        agent: "team-lead",
      },
    });
    await h.fake.emit("session.model.selected", {
      created: TIME + 2,
      location: { directory: "/somewhere/else" },
      data: { sessionID: "local", model: { providerID: "evil", id: "model" } },
    });

    const sessions = await repository(h, (runs) => ({
      foreign: runs.getSession("foreign"),
      local: runs.getSession("local"),
    }));
    expect(sessions.foreign).toBeUndefined();
    expect(sessions.local).toMatchObject({ agent: "team-lead" });
  });

  test("falls back to degraded mode when the event stream is unavailable", async () => {
    const h = await setup({ eventSubscribeError: new Error("events offline") });
    const snapshot = getDeliveryTeamSnapshot(h.fake.context);
    expect(snapshot?.events).toEqual({ status: "unavailable", error: "events offline" });
    expect(snapshot?.setupWarnings).toContain("events.subscribe: events offline");
    expect(snapshot?.tools.length).toBeGreaterThan(0);

    const started = output(await h.fake.invokeTool(
      "team_start",
      { title: "Still works" },
      { sessionID: "session-1", agent: "team-lead" },
    ));
    expect(started.ok).toBe(true);
  });

  test("reports asynchronous stream failures through the live setup snapshot", async () => {
    const h = await setup();
    expect(getDeliveryTeamSnapshot(h.fake.context)?.events).toEqual({ status: "subscribed" });

    await h.fake.failEvents(new Error("stream disconnected"));

    expect(getDeliveryTeamSnapshot(h.fake.context)?.events).toEqual({
      status: "unavailable",
      error: "stream disconnected",
    });
    expect(getDeliveryTeamSnapshot(h.fake.context)?.setupWarnings)
      .toContain("events.stream: stream disconnected");
    const started = output(await h.fake.invokeTool(
      "team_start",
      { title: "Still works after disconnect" },
      { sessionID: "session-1", agent: "team-lead" },
    ));
    expect(started.ok).toBe(true);
  });

  test("aborts the background stream during cleanup without hanging", async () => {
    const h = await setup();
    expect(h.fake.state.eventSubscribers).toHaveLength(1);
    await h.cleanup();
    expect(h.fake.state.eventAbortCount).toBe(1);
    expect(h.fake.state.eventSubscribers[0]?.closed).toBe(true);
  });
});
