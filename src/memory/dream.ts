import { estimateTokens } from "../core/tokens.ts";
import type { OpenRouterClient } from "../models/openrouter.ts";
import type { SessionStore } from "../session/store.ts";
import { FactStore } from "./facts.ts";
import { LessonLog, type Lesson } from "./lessons.ts";

interface DreamResult {
  factsAdded: number;
  lessonsCompacted: number;
}

interface DreamOptions {
  client: OpenRouterClient;
  model: string;
  store: SessionStore;
  facts: FactStore;
  lessons: LessonLog;
  /** Only consolidate sessions updated since this timestamp (ms). Default: 7 days ago. */
  sinceMs?: number;
  /** Optional log function for progress output. */
  log?: (line: string) => void;
}

/**
 * Offline consolidator: runs on a free model (costs $0).
 * Extracts durable facts and compacts lessons from recent sessions.
 */
export async function runDream(opts: DreamOptions): Promise<DreamResult> {
  const { client, model, store, facts, lessons, sinceMs, log } = opts;
  const logFn = log ?? (() => {});

  // Default: consolidate sessions from last 7 days
  const since = sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  logFn(`[dream] consolidating sessions since ${new Date(since).toISOString()}`);

  // Collect recent sessions
  const allSessions = store.list(undefined, 100); // Fetch recent sessions
  const recentSessions = allSessions.filter((s) => s.updatedAt >= since).slice(0, 20); // Limit to 20 for batch

  if (recentSessions.length === 0) {
    logFn("[dream] no recent sessions");
    return { factsAdded: 0, lessonsCompacted: 0 };
  }

  logFn(`[dream] processing ${recentSessions.length} sessions`);

  // Build transcripts for each session: compact format (user/assistant only, clipped results)
  const transcripts: string[] = [];
  let totalTranscriptTokens = 0;

  for (const session of recentSessions) {
    const messages = store.loadMessages(session.id);
    let transcript = `## Session: ${session.title || session.id}\n`;

    for (const msg of messages) {
      if (msg.role === "user") {
        transcript += `**User**: ${msg.content}\n\n`;
      } else if (msg.role === "assistant" && "content" in msg) {
        transcript += `**Assistant**: ${msg.content}\n\n`;
      }
      // Tool results: clipped to 100 chars
      if (msg.role === "tool") {
        const clipped = msg.content.slice(0, 100) + (msg.content.length > 100 ? "..." : "");
        transcript += `*[tool result: ${clipped}]*\n\n`;
      }
    }

    // Cap transcript at ~4000 tokens
    const transcriptTokens = estimateTokens(transcript);
    if (transcriptTokens > 4000) {
      transcript = transcript.slice(0, Math.floor((transcript.length * 4000) / transcriptTokens));
    }

    transcripts.push(transcript);
    totalTranscriptTokens += estimateTokens(transcript);
  }

  logFn(`[dream] ${transcripts.length} transcripts, ~${totalTranscriptTokens} tokens`);

  // Get current lessons (numbered, for the model to reference)
  const currentLessons = lessons.all();
  const lessonsList = currentLessons
    .map((l, i) => `${i + 1}. [${l.model}] ${l.lesson}`)
    .join("\n");

  // Batch transcripts into a prompt (up to ~12k tokens)
  const batchTranscripts = transcripts.slice(0, Math.min(transcripts.length, 3)).join("\n\n---\n\n");
  const promptTokens = estimateTokens(batchTranscripts) + estimateTokens(lessonsList) + 500; // overhead
  if (promptTokens > 12000) {
    logFn(`[dream] batch too large (${promptTokens} tokens); skipping batch consolidation`);
    return { factsAdded: 0, lessonsCompacted: 0 };
  }

  const prompt = `You are a memory consolidator. Analyze the following session transcripts and extract durable facts and lessons worth remembering across sessions.

Session transcripts:
${batchTranscripts}

Current lessons:
${lessonsList || "(none)"}

Extract AT MOST 5 new facts (user preferences, project conventions, recurring gotchas, model quirks) as strict JSON. Also indicate which lessons (by number) are still relevant. Drop lessons older than 30 days unless explicitly kept.

Respond with ONLY valid JSON (no markdown fence, no extra text):
{
  "facts": [
    { "title": "fact title", "body": "one or two sentences explaining the fact" }
  ],
  "lessons_kept": [1, 3, 5]
}`;

  logFn("[dream] calling model for consolidation...");

  // Stream the response
  let response = "";
  try {
    for await (const event of client.stream({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    })) {
      if (event.type === "text") {
        response += event.delta;
      }
    }
  } catch (e) {
    logFn(`[dream] model call failed: ${(e as Error).message}`);
    return { factsAdded: 0, lessonsCompacted: 0 };
  }

  logFn(`[dream] got response (${response.length} chars)`);

  // Parse JSON (tolerate fenced code blocks)
  let jsonText = response;
  const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1] ?? "";
  }

  interface DreamResponse {
    facts?: Array<{ title: string; body: string }>;
    lessons_kept?: number[];
  }

  let parsed: DreamResponse;
  try {
    parsed = JSON.parse(jsonText) as DreamResponse;
  } catch (e) {
    logFn(`[dream] failed to parse JSON: ${(e as Error).message}`);
    return { factsAdded: 0, lessonsCompacted: 0 };
  }

  // Add new facts
  let factsAdded = 0;
  if (parsed.facts && Array.isArray(parsed.facts)) {
    for (const fact of parsed.facts.slice(0, 5)) {
      if (fact.title && fact.body) {
        facts.addFact(fact.title, fact.body);
        factsAdded++;
        logFn(`[dream] + fact: ${fact.title}`);
      }
    }
  }

  // Consolidate lessons
  let lessonsCompacted = 0;
  if (parsed.lessons_kept && Array.isArray(parsed.lessons_kept)) {
    const keptIndexes = new Set(parsed.lessons_kept);
    const keptLessons: Lesson[] = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < currentLessons.length; i++) {
      const lesson = currentLessons[i];
      if (!lesson) continue; // Safety check
      // Keep if explicitly marked or recent (and not expired)
      if (keptIndexes.has(i + 1) || lesson.timestamp > thirtyDaysAgo) {
        keptLessons.push(lesson);
      } else {
        lessonsCompacted++;
        logFn(`[dream] - dropped old lesson: ${lesson.lesson.slice(0, 50)}...`);
      }
    }

    if (keptLessons.length !== currentLessons.length) {
      lessons.replaceAll(keptLessons);
    }
  }

  logFn(`[dream] done: ${factsAdded} facts added, ${lessonsCompacted} lessons dropped`);
  return { factsAdded, lessonsCompacted };
}
