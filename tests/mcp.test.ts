import { describe, it, expect } from "bun:test";
import { McpManager, loadMcpConfig, saveMcpConfig, type McpConfig } from "../src/mcp/client.ts";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MCP_TEST_PATH = join(process.env.HOME ?? "", ".config", "persoje", "mcp.json");

describe("MCP config", () => {
  it("loads empty config when file doesn't exist", () => {
    // Temporarily rename if exists
    let backup: string | null = null;
    if (existsSync(MCP_TEST_PATH)) {
      backup = readFileSync(MCP_TEST_PATH, "utf-8");
      unlinkSync(MCP_TEST_PATH);
    }
    const config = loadMcpConfig();
    expect(config.servers).toEqual({});
    // Restore
    if (backup) writeFileSync(MCP_TEST_PATH, backup, "utf-8");
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
    // Cleanup
    if (existsSync(MCP_TEST_PATH)) unlinkSync(MCP_TEST_PATH);
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

    // Cleanup
    if (existsSync(MCP_TEST_PATH)) unlinkSync(MCP_TEST_PATH);
    if (existsSync(backupPath)) unlinkSync(backupPath);
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

// Need these for the backup/restore in the first test
import { readFileSync, writeFileSync } from "node:fs";
