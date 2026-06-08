export type DiffLine = { sign: "-" | "+" | " "; text: string };

/**
 * A compact diff of an edit, built from the tool's own old/new strings — so the
 * user sees exactly what changed inline, at zero token cost (this never touches
 * the model's context). Common leading/trailing lines are trimmed so only the
 * changed region shows; the result is capped with a "… N more" marker.
 */
export function editDiffLines(oldStr: string, newStr: string, max = 8): DiffLine[] {
  const o = oldStr.split("\n");
  const n = newStr.split("\n");
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let endO = o.length;
  let endN = n.length;
  while (endO > start && endN > start && o[endO - 1] === n[endN - 1]) {
    endO--;
    endN--;
  }
  const out: DiffLine[] = [];
  for (let i = start; i < endO; i++) out.push({ sign: "-", text: o[i]! });
  for (let i = start; i < endN; i++) out.push({ sign: "+", text: n[i]! });
  if (out.length > max) {
    const head = out.slice(0, max);
    head.push({ sign: " ", text: `… ${out.length - max} more line(s)` });
    return head;
  }
  return out;
}
