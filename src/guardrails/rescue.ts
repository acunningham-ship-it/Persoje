import type { ToolCallRequest } from "../models/openrouter.ts";
import { randomUUID } from "node:crypto";

/**
 * Text-embedded tool-call rescue: weak models often emit tool calls as text
 * instead of native tool_calls. Recognizes the common dialects:
 *   - Hermes/Qwen:   <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   - Fenced JSON:   ```json\n{"name": "...", "arguments": {...}}\n```
 *   - Bare JSON:     {"name": "...", "arguments": {...}} as the entire message
 * Returns rescued calls and the text with the call blocks stripped.
 */
export function rescueToolCalls(
  text: string,
  availableTools: string[],
): { calls: ToolCallRequest[]; cleanedText: string } {
  const calls: ToolCallRequest[] = [];
  let cleaned = text;

  const tryParse = (raw: string): boolean => {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    const name = parsed?.name ?? parsed?.tool ?? parsed?.tool_name ?? parsed?.function?.name;
    const args = parsed?.arguments ?? parsed?.args ?? parsed?.parameters ?? parsed?.function?.arguments ?? {};
    if (typeof name !== "string" || !name) return false;
    if (!availableTools.includes(name) && !availableTools.some((t) => name.includes(t))) return false;
    calls.push({
      id: `rescued_${randomUUID()}`,
      name,
      argsJson: typeof args === "string" ? args : JSON.stringify(args),
    });
    return true;
  };

  // 1. <tool_call>…</tool_call> blocks (also <toolcall>, <function_call>)
  const tagPattern = /<(tool_call|toolcall|function_call)>\s*([\s\S]*?)\s*<\/\1>/gi;
  cleaned = cleaned.replace(tagPattern, (match, _tag, body) => (tryParse(body) ? "" : match));

  // 2. fenced ```json blocks
  if (calls.length === 0) {
    const fencePattern = /```(?:json|tool_call)?\s*\n([\s\S]*?)\n```/g;
    cleaned = cleaned.replace(fencePattern, (match, body) => {
      const trimmed = body.trim();
      return trimmed.startsWith("{") && tryParse(trimmed) ? "" : match;
    });
  }

  // 3. the entire message is one JSON object
  if (calls.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}") && tryParse(trimmed)) cleaned = "";
  }

  return { calls, cleanedText: cleaned.trim() };
}
