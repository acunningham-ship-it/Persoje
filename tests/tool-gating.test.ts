import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildRegistry, lowFrequencyTools } from "../src/tools/registry-builder.ts";
import { SkillLibrary } from "../src/memory/skills.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join("/tmp", "persoje-test-gating-skills");

describe("dynamic tool gating (config.tools.gateLowFrequency)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("flag OFF (default) is byte-identical to the pre-gating tool set", () => {
    const skills = new SkillLibrary(TEST_DIR);
    const off = buildRegistry(skills, undefined); // default: gateLowFrequency omitted
    const explicitOff = buildRegistry(skills, undefined, false);

    // Same tool names, same order, in both the implicit-default and explicit-false paths.
    expect(off.names()).toEqual(explicitOff.names());

    // The full pre-gating tool set is present — nothing hidden, no more_tools tool added.
    // monitor + add_skill included: they must stay unconditionally registered when the flag is off.
    for (const t of ["read", "write", "edit", "multi_edit", "ls", "glob", "bash", "grep", "web_fetch", "web_search", "monitor", "add_skill"]) {
      expect(off.names()).toContain(t);
    }
    expect(off.names()).not.toContain("more_tools");

    // Wire-format schemas must be byte-identical too — not just names — since a subtly
    // different schema for the same-named tool would still be a real behavior change.
    expect(JSON.stringify(off.schemas())).toBe(JSON.stringify(explicitOff.schemas()));
  });

  it("flag ON hides low-frequency tools and adds the reveal tool", () => {
    const skills = new SkillLibrary(TEST_DIR);
    const on = buildRegistry(skills, undefined, true);

    for (const t of lowFrequencyTools()) {
      expect(on.names()).not.toContain(t.name);
    }
    // add_skill is gated too but isn't in lowFrequencyTools() (it's constructed with the skills lib).
    expect(on.names()).not.toContain("add_skill");
    // monitor is in lowFrequencyTools() so the loop above covers it; assert explicitly for clarity.
    expect(on.names()).not.toContain("monitor");
    expect(on.names()).toContain("more_tools");

    // more_tools must ADVERTISE everything it gates (its description is derived from the gated set),
    // or the model can't know to reveal them — a gated tool missing from the description is silently
    // unreachable. This locks against the description drifting from the actual gated list.
    const moreDesc = on.get("more_tools")!.description;
    for (const name of ["web_fetch", "web_search", "multi_edit", "monitor", "add_skill"]) {
      expect(moreDesc).toContain(name);
    }

    // Core tools are NEVER gated, flag on or off — this is the hard safety line.
    for (const t of ["read", "write", "edit", "ls", "glob", "bash", "grep"]) {
      expect(on.names()).toContain(t);
    }
  });

  it("flag ON measurably reduces tool-schema token cost vs flag OFF", () => {
    const skills = new SkillLibrary(TEST_DIR);
    const off = buildRegistry(skills, undefined, false);
    const on = buildRegistry(skills, undefined, true);
    off.schemas();
    on.schemas();
    expect(on.schemaTokens()).toBeLessThan(off.schemaTokens());
  });

  it("calling more_tools reveals the gated tools for the rest of the session", async () => {
    const skills = new SkillLibrary(TEST_DIR);
    const registry = buildRegistry(skills, undefined, true);
    expect(registry.names()).not.toContain("web_fetch");

    const moreTools = registry.get("more_tools")!;
    const result = await moreTools.execute({}, { cwd: "/tmp", bashTimeoutMs: 1000 });

    expect(registry.names()).toContain("web_fetch");
    expect(registry.names()).toContain("web_search");
    expect(registry.names()).toContain("multi_edit");
    // monitor + add_skill are revealed by the same call — no capability is permanently lost.
    expect(registry.names()).toContain("monitor");
    expect(registry.names()).toContain("add_skill");
    // The reveal message names what's now available, so the model knows to use it directly
    // rather than calling more_tools again.
    expect(result).toContain("web_fetch");

    // Schema cache reflects the reveal on the next schemas() call (not stale).
    const schemas = registry.schemas();
    expect(schemas.some((s) => s.function.name === "web_fetch")).toBe(true);
  });

  it("more_tools is idempotent — calling it twice doesn't duplicate or error", async () => {
    const skills = new SkillLibrary(TEST_DIR);
    const registry = buildRegistry(skills, undefined, true);
    const moreTools = registry.get("more_tools")!;

    await moreTools.execute({}, { cwd: "/tmp", bashTimeoutMs: 1000 });
    const namesAfterFirst = registry.names();
    await moreTools.execute({}, { cwd: "/tmp", bashTimeoutMs: 1000 });
    const namesAfterSecond = registry.names();

    expect(namesAfterSecond).toEqual(namesAfterFirst);
  });
});
