/**
 * Personality system for Persoje.
 *
 * Controls how the agent communicates: tone, verbosity, work ethic,
 * formality, humor, and other behavioral traits.
 *
 * Stored in ~/.config/persoje/personality.json
 * Injected into the system prompt as behavioral instructions.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface Personality {
  /** Tone of voice: casual, professional, friendly, technical, mentor */
  tone: string;
  /** Verbosity: terse, concise, balanced, detailed, verbose */
  verbosity: string;
  /** Work ethic: relaxed, steady, driven, relentless */
  workEthic: string;
  /** Formality: informal, neutral, formal */
  formality: string;
  /** Humor: none, subtle, moderate, playful */
  humor: string;
  /** Code style: minimal, clean, documented, thorough */
  codeStyle: string;
  /** Explanation style: none, brief, standard, educational */
  explanations: string;
  /** Custom instructions (freeform) */
  custom: string;
}

const PERSONALITY_PATH = join(
  process.env.HOME ?? "",
  ".config",
  "persoje",
  "personality.json",
);

export const DEFAULT_PERSONALITY: Personality = {
  tone: "professional",
  verbosity: "concise",
  workEthic: "driven",
  formality: "neutral",
  humor: "subtle",
  codeStyle: "clean",
  explanations: "brief",
  custom: "",
};

export const PERSONALITY_OPTIONS: Record<keyof Omit<Personality, "custom">, string[]> = {
  tone: ["casual", "professional", "friendly", "technical", "mentor"],
  verbosity: ["terse", "concise", "balanced", "detailed", "verbose"],
  workEthic: ["relaxed", "steady", "driven", "relentless"],
  formality: ["informal", "neutral", "formal"],
  humor: ["none", "subtle", "moderate", "playful"],
  codeStyle: ["minimal", "clean", "documented", "thorough"],
  explanations: ["none", "brief", "standard", "educational"],
};

/** Load personality from disk, falling back to defaults. */
export function loadPersonality(): Personality {
  if (!existsSync(PERSONALITY_PATH)) return { ...DEFAULT_PERSONALITY };
  try {
    const raw = JSON.parse(readFileSync(PERSONALITY_PATH, "utf-8"));
    return { ...DEFAULT_PERSONALITY, ...raw };
  } catch {
    return { ...DEFAULT_PERSONALITY };
  }
}

/** Save personality to disk. */
export function savePersonality(p: Personality): void {
  mkdirSync(join(process.env.HOME ?? "", ".config", "persoje"), { recursive: true });
  writeFileSync(PERSONALITY_PATH, JSON.stringify(p, null, 2), "utf-8");
}

/** Generate the personality prompt injection for the system prompt. */
export function personalityPrompt(p: Personality): string {
  const lines: string[] = ["Personality & Communication Style:"];

  const toneMap: Record<string, string> = {
    casual: "Speak casually, like a colleague at a whiteboard. Contractions are fine.",
    professional: "Be professional and direct. Clear, efficient communication.",
    friendly: "Be warm and encouraging. Acknowledge progress and effort.",
    technical: "Be precise and technical. Use exact terminology. No hand-holding.",
    mentor: "Be a mentor: explain the 'why' behind decisions. Guide, don't just do.",
  };
  lines.push(`- Tone: ${toneMap[p.tone] ?? `Tone: ${p.tone}`}`);

  const verbMap: Record<string, string> = {
    terse: "Be terse. One-liners when possible. No filler words.",
    concise: "Be concise. Short paragraphs. Get to the point.",
    balanced: "Be balanced. Enough detail to be clear, not more.",
    detailed: "Be detailed. Explain your reasoning. Show your work.",
    verbose: "Be verbose. Full explanations with context and alternatives.",
  };
  lines.push(`- Verbosity: ${verbMap[p.verbosity] ?? `Verbosity: ${p.verbosity}`}`);

  const ethicMap: Record<string, string> = {
    relaxed: "Work at a relaxed pace. Suggest breaks. No urgency.",
    steady: "Steady progress. Methodical. One thing at a time.",
    driven: "Drive to completion. Push through obstacles. Ship it.",
    relentless: "Relentless. Never give up. Try every approach. The task WILL be done.",
  };
  lines.push(`- Work ethic: ${ethicMap[p.workEthic] ?? `Work ethic: ${p.workEthic}`}`);

  const formMap: Record<string, string> = {
    informal: "Use first person. Jokes are okay. Skip formalities.",
    neutral: "Neutral formality. Professional but approachable.",
    formal: "Use formal language. Third person. Structured responses.",
  };
  lines.push(`- Formality: ${formMap[p.formality] ?? `Formality: ${p.formality}`}`);

  const humorMap: Record<string, string> = {
    none: "No humor. Strictly business.",
    subtle: "Subtle wit is okay. Never at the user's expense.",
    moderate: "Light humor is fine. Keep it relevant and kind.",
    playful: "Be playful. Wordplay, analogies, personality. Still helpful.",
  };
  lines.push(`- Humor: ${humorMap[p.humor] ?? `Humor: ${p.humor}`}`);

  const codeMap: Record<string, string> = {
    minimal: "Write minimal code. No comments unless non-obvious. DRY to a fault.",
    clean: "Write clean code. Self-documenting names. Brief comments for 'why'.",
    documented: "Document thoroughly. JSDoc on every function. Explain design decisions.",
    thorough: "Thorough code: full docs, error handling, edge cases, types everywhere.",
  };
  lines.push(`- Code style: ${codeMap[p.codeStyle] ?? `Code style: ${p.codeStyle}`}`);

  const explMap: Record<string, string> = {
    none: "No explanations. Just code and results.",
    brief: "Brief explanations. One sentence per step.",
    standard: "Standard explanations. Why + what for each decision.",
    educational: "Educational. Explain concepts, alternatives, trade-offs. Teach.",
  };
  lines.push(`- Explanations: ${explMap[p.explanations] ?? `Explanations: ${p.explanations}`}`);

  if (p.custom) {
    lines.push(`- Custom: ${p.custom}`);
  }

  return lines.join("\n");
}

/** Format personality for display. */
export function formatPersonality(p: Personality): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(p)) {
    if (key === "custom") continue;
    const options = PERSONALITY_OPTIONS[key as keyof typeof PERSONALITY_OPTIONS];
    if (options) {
      lines.push(`  ${key.padEnd(12)} ${value}  (${options.join("/")})`);
    }
  }
  if (p.custom) {
    lines.push(`  custom       ${p.custom}`);
  }
  return lines.join("\n");
}
