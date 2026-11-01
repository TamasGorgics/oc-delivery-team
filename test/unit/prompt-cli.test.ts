import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTeamCli } from "../../src/cli/team";
import deliveryTeam from "../../src/index";
import { getDefaultPrompt } from "../../src/prompts";
import { withCodeModeGuidance } from "../../src/prompts/code-mode";
import { promptProposalSha } from "../../src/prompts/proposals";
import { openDatabase } from "../../src/state/db";
import { PromptRepository } from "../../src/state/prompts";
import { createFakeContext } from "../fakes/ctx";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-prompt-cli-"));
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

function requireCleanup(value: unknown): asserts value is () => Promise<void> {
  if (typeof value !== "function") throw new Error("Expected plugin setup to return a cleanup function.");
}

async function seedApprovedPrompt(rootDir: string, role: string, content: string): Promise<number> {
  mkdirSync(path.join(rootDir, "prompts"), { recursive: true });
  writeFileSync(path.join(rootDir, "prompts", `${role}.md`), content, "utf8");
  const { db } = await openDatabase(path.join(rootDir, "team.db"));
  try {
    const repository = new PromptRepository(db);
    const version = repository.recordProposal({
      role,
      sha: promptProposalSha(content),
      path: `proposals/${role}.20251001T000000Z.md`,
      createdAt: "2025-10-01T00:00:00.000Z",
    }).row;
    repository.setStatus(version.id, "approved", "2025-10-01T00:00:00.000Z");
    return version.id;
  } finally {
    db.close();
  }
}

describe("team prompts CLI", () => {
  test("lists, diffs, rejects, approves, and supersedes prompt versions", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const proposalDir = path.join(rootDir, "proposals");
    mkdirSync(proposalDir, { recursive: true });
    const oldText = "Previously approved developer prompt.\nKeep its useful guidance.";
    const newText = "You are the newly approved developer prompt.\nAlways check the changed files.";
    const rejectedText = "This prompt proposal will remain rejected.\n";
    const oldId = await seedApprovedPrompt(rootDir, "developer", oldText);
    writeFileSync(path.join(proposalDir, "developer.20261031T153012Z.md"), newText, "utf8");
    writeFileSync(path.join(proposalDir, "qa.20261031T153013Z.md"), rejectedText, "utf8");

    const listed = await cli(projectDir, ["prompts", "list", "--root", rootDir]);
    expect(listed.code).toBe(0);
    expect(listed.json()).toMatchObject({ ok: true, count: 3 });
    const devProposal = listed.json().prompts.find(
      (prompt: any) => prompt.file === "developer.20261031T153012Z.md",
    );
    expect(devProposal).toMatchObject({
      role: "developer",
      status: "proposed",
      path: "proposals/developer.20261031T153012Z.md",
      sha: promptProposalSha(newText),
    });

    const diff = await cli(projectDir, [
      "prompts", "diff", "developer.20261031T153012Z", "--root", rootDir,
    ]);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("--- prompts/developer.md");
    expect(diff.stdout).toContain("+++ proposal:developer.20261031T153012Z.md");
    expect(diff.stdout).toContain("-Previously approved developer prompt.");
    expect(diff.stdout).toContain("+You are the newly approved developer prompt.");

    const rejected = await cli(projectDir, [
      "prompts", "reject", "qa.20261031T153013Z.md", "--root", rootDir,
    ]);
    expect(rejected.code).toBe(0);
    expect(rejected.json()).toMatchObject({
      ok: true,
      action: "reject",
      previous_status: "proposed",
      changed: true,
      prompt: { role: "qa", status: "rejected", decided_at: expect.any(String) },
    });
    expect(existsSync(path.join(proposalDir, "qa.20261031T153013Z.md"))).toBe(true);

    const approved = await cli(projectDir, [
      "prompts", "approve", "proposals/developer.20261031T153012Z", "--root", rootDir,
    ]);
    expect(approved.code).toBe(0);
    expect(approved.json()).toMatchObject({
      ok: true,
      action: "approve",
      previous_status: "proposed",
      changed: true,
      restart_required: true,
      current_path: path.join(rootDir, "prompts", "developer.md"),
      prompt: {
        role: "developer",
        sha: promptProposalSha(newText),
        status: "approved",
        decided_at: expect.any(String),
      },
    });
    expect(readFileSync(path.join(rootDir, "prompts", "developer.md"), "utf8")).toBe(newText);
    expect(existsSync(path.join(proposalDir, "developer.20261031T153012Z.md"))).toBe(false);

    const repeated = await cli(projectDir, [
      "prompts", "approve", "developer.20261031T153012Z.md", "--root", rootDir,
    ]);
    expect(repeated.code).toBe(0);
    expect(repeated.json()).toMatchObject({ changed: false, restart_required: true });

    const invalid = await cli(projectDir, [
      "prompts", "approve", "qa.20261031T153013Z", "--root", rootDir,
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.json()).toMatchObject({ ok: false, code: "invalid_transition" });

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const versions = new PromptRepository(db).list();
      expect(versions.find((version) => version.id === oldId)?.status).toBe("superseded");
      expect(versions.filter((version) => version.role === "developer" && version.status === "approved"))
        .toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("does not use a pending proposal and loads an approved prompt after restart", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const proposalDir = path.join(rootDir, "proposals");
    mkdirSync(proposalDir, { recursive: true });
    const proposalFile = "developer.20261031T160000Z.md";
    const proposalText = "Approved developer prompt loaded after restart.";
    writeFileSync(path.join(proposalDir, proposalFile), proposalText, "utf8");

    const first = createFakeContext({ projectDirectory: projectDir });
    const firstCleanup = await deliveryTeam.setup(first.context);
    requireCleanup(firstCleanup);
    try {
      expect(first.state.agents.get("developer")?.system).toBe(getDefaultPrompt("developer"));
      const approved = await cli(projectDir, [
        "prompts", "approve", proposalFile, "--root", rootDir,
      ]);
      expect(approved.code).toBe(0);
      expect(approved.json()).toMatchObject({ restart_required: true, prompt: { status: "approved" } });
      expect(first.state.agents.get("developer")?.system).toBe(getDefaultPrompt("developer"));
    } finally {
      await firstCleanup();
    }

    const restarted = createFakeContext({ projectDirectory: projectDir });
    const restartedCleanup = await deliveryTeam.setup(restarted.context);
    requireCleanup(restartedCleanup);
    try {
      expect(restarted.state.agents.get("developer")?.system).toBe(withCodeModeGuidance(proposalText));
    } finally {
      await restartedCleanup();
    }
  });

  test("reports usage errors for invalid prompt commands and filenames", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const invalid = await cli(projectDir, ["prompts", "approve", "../developer.md", "--root", rootDir]);
    expect(invalid.code).toBe(2);
    expect(invalid.json()).toMatchObject({ ok: false, code: "usage" });

    const extra = await cli(projectDir, ["prompts", "list", "extra", "--root", rootDir]);
    expect(extra.code).toBe(2);

    const help = await cli(projectDir, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("team prompts list");
    expect(help.stdout).toContain("team prompts diff <file>");
  });

  test("records empty proposals for review but refuses to approve them", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const proposalDir = path.join(rootDir, "proposals");
    mkdirSync(proposalDir, { recursive: true });
    writeFileSync(path.join(proposalDir, "docs.20261031T170000Z.md"), " \n\t", "utf8");

    const listed = await cli(projectDir, ["prompts", "list", "--root", rootDir]);
    expect(listed.code).toBe(0);
    expect(listed.json()).toMatchObject({
      count: 1,
      prompts: [{ role: "docs", status: "proposed", sha: expect.any(String) }],
    });

    const approved = await cli(projectDir, [
      "prompts", "approve", "docs.20261031T170000Z", "--root", rootDir,
    ]);
    expect(approved.code).toBe(1);
    expect(approved.json()).toMatchObject({ ok: false, code: "invalid_proposal" });
  });
});
