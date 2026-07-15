import { describe, it, expect } from "bun:test";
import { extractPositional, FLAGS_WITH_VALUE } from "../src/cli-args.ts";

describe("extractPositional", () => {
  it("keeps real prompt words", () => {
    expect(extractPositional(["fix", "the", "bug"])).toEqual(["fix", "the", "bug"]);
  });

  it("does NOT treat a value-flag's argument as a prompt word", () => {
    // the bug: `--preset freebee` launched a one-shot with the prompt "freebee"
    expect(extractPositional(["--preset", "freebee"])).toEqual([]);
    expect(extractPositional(["--preset", "freebee", "fix the bug"])).toEqual(["fix the bug"]);
    expect(extractPositional(["--model", "openrouter/free", "hello"])).toEqual(["hello"]);
    expect(extractPositional(["--provider", "openai", "hi"])).toEqual(["hi"]);
  });

  it("drops bare flags too", () => {
    expect(extractPositional(["-p", "--no-update", "do it"])).toEqual(["do it"]);
  });

  it("every value-taking flag is honored", () => {
    for (const flag of FLAGS_WITH_VALUE) {
      expect(extractPositional([flag, "VALUE"])).toEqual([]);
    }
  });
});
