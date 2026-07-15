/**
 * CLI argument helpers, kept pure + separate from cli.ts so they're testable
 * (importing cli.ts runs main()).
 */

/** Flags that consume the following token as their value — so it is NOT a positional prompt word. */
export const FLAGS_WITH_VALUE = new Set(["--model", "--provider", "--preset", "--resume"]);

/**
 * The positional prompt words: everything that isn't a flag and isn't the value
 * of a value-taking flag. `persoje --preset freebee "fix the bug"` → ["fix the bug"],
 * NOT ["freebee", "fix the bug"].
 */
export function extractPositional(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith("-") && !FLAGS_WITH_VALUE.has(args[i - 1] ?? ""));
}
