/**
 * Per-session read deduplication: track files by path+mtime.
 * On re-read, if unchanged, return a marker instead of the full content.
 * If changed, show a diff instead of the full file (if diff is small enough).
 * This is the persoje port of the read-once hook concept.
 */

interface CacheEntry {
  mtime: number;
  content: string;
}

export class ReadCache {
  private cache = new Map<string, CacheEntry>();

  /** Check cache status for a file. Returns 'unchanged' | 'changed' | 'new'. */
  checkStatus(filePath: string, currentMtime: number): "unchanged" | "changed" | "new" {
    const cached = this.cache.get(filePath);
    if (!cached) return "new";
    if (cached.mtime === currentMtime) return "unchanged";
    return "changed";
  }

  /** Get the diff between cached and current content. Returns null if diff is too large. */
  getDiff(oldContent: string, newContent: string, maxLines = 40): string | null {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");

    // Simple unified diff: compute LCS-like diff (line-based).
    // For now, use a basic approach: show added/removed lines.
    const diff: string[] = [];
    const maxOldIdx = oldLines.length;
    const maxNewIdx = newLines.length;

    // Naive diff: show common prefix, then diffs, then common suffix.
    let i = 0;
    while (i < maxOldIdx && i < maxNewIdx && oldLines[i] === newLines[i]) i++;
    const commonPrefix = i;

    let j = 1;
    while (
      j <= maxOldIdx &&
      j <= maxNewIdx &&
      oldLines[maxOldIdx - j] === newLines[maxNewIdx - j]
    ) {
      j++;
    }
    const commonSuffix = j - 1;

    const diffStart = commonPrefix;
    const diffEndOld = maxOldIdx - commonSuffix;
    const diffEndNew = maxNewIdx - commonSuffix;

    // Show unified diff format (basic).
    diff.push(`@@ -${diffStart + 1},${Math.max(diffEndOld - diffStart, 0)} +${diffStart + 1},${Math.max(diffEndNew - diffStart, 0)} @@`);

    for (let k = diffStart; k < diffEndOld; k++) {
      diff.push(`-${oldLines[k]}`);
    }
    for (let k = diffStart; k < diffEndNew; k++) {
      diff.push(`+${newLines[k]}`);
    }

    const diffLines = diff.length;
    if (diffLines > maxLines) return null; // Diff too large, fall back to full read.

    return diff.join("\n");
  }

  /** Record a file read in the cache. */
  record(filePath: string, mtime: number, content: string): void {
    this.cache.set(filePath, { mtime, content });
  }

  /** Get cached content for a file (used when computing diff). */
  getCachedContent(filePath: string): string | undefined {
    return this.cache.get(filePath)?.content;
  }

  /** Clear the cache (for testing or on session reset). */
  clear(): void {
    this.cache.clear();
  }
}
