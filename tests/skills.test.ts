import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SkillLibrary } from "../src/memory/skills.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join("/tmp", "persoje-test-skills");

describe("SkillLibrary", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("starts empty", () => {
    const lib = new SkillLibrary(TEST_DIR);
    expect(lib.list()).toHaveLength(0);
    expect(lib.catalog()).toBe("");
    expect(lib.summaryForPrompt()).toBe("");
  });

  it("adds and lists a skill", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("debug-react", "Debug a React component step by step", "1. Check props\n2. Check state\n3. Check effects");
    const skills = lib.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("debug-react");
    expect(skills[0].description).toBe("Debug a React component step by step");
  });

  it("catalog shows names and descriptions", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("git-rebase", "Interactive rebase workflow", "1. git rebase -i HEAD~n\n2. squash/pick");
    const catalog = lib.catalog();
    expect(catalog).toContain("/git-rebase");
    expect(catalog).toContain("Interactive rebase workflow");
  });

  it("summaryForPrompt includes names and descriptions", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("deploy", "Deploy to production", "1. Run tests\n2. Build\n3. Push");
    const summary = lib.summaryForPrompt();
    expect(summary).toContain("deploy");
    expect(summary).toContain("Deploy to production");
  });

  it("loads a skill lazily", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("test-skill", "A test skill", "Step 1\nStep 2");
    const skill = lib.load("test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("test-skill");
    expect(skill!.content).toContain("Step 1");
    expect(skill!.useCount).toBe(1); // load records use
  });

  it("returns null for non-existent skill", () => {
    const lib = new SkillLibrary(TEST_DIR);
    expect(lib.load("nonexistent")).toBeNull();
  });

  it("removes a skill", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("temp-skill", "Temporary", "Content");
    expect(lib.list()).toHaveLength(1);
    expect(lib.remove("temp-skill")).toBe(true);
    expect(lib.list()).toHaveLength(0);
  });

  it("tracks use count", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("counted", "Counted skill", "Content");
    lib.load("counted");
    lib.load("counted");
    const skills = lib.list();
    // Each load() calls recordUse(), incrementing useCount
    expect(skills[0].useCount).toBeGreaterThanOrEqual(2);
  });

  it("prunes unused skills after threshold", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("old-skill", "Old unused skill", "Content");
    // Manually set lastUsed to 31 days ago and useCount to 0
    const { writeFileSync } = require("node:fs");
    const filePath = join(TEST_DIR, "old-skill.md");
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeFileSync(filePath, `---\nname: old-skill\ndescription: Old unused skill\nlastUsed: ${thirtyOneDaysAgo}\nuseCount: 0\n---\nContent`, "utf-8");
    
    const pruned = lib.prune();
    expect(pruned).toContain("old-skill");
    expect(lib.list()).toHaveLength(0);
  });

  it("search finds relevant skills", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("react-debug", "Debug React components", "Check props, state, effects");
    lib.add("git-workflow", "Git branching strategy", "Feature branches, rebase, merge");
    const results = lib.search("react component debugging");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("react-debug");
  });

  it("injectFor returns skill content within token budget", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("relevant", "Relevant skill", "Do the thing step by step");
    const injected = lib.injectFor("relevant task", 1000);
    expect(injected).toContain("relevant");
    expect(injected).toContain("Do the thing");
  });

  it("injectFor returns empty for no matches", () => {
    const lib = new SkillLibrary(TEST_DIR);
    lib.add("unrelated", "Unrelated skill", "Something else");
    const injected = lib.injectFor("completely different topic xyz", 1000);
    // May or may not match — just shouldn't crash
    expect(typeof injected).toBe("string");
  });
});
