import type { FileDiffMetadata } from '@pierre/diffs';

// LRU cap measured in UTF-16 chars (~2 bytes per char in V8). 50M chars
// ≈ 100MB JS heap budget. A single oversize entry is still cached (the
// user is looking at it now); next insert evicts.
const DEFAULT_MAX_CHARS = 50 * 1024 * 1024;

const measureFileDiff = (diff: FileDiffMetadata): number => {
  let size = 0;
  for (const line of diff.additionLines) {
    size += line.length;
  }
  for (const line of diff.deletionLines) {
    size += line.length;
  }
  if (diff.intraLineRanges) {
    // Each IntraLineRange { start, end } is two numbers; bucket entry per
    // line is small relative to the file content but worth accounting for
    // on huge diffs that may carry thousands of ranges.
    const accountRanges = (buckets?: Record<number, ReadonlyArray<unknown>>) => {
      if (!buckets) {
        return;
      }
      for (const ranges of Object.values(buckets)) {
        size += ranges.length * 16;
      }
    };
    accountRanges(diff.intraLineRanges.additions);
    accountRanges(diff.intraLineRanges.deletions);
  }
  return size;
};

export class ParsedDiffCache {
  private cache = new Map<string, FileDiffMetadata>();
  private sizes = new Map<string, number>();
  private totalChars = 0;
  private readonly maxChars: number;

  constructor(maxChars = DEFAULT_MAX_CHARS) {
    this.maxChars = maxChars;
  }

  get(key: string): FileDiffMetadata | undefined {
    const cached = this.cache.get(key);
    if (cached) {
      // LRU touch via re-insert (Map preserves insertion order).
      this.cache.delete(key);
      this.cache.set(key, cached);
    }
    return cached;
  }

  set(key: string, diff: FileDiffMetadata): void {
    if (this.cache.has(key)) {
      this.evict(key);
    }
    const size = measureFileDiff(diff);
    this.cache.set(key, diff);
    this.sizes.set(key, size);
    this.totalChars += size;
    while (this.totalChars > this.maxChars && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.evict(oldestKey);
    }
  }

  evict(key: string): void {
    this.totalChars -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    this.cache.delete(key);
  }

  pruneByPrefix(livePrefixes: ReadonlySet<string>): void {
    const stale: Array<string> = [];
    for (const key of this.cache.keys()) {
      const firstColon = key.indexOf(':');
      if (firstColon === -1) {
        continue;
      }
      const secondColon = key.indexOf(':', firstColon + 1);
      if (secondColon === -1) {
        continue;
      }
      if (!livePrefixes.has(key.slice(0, secondColon))) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      this.evict(key);
    }
  }

  size(): number {
    return this.cache.size;
  }

  charTotal(): number {
    return this.totalChars;
  }
}
