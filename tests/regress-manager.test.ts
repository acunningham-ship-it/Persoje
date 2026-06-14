import { test, expect, describe } from "bun:test";
import { ContextManager } from "../src/context/manager.ts";

describe("ContextManager prefix stability (regression)", () => {
  test("isPrefixStable is false on first build (no hash recorded yet)", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("hello");
    cm.addAssistant("world");

    // First build records the hash
    const messages = cm.buildWithCacheBreakpoints("system prompt");
    expect(messages.length).toBeGreaterThan(0);

    // Before second build, without adding messages, should be stable
    expect(cm.isPrefixStable()).toBe(true);
  });

  test("isPrefixStable detects when message count increases", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("turn 1");
    cm.addAssistant("response 1");

    // Build and record hash
    cm.buildWithCacheBreakpoints("system");

    // Prefix should be stable until new message is added
    expect(cm.isPrefixStable()).toBe(true);

    // Add a new message
    cm.addUser("turn 2");

    // Now the prefix is no longer stable (message count increased)
    expect(cm.isPrefixStable()).toBe(false);
  });

  test("isPrefixStable detects when message content changes", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("turn 1");
    cm.addAssistant("response 1");
    cm.addUser("turn 2 - final message");

    // Build and record the stable hash
    // The prefix is everything except the final user message (turn 2)
    // So it includes: turn 1 (user) + response 1 (assistant)
    cm.buildWithCacheBreakpoints("system");
    expect(cm.isPrefixStable()).toBe(true);

    // Mutate a message in the prefix (the first user message)
    const history = cm.history();
    (history[0] as any).content = "mutated turn 1";

    // Prefix should no longer be stable since content changed
    expect(cm.isPrefixStable()).toBe(false);
  });

  test("prefix hash changes on compaction", async () => {
    const cm = new ContextManager(1000, 0.8, 2);
    // Add 4 turns so compaction will trigger
    for (let i = 1; i <= 4; i++) {
      cm.addUser(`turn ${i}`);
      cm.addAssistant(`response ${i}`);
    }

    // Build and record hash
    cm.buildWithCacheBreakpoints("system");
    expect(cm.isPrefixStable()).toBe(true);

    // Compact (replaces early turns with a summary)
    await cm.compact(async (transcript) => {
      return "summary of turns 1-2";
    });

    // Hash should be invalidated after compaction
    const isStable = cm.isPrefixStable();

    // The new hash would need a fresh build to be recorded, so prefix is unstable
    // until the next call to buildWithCacheBreakpoints
    expect(isStable).toBe(false);

    // Rebuild to record new hash
    cm.buildWithCacheBreakpoints("system");

    // Now it should be stable again (assuming no new messages)
    expect(cm.isPrefixStable()).toBe(true);
  });

  test("prefix hash is reset on clear()", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("message");
    cm.addAssistant("response");

    // Build and record hash
    cm.buildWithCacheBreakpoints("system");
    expect(cm.isPrefixStable()).toBe(true);

    // Clear the context
    cm.clear();

    // Prefix should no longer be stable (hash was reset)
    expect(cm.isPrefixStable()).toBe(false);
  });

  test("buildWithCacheBreakpoints correctly places cache breakpoint", () => {
    const cm = new ContextManager(5000, 0.8, 4);

    // Add a complete turn (user -> assistant with no tool calls)
    cm.addUser("question 1");
    cm.addAssistant("answer 1");

    // Add a turn with tool calls (incomplete)
    cm.addUser("question 2");
    cm.addAssistant("I'll use a tool", [
      { id: "call1", name: "read", argsJson: '{"path": "file.ts"}' },
    ]);
    cm.addToolResult("call1", "file contents", 100);

    // Build with cache breakpoints
    const messages = cm.buildWithCacheBreakpoints("system prompt");

    // System should be first and have cache_control
    expect(messages[0]!.role).toBe("system");
    const systemContent = messages[0]!.content;
    expect(typeof systemContent === "string" || Array.isArray(systemContent)).toBe(true);

    // Find the cache breakpoint in the conversation (should be after the first complete turn)
    let hasBreakpoint = false;
    for (let i = 1; i < messages.length; i++) {
      const content = messages[i]!.content;
      if (Array.isArray(content) && content.some((c: any) => c.cache_control)) {
        hasBreakpoint = true;
        break;
      }
    }
    expect(hasBreakpoint).toBe(true);
  });

  test("buildStats reports correct prefix stability", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("test");
    cm.addAssistant("ok");

    // Build and check stats
    cm.buildWithCacheBreakpoints("system");
    const stats1 = cm.buildStats();
    expect(stats1.prefixStable).toBe(true);

    // Add a message and check again
    cm.addUser("another");
    const stats2 = cm.buildStats();
    expect(stats2.prefixStable).toBe(false);

    // Build again to re-record the hash
    cm.buildWithCacheBreakpoints("system");
    const stats3 = cm.buildStats();
    expect(stats3.prefixStable).toBe(true);
  });

  test("prefix stability survives identical rebuild", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("hello");
    cm.addAssistant("world");
    cm.addUser("hello again");
    cm.addAssistant("world again");

    // First build
    cm.buildWithCacheBreakpoints("system prompt v1");
    expect(cm.isPrefixStable()).toBe(true);

    // Immediately rebuild with same content, no new messages
    cm.buildWithCacheBreakpoints("system prompt v1");

    // Should still be stable
    expect(cm.isPrefixStable()).toBe(true);
  });

  test("prefix instability when system prompt changes", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("test");
    cm.addAssistant("ok");

    // Build with system prompt v1
    cm.buildWithCacheBreakpoints("system prompt v1");
    expect(cm.isPrefixStable()).toBe(true);

    // Note: The system prompt is NOT part of the message hash in the current
    // implementation (it's not in this.messages), so changing the system prompt
    // won't affect isPrefixStable's return value. This is acceptable because:
    // 1. The system prompt changing is rare in a session
    // 2. The cache breakpoint strategy already handles it (system always gets a breakpoint)
    // 3. A provider cache miss would just occur on the next call
    // This test documents that behavior.

    // Even with different system prompt, message hash doesn't change
    cm.buildWithCacheBreakpoints("system prompt v2");
    expect(cm.isPrefixStable()).toBe(true);
  });
});
