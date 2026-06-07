import type { OpenRouterClient, ToolSchema, StreamEvent } from "../models/openrouter";
import { rescueToolCalls } from "../guardrails/rescue";
import type { ToolQuality } from "./router";

/**
 * Smoke test a model's tool-calling ability with minimal overhead (~600 tokens total).
 * Returns score (0–3) and diagnostic notes. Catches native tool calls and text-embedded rescues.
 */
export async function runCanary(
  client: OpenRouterClient,
  modelId: string,
): Promise<{ score: number; total: number; notes: string[] }> {
  const notes: string[] = [];
  let score = 0;
  const total = 3;

  // Test 1: native tool call
  try {
    score += await testNativeToolCall(client, modelId, notes);
  } catch (e) {
    notes.push(`Test 1 error: ${(e as Error).message}`);
  }

  // Test 2: argument fidelity
  try {
    score += await testArgFidelity(client, modelId, notes);
  } catch (e) {
    notes.push(`Test 2 error: ${(e as Error).message}`);
  }

  // Test 3: hallucination resistance
  try {
    score += await testHallucinationResistance(client, modelId, notes);
  } catch (e) {
    notes.push(`Test 3 error: ${(e as Error).message}`);
  }

  return { score, total, notes };
}

/**
 * Test 1: Does the model emit a native tool call for a simple request?
 * Pass: tool-calls event with "echo" and argsJson containing "ping".
 * Half-pass: text response with rescued tool call.
 * Fail: no tool call or wrong name.
 */
async function testNativeToolCall(
  client: OpenRouterClient,
  modelId: string,
  notes: string[],
): Promise<number> {
  const echoSchema: ToolSchema = {
    type: "function",
    function: {
      name: "echo",
      description: "Repeat text back to the user",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  };

  const events: StreamEvent[] = [];
  let textContent = "";

  try {
    for await (const event of client.stream({
      model: modelId,
      messages: [{ role: "user", content: "Call the echo tool with text set to exactly 'ping'." }],
      tools: [echoSchema],
      temperature: 0,
      maxTokens: 150,
    })) {
      events.push(event);
      if (event.type === "text") textContent += event.delta;
    }
  } catch (e) {
    notes.push(`Test 1: API error: ${(e as Error).message}`);
    return 0;
  }

  const toolEvent = events.find((e) => e.type === "tool-calls");
  if (toolEvent && toolEvent.type === "tool-calls") {
    const call = toolEvent.calls.find((c) => c.name === "echo" && c.argsJson.includes("ping"));
    if (call) {
      notes.push("Test 1: native tool call ✓");
      return 1;
    }
  }

  // Try rescue
  const { calls } = rescueToolCalls(textContent, ["echo"]);
  const rescued = calls.find((c) => c.name === "echo" && c.argsJson.includes("ping"));
  if (rescued) {
    notes.push("Test 1: rescued tool call (0.5)");
    return 0.5;
  }

  notes.push("Test 1: no valid tool call");
  return 0;
}

/**
 * Test 2: Can the model extract and include a specific argument value?
 * Pass: tool call "read" with argsJson containing "/tmp/canary.txt".
 */
async function testArgFidelity(
  client: OpenRouterClient,
  modelId: string,
  notes: string[],
): Promise<number> {
  const readSchema: ToolSchema = {
    type: "function",
    function: {
      name: "read",
      description: "Read a file and return its contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  };

  const events: StreamEvent[] = [];
  let textContent = "";

  try {
    for await (const event of client.stream({
      model: modelId,
      messages: [{ role: "user", content: "Read the file /tmp/canary.txt" }],
      tools: [readSchema],
      temperature: 0,
      maxTokens: 150,
    })) {
      events.push(event);
      if (event.type === "text") textContent += event.delta;
    }
  } catch (e) {
    notes.push(`Test 2: API error: ${(e as Error).message}`);
    return 0;
  }

  const toolEvent = events.find((e) => e.type === "tool-calls");
  if (toolEvent && toolEvent.type === "tool-calls") {
    const call = toolEvent.calls.find((c) => c.name === "read" && c.argsJson.includes("/tmp/canary.txt"));
    if (call) {
      notes.push("Test 2: arg fidelity ✓");
      return 1;
    }
  }

  // Try rescue
  const { calls } = rescueToolCalls(textContent, ["read"]);
  const rescued = calls.find((c) => c.name === "read" && c.argsJson.includes("/tmp/canary.txt"));
  if (rescued) {
    notes.push("Test 2: arg fidelity (rescued)");
    return 1;
  }

  notes.push("Test 2: bad or missing args");
  return 0;
}

/**
 * Test 3: Does the model avoid hallucinating capabilities?
 * Request: "Send an email... If you cannot, reply with exactly: CANNOT"
 * Pass: NO tool call at all, OR text contains CANNOT, OR tool call is only "echo" (expected to fail).
 * Fail: invokes a non-existent tool or invents "email" capability.
 */
async function testHallucinationResistance(
  client: OpenRouterClient,
  modelId: string,
  notes: string[],
): Promise<number> {
  const echoSchema: ToolSchema = {
    type: "function",
    function: {
      name: "echo",
      description: "Repeat text back to the user",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  };

  const events: StreamEvent[] = [];
  let textContent = "";

  try {
    for await (const event of client.stream({
      model: modelId,
      messages: [
        {
          role: "user",
          content:
            "Send an email to bob@example.com. If you cannot do this with your available tools, reply with exactly: CANNOT",
        },
      ],
      tools: [echoSchema],
      temperature: 0,
      maxTokens: 150,
    })) {
      events.push(event);
      if (event.type === "text") textContent += event.delta;
    }
  } catch (e) {
    notes.push(`Test 3: API error: ${(e as Error).message}`);
    return 0;
  }

  const toolEvent = events.find((e) => e.type === "tool-calls");
  const toolNames = toolEvent && toolEvent.type === "tool-calls" ? toolEvent.calls.map((c) => c.name) : [];

  // Pass if: no tool call, or CANNOT in text, or only "echo" was called
  if (toolNames.length === 0 || textContent.includes("CANNOT") || (toolNames.length === 1 && toolNames[0] === "echo")) {
    notes.push("Test 3: hallucination resistance ✓");
    return 1;
  }

  // Fail if tool call with non-existent name (e.g., "email", "send_email")
  for (const name of toolNames) {
    if (name !== "echo") {
      notes.push(`Test 3: invented capability "${name}"`);
      return 0;
    }
  }

  notes.push("Test 3: unexpected response");
  return 0;
}

/**
 * Convert canary score to quality rating.
 * ≥2.5: good, ≥1.5: variable, else: poor.
 */
export function qualityFromScore(score: number): ToolQuality {
  if (score >= 2.5) return "good";
  if (score >= 1.5) return "variable";
  return "poor";
}
