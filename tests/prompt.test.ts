import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

describe("buildSystemPrompt", () => {
  test("pins the goal when set", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "Ship the web tools");
    expect(p).toContain("SESSION GOAL");
    expect(p).toContain("Ship the web tools");
  });

  test("pins the working plan when todos exist", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "", [
      { content: "Add tool", status: "done" },
      { content: "Wire UI", status: "in_progress" },
    ]);
    expect(p).toContain("WORKING PLAN");
    expect(p).toContain("[x] Add tool");
    expect(p).toContain("[~] Wire UI");
  });

  test("omits the plan section when there are no todos", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid");
    expect(p).not.toContain("WORKING PLAN");
  });
});

describe("buildSystemPrompt auto-load AGENTS.md", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(Bun.env.TMPDIR || "/tmp", "persoje-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("auto-loads AGENTS.md from cwd and includes it in the prompt", async () => {
    const agentsContent = "# Project Configuration\nDefault model: qwen\nMemory path: ~/.memory";
    await writeFile(join(tempDir, "AGENTS.md"), agentsContent);

    const p = buildSystemPrompt(tempDir);
    expect(p).toContain(agentsContent);
  });

  test("includes get_context boot instruction when AGENTS.md is loaded", async () => {
    const agentsContent = "# Project Config";
    await writeFile(join(tempDir, "AGENTS.md"), agentsContent);

    const p = buildSystemPrompt(tempDir);
    expect(p).toContain("get_context");
  });

  test("falls back to CLAUDE.md if AGENTS.md does not exist", async () => {
    const claudeContent = "# Claude Configuration\nRules for this project";
    await writeFile(join(tempDir, "CLAUDE.md"), claudeContent);

    const p = buildSystemPrompt(tempDir);
    expect(p).toContain(claudeContent);
  });

  test("walks up directory tree to find AGENTS.md in parent", async () => {
    const parentDir = await mkdtemp(join(Bun.env.TMPDIR || "/tmp", "persoje-test-parent-"));
    const childDir = join(parentDir, "child");

    try {
      await mkdir(childDir, { recursive: true });
      const agentsContent = "# Parent AGENTS\nConfig from parent dir";
      await writeFile(join(parentDir, "AGENTS.md"), agentsContent);

      const p = buildSystemPrompt(childDir);
      expect(p).toContain(agentsContent);
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  test("does not break when neither AGENTS.md nor CLAUDE.md exist", () => {
    const p = buildSystemPrompt(tempDir);
    expect(p).toContain("You are Persoje");
    expect(p.length > 0).toBe(true);
  });

  test("prefers AGENTS.md over CLAUDE.md when both exist", async () => {
    const agentsContent = "# AGENTS config";
    const claudeContent = "# CLAUDE config";
    await writeFile(join(tempDir, "AGENTS.md"), agentsContent);
    await writeFile(join(tempDir, "CLAUDE.md"), claudeContent);

    const p = buildSystemPrompt(tempDir);
    expect(p).toContain(agentsContent);
    expect(p).not.toContain(claudeContent);
  });
});
