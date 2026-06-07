import { extname } from "node:path";

/**
 * Post-edit syntax verification: catches a weak model leaving a file broken.
 * Best-effort and fast — returns an error description, or null when the file
 * parses (or we have no checker for the language).
 */
export async function postEditCheck(absPath: string): Promise<string | null> {
  const ext = extname(absPath);
  try {
    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
      const code = await Bun.file(absPath).text();
      const loader = ext === ".ts" ? "ts" : ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : "js";
      new Bun.Transpiler({ loader }).transformSync(code);
      return null;
    }
    if (ext === ".py") {
      const proc = Bun.spawn(["python3", "-m", "py_compile", absPath], { stdout: "ignore", stderr: "pipe" });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return exitCode === 0 ? null : stderr.split("\n").slice(-4).join("\n").trim();
    }
    if (ext === ".json") {
      JSON.parse(await Bun.file(absPath).text());
      return null;
    }
    return null; // no checker for this language
  } catch (e) {
    const msg = (e as Error).message;
    // Transpiler errors include position info; keep it short.
    return msg.split("\n").slice(0, 4).join("\n");
  }
}
