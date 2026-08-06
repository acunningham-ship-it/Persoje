/**
 * MCP (Model Context Protocol) client for Persoje.
 *
 * Connects to MCP servers via stdio transport, discovers tools,
 * and wraps them as Persoje Tool instances for the agent loop.
 *
 * Config stored in ~/.config/persoje/mcp.json:
 * {
 *   "servers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *       "env": { ... }
 *     }
 *   }
 * }
 */

import { z } from "zod";
import { spawn, type Subprocess } from "bun";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, renameSync, fsyncSync, openSync } from "node:fs";
import { mkdirSync } from "node:fs";
import type { Tool, ToolContext } from "../tools/types.ts";

// ── MCP JSON-RPC types ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpListToolsResult {
  tools: McpToolDef[];
}

interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ── Config types ──

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

// PERSOJE_CONFIG_DIR overrides the base dir (tests point it at a tmp path so
// `bun test` never touches the user's real ~/.config/persoje/mcp.json — see
// vault task #13). Read lazily (a function, not a module-load-time const) so
// a test's beforeAll can set the env var before the first call.
function mcpConfigPath(): string {
  return join(process.env.PERSOJE_CONFIG_DIR || join(process.env.HOME ?? "", ".config", "persoje"), "mcp.json");
}

export function loadMcpConfig(): McpConfig {
  const path = mcpConfigPath();
  if (!existsSync(path)) return { servers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as McpConfig;
  } catch (error) {
    // Non-destructive: back up the corrupted file instead of silently discarding it.
    const backupPath = `${path}.corrupt.bak`;
    try {
      renameSync(path, backupPath);
      console.error(`[MCP] Corrupted mcp.json backed up to ${backupPath}. Falling back to empty config.`);
    } catch {
      console.error(`[MCP] Failed to parse mcp.json and could not back it up. Falling back to empty config.`);
    }
    return { servers: {} };
  }
}

export function saveMcpConfig(config: McpConfig): void {
  const path = mcpConfigPath();
  mkdirSync(dirname(path), { recursive: true });

  // Atomic write: write to temp file, fsync, then rename atomically.
  // This prevents corruption if the process crashes mid-write or concurrent
  // writes truncate the file. POSIX rename() is atomic.
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf-8");
    // Ensure data is written to disk before rename.
    const fd = openSync(tempPath, "r");
    fsyncSync(fd);
    fd; // suppress unused warning
    // Atomic rename: moves temp into place, clobbering any partial/corrupted file.
    renameSync(tempPath, path);
  } catch (error) {
    console.error(`[MCP] Failed to save config atomically: ${error}`);
    throw error;
  }
}

// ── MCP Server Connection (stdio transport) ──

export class McpConnection {
  private proc: Subprocess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private serverName: string;
  private config: McpServerConfig;
  private _tools: McpToolDef[] = [];
  private connected = false;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  get name(): string {
    return this.serverName;
  }

  get tools(): McpToolDef[] {
    return this._tools;
  }

  get isRunning(): boolean {
    return this.connected && this.proc !== null;
  }

  /** Start the MCP server process and initialize. */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.proc = spawn({
      cmd: [this.config.command, ...(this.config.args ?? [])],
      env: { ...process.env, ...this.config.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stdout line by line
    const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line) this.handleMessage(line);
          }
        }
      } catch {
        // Process exited
      }
    };
    readLoop();

    // Initialize
    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "persoje", version: "0.1.0" },
    });

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // Discover tools
    const listResult = await this.request("tools/list", {}) as McpListToolsResult;
    this._tools = listResult.tools ?? [];
    this.connected = true;
  }

  /** Call an MCP tool by name. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    }) as McpCallToolResult;

    const text = (result.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");

    if (result.isError) {
      throw new Error(`MCP tool error: ${text}`);
    }
    return text;
  }

  /** Disconnect from the MCP server. */
  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error("disconnected"));
    }
    this.pending.clear();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const stdin = this.proc?.stdin;
      if (stdin && typeof stdin !== "number") {
        (stdin as { write: (d: string) => unknown }).write(JSON.stringify(msg) + "\n");
      }
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private notify(method: string, params: unknown): void {
    const msg = { jsonrpc: "2.0", method, params };
    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number") {
      (stdin as { write: (d: string) => unknown }).write(JSON.stringify(msg) + "\n");
    }
  }

  private handleMessage(line: string): void {
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // Ignore non-JSON or notifications
    }
  }
}

// ── MCP Manager ──

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private config: McpConfig;

  constructor() {
    this.config = loadMcpConfig();
  }

  /** List configured servers. */
  listServers(): Record<string, McpServerConfig> {
    return this.config.servers;
  }

  /** Add a new MCP server config. */
  addServer(name: string, serverConfig: McpServerConfig): void {
    this.config.servers[name] = serverConfig;
    saveMcpConfig(this.config);
  }

  /** Remove an MCP server. */
  removeServer(name: string): boolean {
    if (!this.config.servers[name]) return false;
    delete this.config.servers[name];
    saveMcpConfig(this.config);
    const conn = this.connections.get(name);
    if (conn) {
      conn.disconnect();
      this.connections.delete(name);
    }
    return true;
  }

  /** Connect to a specific server. */
  async connect(name: string): Promise<McpConnection> {
    const existing = this.connections.get(name);
    if (existing?.isRunning) return existing;

    const serverConfig = this.config.servers[name];
    if (!serverConfig) throw new Error(`MCP server "${name}" not configured`);

    const conn = new McpConnection(name, serverConfig);
    await conn.connect();
    this.connections.set(name, conn);
    return conn;
  }

  /** Connect all configured servers. */
  async connectAll(): Promise<McpConnection[]> {
    const results: McpConnection[] = [];
    for (const name of Object.keys(this.config.servers)) {
      try {
        results.push(await this.connect(name));
      } catch (e) {
        // Log but don't fail — MCP servers are optional
        console.error(`MCP: failed to connect "${name}": ${(e as Error).message}`);
      }
    }
    return results;
  }

  /** Get all discovered tools from all connected servers, wrapped as Persoje Tools. */
  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [, conn] of this.connections) {
      if (!conn.isRunning) continue;
      for (const toolDef of conn.tools) {
        tools.push(this.wrapTool(conn, toolDef));
      }
    }
    return tools;
  }

  /** Get tool names for display. */
  getToolNames(): string[] {
    return this.getTools().map((t) => t.name);
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    for (const [, conn] of this.connections) {
      await conn.disconnect();
    }
    this.connections.clear();
  }

  /** Wrap an MCP tool definition as a Persoje Tool. */
  private wrapTool(conn: McpConnection, toolDef: McpToolDef): Tool {
    const serverName = conn.name;
    const mcpName = toolDef.name;
    // Prefix with server name to avoid collisions
    const fullName = `mcp_${serverName}_${mcpName}`;

    // Convert JSON Schema to Zod schema (best-effort)
    const args = this.schemaToZod(toolDef.inputSchema);

    return {
      name: fullName,
      description: toolDef.description ?? `MCP tool: ${mcpName} (from ${serverName})`,
      args,
      maxResultTokens: 8000,
      execute: async (parsedArgs: unknown, _ctx: ToolContext): Promise<string> => {
        return conn.callTool(mcpName, parsedArgs as Record<string, unknown>);
      },
    };
  }

  /** Best-effort JSON Schema → Zod conversion. */
  private schemaToZod(schema: Record<string, unknown>): z.ZodType {
    if (!schema || !schema.properties) {
      return z.object({}).passthrough();
    }

    const props = schema.properties as Record<string, Record<string, unknown>>;
    const required = new Set(schema.required as string[] ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(props)) {
      let field: z.ZodTypeAny;
      switch (prop.type) {
        case "string":
          field = z.string();
          break;
        case "number":
          field = z.number();
          break;
        case "integer":
          field = z.number().int();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.any());
          break;
        case "object":
          field = z.record(z.string(), z.any());
          break;
        default:
          field = z.any();
      }
      if (prop.description && typeof prop.description === "string") {
        field = field.describe(prop.description);
      }
      if (!required.has(key)) {
        field = field.optional();
      }
      shape[key] = field;
    }

    return z.object(shape).passthrough();
  }
}
