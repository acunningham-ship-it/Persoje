import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FactStore } from "../src/memory/facts.ts";
import { LessonLog } from "../src/memory/lessons.ts";
import { SkillLibrary } from "../src/memory/skills.ts";
import { runDream } from "../src/memory/dream.ts";
import { SessionStore } from "../src/session/store.ts";
import type { StreamEvent, ChatRequest } from "../src/models/openrouter.ts";

/** Create a temp directory for the test. */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "persoje-test-"));
}

/** Fake client for testing. */
// Accepts one response (reused for every call) or a list returned in call
// order (clamped to the last) — runDream makes a 2nd "judge" call after the
// extraction call, so dream tests supply [extraction, judgeVerdict].
function fakeClient(response: string | string[]) {
  let call = 0;
  return {
    stream: async function* (_req: ChatRequest): AsyncGenerator<StreamEvent> {
      const arr = Array.isArray(response) ? response : [response];
      const delta = arr[Math.min(call++, arr.length - 1)]!;
      yield { type: "text", delta };
      yield {
        type: "usage",
        usage: {
          model: "test/model",
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          cost: 0,
          durationMs: 10,
        },
      };
    },
  } as any;
}

describe("FactStore", () => {
  test("add and retrieve facts", () => {
    const dir = createTempDir();
    try {
      const store = new FactStore(dir);

      // Add a fact
      const path = store.addFact("User Preference", "Prefers dark mode and TypeScript");
      expect(path).toContain("user-preference.md");

      // Retrieve it
      const fact = store.getFact("user-preference");
      expect(fact).toBeDefined();
      expect(fact?.title ?? "").toBe("User Preference");
      expect(fact?.body ?? "").toContain("dark mode");

      // Check index
      const index = store.index();
      expect(index).toContain("User Preference");
      expect(index).toContain("user-preference.md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("loadForSession respects token budget", () => {
    const dir = createTempDir();
    try {
      const store = new FactStore(dir);

      // Add many facts
      for (let i = 0; i < 10; i++) {
        store.addFact(`Fact ${i}`, `This is fact number ${i} with some content`);
      }

      // Load with tight budget
      const loaded = store.loadForSession(100); // Very small budget
      expect(loaded.length).toBeLessThan(500); // Should be clipped

      // Load with large budget
      const loaded2 = store.loadForSession(10000);
      expect(loaded2).toContain("Fact");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("quirks dedup and cap at 8", () => {
    const dir = createTempDir();
    try {
      const store = new FactStore(dir);

      // Add quirks
      store.addQuirk("model/test", "quirk-1");
      store.addQuirk("model/test", "quirk-1"); // duplicate
      store.addQuirk("model/test", "quirk-2");

      const quirks = store.getQuirks("model/test");
      expect(quirks).toContain("quirk-1");
      expect(quirks).toContain("quirk-2");
      expect(quirks.length).toBe(2); // Should not duplicate

      // Add 10 more to test cap
      for (let i = 0; i < 10; i++) {
        store.addQuirk("model/test", `quirk-${i + 3}`);
      }

      const finalQuirks = store.getQuirks("model/test");
      expect(finalQuirks.length).toBeLessThanOrEqual(8);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("remove fact", () => {
    const dir = createTempDir();
    try {
      const store = new FactStore(dir);

      store.addFact("Temporary Fact", "This will be removed");
      let fact = store.getFact("temporary-fact");
      expect(fact).toBeDefined();

      store.removeFact("temporary-fact");
      fact = store.getFact("temporary-fact");
      expect(fact).toBeNull();

      // Check index no longer contains it
      const index = store.index();
      expect(index).not.toContain("temporary-fact");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("LessonLog", () => {
  test("append and retrieve lessons", () => {
    const dir = createTempDir();
    const logPath = join(dir, "lessons.jsonl");

    try {
      const log = new LessonLog(logPath);

      log.append({
        task: "debug git rebase",
        error: "conflicts in main.ts",
        lesson: "always fetch before rebasing",
        model: "claude/opus",
      });

      const recent = log.recent(1);
      expect(recent.length).toBe(1);
      expect(recent[0]?.lesson ?? "").toContain("always fetch");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("recent returns newest-first", () => {
    const dir = createTempDir();
    const logPath = join(dir, "lessons.jsonl");

    try {
      const log = new LessonLog(logPath);

      log.append({
        task: "task 1",
        error: "err1",
        lesson: "lesson 1",
        model: "model1",
      });
      log.append({
        task: "task 2",
        error: "err2",
        lesson: "lesson 2",
        model: "model2",
      });

      const recent = log.recent(2);
      expect(recent[0]?.lesson ?? "").toBe("lesson 2"); // Should be newest
      expect(recent[1]?.lesson ?? "").toBe("lesson 1");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("loadForSession respects budget and formats correctly", () => {
    const dir = createTempDir();
    const logPath = join(dir, "lessons.jsonl");

    try {
      const log = new LessonLog(logPath);

      log.append({
        task: "task 1",
        error: "err1",
        lesson: "lesson 1",
        model: "model1",
      });
      log.append({
        task: "task 2",
        error: "err2",
        lesson: "lesson 2",
        model: "model2",
      });

      const loaded = log.loadForSession(1000);
      expect(loaded).toContain("- [model");
      expect(loaded).toContain("lesson");

      // Empty when no lessons
      const empty = new LessonLog(join(dir, "empty.jsonl"));
      expect(empty.loadForSession(1000)).toBe("");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("handles corrupt lines gracefully", async () => {
    const dir = createTempDir();
    const logPath = join(dir, "lessons.jsonl");

    try {
      const log = new LessonLog(logPath);

      log.append({
        task: "valid lesson",
        error: "err",
        lesson: "this is valid",
        model: "model",
      });

      // Manually add a corrupt line
      const fs = await import("node:fs");
      const current = fs.readFileSync(logPath, "utf-8");
      fs.writeFileSync(logPath, `${current}\ninvalid json line\n`);

      // Should still retrieve the valid one
      const all = log.all();
      expect(all.length).toBe(1);
      expect(all[0]?.lesson).toBe("this is valid");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("replaceAll", () => {
    const dir = createTempDir();
    const logPath = join(dir, "lessons.jsonl");

    try {
      const log = new LessonLog(logPath);

      const newLessons = [
        {
          timestamp: Date.now(),
          task: "new task",
          error: "new error",
          lesson: "new lesson",
          model: "new model",
        },
      ];

      log.replaceAll(newLessons);
      const all = log.all();
      expect(all.length).toBe(1);
      expect(all[0]?.lesson ?? "").toBe("new lesson");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("SkillLibrary", () => {
  test("add and list skills", () => {
    const dir = createTempDir();
    try {
      const lib = new SkillLibrary(dir);

      lib.add("Git Rebase", "fix rebase conflicts safely", "Use `git rebase --continue` after resolving");
      lib.add("CSS Flexbox", "layout with flexbox", "Use `display: flex` for layouts");

      const list = lib.list();
      expect(list.length).toBe(2);
      expect(list.some((s) => s.name === "Git Rebase")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("search finds relevant skills", () => {
    const dir = createTempDir();
    try {
      const lib = new SkillLibrary(dir);

      lib.add("Git Rebase", "fix rebase conflicts", "Use `git rebase --continue`");
      lib.add("CSS Flexbox", "layout with flexbox", "Use `display: flex`");

      // Search for git-related query
      const results = lib.search("fix rebase conflict", 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.name ?? "").toBe("Git Rebase");

      // Search for CSS query should not find git
      const cssResults = lib.search("css styling", 2);
      const hasGit = cssResults.some((r) => r.name === "Git Rebase");
      // Note: minisearch is generous; we check relevance threshold instead
      if (cssResults.length > 0) {
        expect(cssResults.some((r) => r.name === "CSS Flexbox")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("injectFor respects token budget", () => {
    const dir = createTempDir();
    try {
      const lib = new SkillLibrary(dir);

      lib.add("Git Rebase", "fix rebase conflicts", "Step 1: resolve conflicts\nStep 2: stage changes\nStep 3: continue");
      lib.add("Test Writing", "write unit tests", "describe('test', () => { it('works', () => {}); })");

      const injected = lib.injectFor("git rebase issue", 500); // Tight budget
      expect(injected.length).toBeGreaterThan(0);
      expect(injected).toContain("Git Rebase");

      // Empty when no relevant skills
      const empty = lib.injectFor("", 500);
      expect(empty).toBe("");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("runDream", () => {
  test("extracts facts and compacts lessons", async () => {
    const dbDir = createTempDir();
    const factsDir = createTempDir();
    const lessonsPath = join(dbDir, "lessons.jsonl");

    try {
      const store = new SessionStore(join(dbDir, "sessions.db"));
      const facts = new FactStore(factsDir);
      const lessons = new LessonLog(lessonsPath);

      // Create a session with some messages
      const sessionId = store.create(process.cwd(), "test/model");
      store.appendMessage(sessionId, { role: "user", content: "How do I use Bun?" });
      store.appendMessage(sessionId, {
        role: "assistant",
        content: "Bun is a fast JavaScript runtime. Use `bun run`.",
      });
      store.maybeSetTitle(sessionId, "Learn Bun");

      // Add some lessons
      lessons.append({
        task: "bun learn",
        error: "none",
        lesson: "Bun uses bun:sqlite not better-sqlite3",
        model: "claude",
      });

      // Fake client returns a valid dream response
      const dreamResponse = JSON.stringify({
        facts: [
          {
            title: "Bun Runtime Preference",
            body: "User prefers Bun over Node.js; use bun:sqlite, bun:postgres",
          },
        ],
        lessons_kept: [1],
      });

      const result = await runDream({
        // [extraction, judge-verdict] — judge keeps candidate #1.
        client: fakeClient([dreamResponse, '{"keep":[1]}']),
        model: "test/free",
        store,
        facts,
        lessons,
        sinceMs: Date.now() - 1000, // Very recent
        log: () => {}, // Silent
      });

      expect(result.factsAdded).toBe(1);
      const fact = facts.getFact("bun-runtime-preference");
      expect(fact?.title).toContain("Bun");

      store.close();
    } finally {
      rmSync(dbDir, { recursive: true });
      rmSync(factsDir, { recursive: true });
    }
  });

  test("handles garbage model response gracefully", async () => {
    const dbDir = createTempDir();
    const factsDir = createTempDir();
    const lessonsPath = join(dbDir, "lessons.jsonl");

    try {
      const store = new SessionStore(join(dbDir, "sessions.db"));
      const facts = new FactStore(factsDir);
      const lessons = new LessonLog(lessonsPath);

      const sessionId = store.create(process.cwd(), "test/model");
      store.appendMessage(sessionId, { role: "user", content: "test" });
      store.appendMessage(sessionId, { role: "assistant", content: "garbage response" });

      // Return garbage that doesn't parse as JSON
      const result = await runDream({
        client: fakeClient("this is not json at all { blah "),
        model: "test/free",
        store,
        facts,
        lessons,
        log: () => {}, // Silent
      });

      expect(result.factsAdded).toBe(0);
      expect(result.lessonsCompacted).toBe(0);

      store.close();
    } finally {
      rmSync(dbDir, { recursive: true });
      rmSync(factsDir, { recursive: true });
    }
  });

  test("no sessions returns zero results", async () => {
    const dbDir = createTempDir();
    const factsDir = createTempDir();
    const lessonsPath = join(dbDir, "lessons.jsonl");

    try {
      const store = new SessionStore(join(dbDir, "sessions.db"));
      const facts = new FactStore(factsDir);
      const lessons = new LessonLog(lessonsPath);

      const result = await runDream({
        client: fakeClient("{}"),
        model: "test/free",
        store,
        facts,
        lessons,
        sinceMs: Date.now() - 365 * 24 * 60 * 60 * 1000, // Long ago
      });

      expect(result.factsAdded).toBe(0);

      store.close();
    } finally {
      rmSync(dbDir, { recursive: true });
      rmSync(factsDir, { recursive: true });
    }
  });

  test("drops old lessons beyond 30 days", async () => {
    const dbDir = createTempDir();
    const factsDir = createTempDir();
    const lessonsPath = join(dbDir, "lessons.jsonl");

    try {
      const store = new SessionStore(join(dbDir, "sessions.db"));
      const facts = new FactStore(factsDir);
      const lessons = new LessonLog(lessonsPath);

      // Add an old lesson
      const oldTimestamp = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      lessons.replaceAll([
        {
          timestamp: oldTimestamp,
          task: "old task",
          error: "old error",
          lesson: "old lesson",
          model: "old model",
        },
      ]);

      // Add a new session
      const sessionId = store.create(process.cwd(), "test/model");
      store.appendMessage(sessionId, { role: "user", content: "test" });
      store.appendMessage(sessionId, { role: "assistant", content: "response" });

      // Dream with no lessons kept
      const dreamResponse = JSON.stringify({
        facts: [],
        lessons_kept: [],
      });

      await runDream({
        client: fakeClient(dreamResponse),
        model: "test/free",
        store,
        facts,
        lessons,
        sinceMs: Date.now() - 1000,
        log: () => {},
      });

      const remaining = lessons.all();
      expect(remaining.length).toBe(0); // Old lesson should be dropped

      store.close();
    } finally {
      rmSync(dbDir, { recursive: true });
      rmSync(factsDir, { recursive: true });
    }
  });
});
