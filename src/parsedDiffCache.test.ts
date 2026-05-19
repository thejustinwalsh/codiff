import type { FileDiffMetadata } from '@pierre/diffs';
import { expect, test } from 'vite-plus/test';
import { ParsedDiffCache } from './parsedDiffCache.ts';

const diff = (additionLines: ReadonlyArray<string>, deletionLines: ReadonlyArray<string> = []) =>
  ({
    additionLines: [...additionLines],
    cacheKey: 'k',
    deletionLines: [...deletionLines],
    hunks: [],
    isPartial: false,
    name: 'a.ts',
    splitLineCount: 0,
    type: 'change',
    unifiedLineCount: 0,
  }) as unknown as FileDiffMetadata;

test('ParsedDiffCache stores and retrieves entries', () => {
  const cache = new ParsedDiffCache();
  const a = diff(['hello\n']);
  cache.set('a', a);
  expect(cache.get('a')).toBe(a);
});

test('ParsedDiffCache evicts oldest entry when cap exceeded', () => {
  const cache = new ParsedDiffCache(10);
  cache.set('a', diff(['1234567890']));
  cache.set('b', diff(['ab']));
  // Total now 12 > 10 → oldest (a) evicted.
  expect(cache.get('a')).toBeUndefined();
  expect(cache.get('b')).not.toBeUndefined();
});

test('ParsedDiffCache get() marks an entry most-recently-used (LRU touch)', () => {
  const cache = new ParsedDiffCache(10);
  cache.set('a', diff(['12345']));
  cache.set('b', diff(['67']));
  // a touched → b is now oldest
  cache.get('a');
  cache.set('c', diff(['89012']));
  expect(cache.get('a')).not.toBeUndefined();
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('c')).not.toBeUndefined();
});

test('ParsedDiffCache keeps a single oversize entry (transient overshoot)', () => {
  const cache = new ParsedDiffCache(5);
  const huge = diff(['a'.repeat(20)]);
  cache.set('big', huge);
  expect(cache.get('big')).toBe(huge);
});

test('ParsedDiffCache pruneByPrefix drops entries whose fingerprint:section prefix isnt live', () => {
  const cache = new ParsedDiffCache();
  cache.set('fp1:sec1:rest', diff(['x']));
  cache.set('fp2:sec2:rest', diff(['y']));
  cache.set('fp3:sec3:other', diff(['z']));
  cache.pruneByPrefix(new Set(['fp1:sec1', 'fp3:sec3']));
  expect(cache.get('fp1:sec1:rest')).not.toBeUndefined();
  expect(cache.get('fp2:sec2:rest')).toBeUndefined();
  expect(cache.get('fp3:sec3:other')).not.toBeUndefined();
});

test('ParsedDiffCache evict() removes the entry and updates char total', () => {
  const cache = new ParsedDiffCache(100);
  cache.set('a', diff(['abcde']));
  expect(cache.charTotal()).toBe(5);
  cache.evict('a');
  expect(cache.charTotal()).toBe(0);
  expect(cache.size()).toBe(0);
});

test('ParsedDiffCache accounts for intraLineRanges in size measurement', () => {
  const cache = new ParsedDiffCache(100);
  const withRanges = {
    ...diff(['short']),
    intraLineRanges: {
      additions: { 0: [{ end: 1, start: 0 }] },
      deletions: { 0: [{ end: 1, start: 0 }] },
    },
  } as FileDiffMetadata;
  cache.set('a', withRanges);
  // 5 chars + 2 ranges * 16 bytes each = 37
  expect(cache.charTotal()).toBe(5 + 16 * 2);
});
