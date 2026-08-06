import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, loadMcpConfig, saveMcpConfig, type McpConfig } from "../src/mcp/client.ts";

// Isolated from the user's real ~/.config/persoje/ — mcp/client.ts reads
// PERSOJE_CONFIG_DIR lazily (at call time, inside loadMcpConfig/saveMcpConfig),
// not at import time, so setting it in beforeAll below is enough even though
// the import above already resolved. Without this, `bun test` read/wrote/
// deleted the user's real mcp.json, and concurrent runs raced on it (vault
// task #13 — the literal source of the "Corrupted mcp.json backed up" surprise
// seen during concurrent test runs).
let TEST_DIR: string;
let MCP_TEST_PATH: string;

beforeAll(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "persoje-test-mcp-"));
  process.env.PERSOJE_CONFIG_DIR = TEST_DIR;
  MCP_TEST_PATH = join(TEST_DIR, "mcp.json");
});

afterAll(() => {
  delete process.env.PERSOJE_CONFIG_DIR;
  if (TEST_DIR) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("MCP config", () => {
  beforeEach(() => {
    if (existsSync(MCP_TEST_PATH)) rmSync(MCP_TEST_PATH);
  });

  it("loads empty config when file doesn't exist", () => {
    const config = loadMcpConfig();
    expect(config.servers).toEqual({});
  });

  it("saves and loads config", () => {
    const config: McpConfig = {
      servers: {
        "test-server": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
    };
    saveMcpConfig(config);
    const loaded = loadMcpConfig();
    expect(loaded.servers["test-server"]).toBeDefined();
    expect(loaded.servers["test-server"]!.command).toBe("npx");
  });

  it("backs up corrupted config and does not clobber backup on save", () => {
    // Save a good config first
    const goodConfig: McpConfig = {
      servers: {
        "keep-me": { command: "echo", args: ["safe"] },
      },
    };
    saveMcpConfig(goodConfig);

    // Corrupt the file by truncating it
    writeFileSync(MCP_TEST_PATH, '{"servers":{"test":', "utf-8");

    // Load should back up the corrupt file
    const loaded = loadMcpConfig();
    expect(loaded.servers).toEqual({});

    // Verify backup exists
    const backupPath = `${MCP_TEST_PATH}.corrupt.bak`;
    expect(existsSync(backupPath)).toBe(true);
    const backupContent = readFileSync(backupPath, "utf-8");
    expect(backupContent).toContain("test");

    // Save a new config — should not clobber the backup
    saveMcpConfig({ servers: { "new-server": { command: "true" } } });

    // Backup should still exist and be unchanged
    expect(existsSync(backupPath)).toBe(true);
    const backupAfter = readFileSync(backupPath, "utf-8");
    expect(backupAfter).toBe(backupContent);
  });
});

describe("McpManager", () => {
  it("lists servers from config", () => {
    const manager = new McpManager();
    const servers = manager.listServers();
    expect(typeof servers).toBe("object");
  });

  it("adds and removes servers", () => {
    const manager = new McpManager();
    manager.addServer("test", { command: "echo", args: ["hello"] });
    expect(manager.listServers()["test"]).toBeDefined();
    expect(manager.removeServer("test")).toBe(true);
    expect(manager.listServers()["test"]).toBeUndefined();
  });

  it("returns empty tools when no servers connected", () => {
    const manager = new McpManager();
    expect(manager.getTools()).toHaveLength(0);
    expect(manager.getToolNames()).toHaveLength(0);
  });
});
