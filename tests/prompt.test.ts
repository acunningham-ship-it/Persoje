import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildSystemPrompt, buildPinsSection, buildRepoMapSection, findProjectConventions } from "../src/core/prompt.ts";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

describe("buildSystemPrompt (seg1 — stable base)", () => {
  test("includes base rules and effort prompt", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid");
    expect(p).toContain("You are Persoje");
    expect(p).toContain("Read before you edit");
    expect(p).toContain("Effort: MID");
  });

  test("does NOT include goal or todos (those are in buildPinsSection)", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid");
    expect(p).not.toContain("SESSION GOAL");
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

    // Agent loads conventions once at init via findProjectConventions and passes
    // them into buildSystemPrompt; replicate that wiring here.
    const p = buildSystemPrompt(tempDir, "", "", "mid", undefined, undefined, findProjectConventions(tempDir));
    expect(p).toContain(agentsContent);
  });

  test("includes get_context boot instruction when AGENTS.md is loaded", async () => {
    const agentsContent = "# Project Config";
    await writeFile(join(tempDir, "AGENTS.md"), agentsContent);

    const p = buildSystemPrompt(tempDir, "", "", "mid", undefined, undefined, findProjectConventions(tempDir));
    expect(p).toContain("get_context");
  });

  test("falls back to CLAUDE.md if AGENTS.md does not exist", async () => {
    const claudeContent = "# Claude Configuration\nRules for this project";
    await writeFile(join(tempDir, "CLAUDE.md"), claudeContent);

    const p = buildSystemPrompt(tempDir, "", "", "mid", undefined, undefined, findProjectConventions(tempDir));
    expect(p).toContain(claudeContent);
  });

  test("walks up directory tree to find AGENTS.md in parent", async () => {
    const parentDir = await mkdtemp(join(Bun.env.TMPDIR || "/tmp", "persoje-test-parent-"));
    const childDir = join(parentDir, "child");

    try {
      await mkdir(childDir, { recursive: true });
      const agentsContent = "# Parent AGENTS\nConfig from parent dir";
      await writeFile(join(parentDir, "AGENTS.md"), agentsContent);

      const p = buildSystemPrompt(childDir, "", "", "mid", undefined, undefined, findProjectConventions(childDir));
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

    const p = buildSystemPrompt(tempDir, "", "", "mid", undefined, undefined, findProjectConventions(tempDir));
    expect(p).toContain(agentsContent);
    expect(p).not.toContain(claudeContent);
  });
});

describe("buildSystemPrompt quirks section", () => {
  test("renders quirks when provided", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "", ["malforms JSON", "loops on iteration"]);
    expect(p).toContain("Known quirks of this model");
    expect(p).toContain("• malforms JSON");
    expect(p).toContain("• loops on iteration");
  });

  test("caps quirks to top 3", () => {
    const manyQuirks = Array.from({ length: 10 }, (_, i) => `quirk-${i}`);
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "", manyQuirks);
    expect(p).toContain("quirk-0");
    expect(p).toContain("quirk-1");
    expect(p).toContain("quirk-2");
    expect(p).not.toContain("quirk-3"); // Should be capped
  });

  test("omits quirks section when empty", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "", []);
    expect(p).not.toContain("Known quirks of this model");
  });
});

describe("buildPinsSection (seg5 — volatile goal+todos)", () => {
  test("pins the goal when set", () => {
    const p = buildPinsSection("Ship the web tools", []);
    expect(p).toContain("SESSION GOAL");
    expect(p).toContain("Ship the web tools");
  });

  test("pins the working plan when todos exist", () => {
    const p = buildPinsSection("", [
      { content: "Add tool", status: "done" },
      { content: "Wire UI", status: "in_progress" },
    ]);
    expect(p).toContain("WORKING PLAN");
    expect(p).toContain("[x] Add tool");
    expect(p).toContain("[~] Wire UI");
  });

  test("default goal section when goal is empty", () => {
    const p = buildPinsSection("", []);
    expect(p).toContain("No session goal is set yet");
  });

  test("goal appears before plan", () => {
    const p = buildPinsSection("test goal", [{ content: "step 1", status: "pending" }]);
    const goalIdx = p.indexOf("SESSION GOAL");
    const planIdx = p.indexOf("WORKING PLAN");
    expect(goalIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(-1);
    expect(goalIdx).toBeLessThan(planIdx);
  });
});

describe("buildRepoMapSection (seg3 — stable repo map)", () => {
  test("includes repo-map when provided", () => {
    const rm = "## Files\nindex.ts\nsrc/";
    const p = buildRepoMapSection(rm);
    expect(p).toContain("index.ts");
    expect(p).toContain("src/");
  });

  test("returns empty string when repo-map is empty", () => {
    const p = buildRepoMapSection("");
    expect(p).toBe("");
  });

  test("prepends double newline for separation", () => {
    const p = buildRepoMapSection("test");
    expect(p.startsWith("\n\n")).toBe(true);
  });
});
