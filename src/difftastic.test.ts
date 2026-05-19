import type { ChangeContent, ContextContent, Hunk } from '@pierre/diffs';
import { expect, test } from 'vite-plus/test';
import { buildIntraLineRangesForHunks, parseDifftJson, type DifftFile } from './difftastic.ts';

const file = (overrides: Partial<DifftFile> = {}): DifftFile => ({
  aligned_lines: [],
  chunks: [],
  language: 'TypeScript',
  path: 'a.ts',
  status: 'unchanged',
  ...overrides,
});

const makeHunk = (hunkContent: Array<ChangeContent | ContextContent>): Hunk => ({
  additionCount: 0,
  additionLineIndex: 0,
  additionLines: 0,
  additionStart: 0,
  collapsedBefore: 0,
  deletionCount: 0,
  deletionLineIndex: 0,
  deletionLines: 0,
  deletionStart: 0,
  hunkContent,
  hunkSpecs: '',
  noEOFCRAdditions: false,
  noEOFCRDeletions: false,
  splitLineCount: 0,
  splitLineStart: 0,
  unifiedLineCount: 0,
  unifiedLineStart: 0,
});

test('parseDifftJson accepts newline-separated JSON objects (git format)', () => {
  const json = [
    JSON.stringify(file({ path: 'a.txt' })),
    JSON.stringify(file({ path: 'b.txt' })),
  ].join('\n');

  const parsed = parseDifftJson(json);

  expect(parsed).toHaveLength(2);
  expect(parsed[0].path).toBe('a.txt');
  expect(parsed[1].path).toBe('b.txt');
});

test('parseDifftJson accepts a JSON array (jj format)', () => {
  const json = JSON.stringify([file({ path: 'a.txt' }), file({ path: 'b.txt' })]);

  const parsed = parseDifftJson(json);

  expect(parsed).toHaveLength(2);
  expect(parsed[0].path).toBe('a.txt');
  expect(parsed[1].path).toBe('b.txt');
});

test('parseDifftJson ignores blank lines between objects', () => {
  const json = `\n${JSON.stringify(file({ path: 'a.txt' }))}\n\n${JSON.stringify(
    file({ path: 'b.txt' }),
  )}\n`;

  expect(parseDifftJson(json)).toHaveLength(2);
});

test('buildIntraLineRangesForHunks returns empty maps for an empty or newline-only file', () => {
  // Edge case: splitLines("\n") would return [""] but we strip trailing
  // empties → []. With no chunks and no lines, both sides are empty.
  const result = buildIntraLineRangesForHunks(file(), [], '', '\n');
  expect(result.additions).toEqual({});
  expect(result.deletions).toEqual({});
});

test('buildIntraLineRangesForHunks emits ranges for a paired modified row', () => {
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: '"hello"', end: 23, highlight: 'string', start: 18 }],
            line_number: 0,
          },
          rhs: {
            changes: [{ content: '"world"', end: 23, highlight: 'string', start: 18 }],
            line_number: 0,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 1,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(
    difft,
    hunks,
    'const greeting = "hello";\n',
    'const greeting = "world";\n',
  );

  expect(ranges.deletions).toEqual({ 0: [{ end: 23, start: 18 }] });
  expect(ranges.additions).toEqual({ 0: [{ end: 23, start: 18 }] });
});

test('buildIntraLineRangesForHunks emits ranges for unpaired addition rows when difft has structural info', () => {
  // Pierre and difft commonly disagree on pairing. Here the user added
  // a few comment lines above a modified line: pierre's change block
  // says "1 deletion + 4 additions, paired count=1" (old env ↔ first
  // comment), but the real structural change is on rhs line 3 (the
  // modified env line). The overlay must surface those ranges on the
  // unpaired addition row, not gate them behind pierre's pairing.
  const oldLines = 'const value = oldName;\n';
  const newLines = '// note A here\n// note B here\n// note C here\nconst value = newName;\n';
  const difft = file({
    chunks: [
      [
        {
          rhs: {
            changes: [{ content: '// note A here', end: 14, highlight: 'comment', start: 0 }],
            line_number: 0,
          },
        },
        {
          rhs: {
            changes: [{ content: '// note B here', end: 14, highlight: 'comment', start: 0 }],
            line_number: 1,
          },
        },
        {
          rhs: {
            changes: [{ content: '// note C here', end: 14, highlight: 'comment', start: 0 }],
            line_number: 2,
          },
        },
        {
          lhs: {
            changes: [{ content: 'oldName', end: 21, highlight: 'normal', start: 14 }],
            line_number: 0,
          },
          rhs: {
            changes: [{ content: 'newName', end: 21, highlight: 'normal', start: 14 }],
            line_number: 3,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 4,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLines, newLines);

  expect(ranges.deletions).toEqual({ 0: [{ end: 21, start: 14 }] });
  // The pure-add comment lines have full-line coverage → suppressed by
  // the noise threshold. The unpaired addition at line 3 has sparse
  // changes (33%) → surfaces as a structural per-token range.
  expect(ranges.additions).toEqual({ 3: [{ end: 21, start: 14 }] });
});

test('buildIntraLineRangesForHunks emits ranges for unpaired deletion rows when difft has structural info', () => {
  // Symmetric: a few lines deleted above a modified line.
  const oldLines = '// note A here\n// note B here\n// note C here\nconst value = oldName;\n';
  const newLines = 'const value = newName;\n';
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: '// note A here', end: 14, highlight: 'comment', start: 0 }],
            line_number: 0,
          },
        },
        {
          lhs: {
            changes: [{ content: '// note B here', end: 14, highlight: 'comment', start: 0 }],
            line_number: 1,
          },
        },
        {
          lhs: {
            changes: [{ content: '// note C here', end: 14, highlight: 'comment', start: 0 }],
            line_number: 2,
          },
        },
        {
          lhs: {
            changes: [{ content: 'oldName', end: 21, highlight: 'normal', start: 14 }],
            line_number: 3,
          },
          rhs: {
            changes: [{ content: 'newName', end: 21, highlight: 'normal', start: 14 }],
            line_number: 0,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 1,
        deletionLineIndex: 0,
        deletions: 4,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLines, newLines);

  expect(ranges.deletions).toEqual({ 3: [{ end: 21, start: 14 }] });
  expect(ranges.additions).toEqual({ 0: [{ end: 21, start: 14 }] });
});

test('buildIntraLineRangesForHunks returns empty entries when difft has no relevant annotations', () => {
  // Pierre paired old line 0 with new line 0 as a modification, but
  // difft sees the imports as structurally equivalent. Difft only
  // annotates the new layout lines (every token), which the coverage
  // threshold suppresses. Result: empty maps, no per-token boxes
  // anywhere — pierre's row-level background still conveys the change.
  const difft = file({
    chunks: [
      [
        {
          rhs: {
            // Whole-line "new layout" annotations on the inserted lines,
            // which trip the noise threshold.
            changes: [{ content: '  a,', end: 4, highlight: 'normal', start: 0 }],
            line_number: 1,
          },
        },
        {
          rhs: {
            changes: [{ content: '} from "x";', end: 11, highlight: 'normal', start: 0 }],
            line_number: 2,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 3,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(
    difft,
    hunks,
    'import { a } from "x";\n',
    'import {\n  a,\n} from "x";\n',
  );

  // Always a non-null object so pierre's char/word fallback is suppressed.
  expect(ranges).toBeDefined();
  expect(ranges.deletions).toEqual({});
  expect(ranges.additions).toEqual({});
});

test('buildIntraLineRangesForHunks ignores context blocks', () => {
  const oldLines = 'first line stays\nconst x = oldValue;\nlast line stays\n';
  const newLines = 'first line stays\nconst x = newValue;\nlast line stays\n';
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'oldValue', end: 18, highlight: 'normal', start: 10 }],
            line_number: 1,
          },
          rhs: {
            changes: [{ content: 'newValue', end: 18, highlight: 'normal', start: 10 }],
            line_number: 1,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      { additionLineIndex: 0, deletionLineIndex: 0, lines: 1, type: 'context' },
      {
        additionLineIndex: 1,
        additions: 1,
        deletionLineIndex: 1,
        deletions: 1,
        type: 'change',
      },
      { additionLineIndex: 2, deletionLineIndex: 2, lines: 1, type: 'context' },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLines, newLines);

  expect(ranges.deletions).toEqual({ 1: [{ end: 18, start: 10 }] });
  expect(ranges.additions).toEqual({ 1: [{ end: 18, start: 10 }] });
});

test('buildIntraLineRangesForHunks converts difft byte offsets to UTF-16 char offsets', () => {
  // "🚀 done" — emoji is 4 bytes (1 surrogate pair in UTF-16). Difft
  // reports bytes 5..9 for "done"; expect UTF-16 chars 3..7.
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'TODO', end: 9, highlight: 'normal', start: 5 }],
            line_number: 0,
          },
          rhs: {
            changes: [{ content: 'done', end: 9, highlight: 'normal', start: 5 }],
            line_number: 0,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 1,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, '🚀 TODO\n', '🚀 done\n');

  expect(ranges.deletions).toEqual({ 0: [{ end: 7, start: 3 }] });
  expect(ranges.additions).toEqual({ 0: [{ end: 7, start: 3 }] });
});

test('buildIntraLineRangesForHunks keeps ranges on a paired row even when every token is covered', () => {
  // Paired rows in difft's chunk → ranges always emitted so the user can
  // compare lhs↔rhs token-for-token, even if the line was wholly rewritten.
  const oldLine = "import { buildFileDiff } from './x.ts';\n";
  const newLine = "import { buildIntraLineRangesForHunks } from './y.ts';\n";
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [
              { content: 'import', end: 6, highlight: 'keyword', start: 0 },
              { content: '{', end: 8, highlight: 'delimiter', start: 7 },
              { content: 'buildFileDiff', end: 22, highlight: 'normal', start: 9 },
              { content: '}', end: 24, highlight: 'normal', start: 23 },
              { content: "from './x.ts'", end: 38, highlight: 'string', start: 25 },
              { content: ';', end: 39, highlight: 'delimiter', start: 38 },
            ],
            line_number: 0,
          },
          rhs: {
            changes: [
              { content: 'import', end: 6, highlight: 'keyword', start: 0 },
              { content: '{', end: 8, highlight: 'delimiter', start: 7 },
              { content: 'buildIntraLineRangesForHunks', end: 37, highlight: 'normal', start: 9 },
              { content: '}', end: 39, highlight: 'normal', start: 38 },
              { content: "from './y.ts'", end: 53, highlight: 'string', start: 40 },
              { content: ';', end: 54, highlight: 'delimiter', start: 53 },
            ],
            line_number: 0,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 1,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLine, newLine);

  expect(ranges.deletions?.[0]?.length).toBe(6);
  expect(ranges.additions?.[0]?.length).toBe(6);
});

test('buildIntraLineRangesForHunks drops ranges on a one-sided row when every non-whitespace byte is covered', () => {
  // Pure-add row (no lhs counterpart) where every token is annotated:
  // nothing to compare against, so the boxes add nothing over the
  // row-level bg. Suppress.
  const oldLine = 'unchanged\n';
  const newLine = 'unchanged\nbrand new line here\n';
  const difft = file({
    chunks: [
      [
        {
          rhs: {
            changes: [
              { content: 'brand', end: 5, highlight: 'normal', start: 0 },
              { content: 'new', end: 9, highlight: 'normal', start: 6 },
              { content: 'line', end: 14, highlight: 'normal', start: 10 },
              { content: 'here', end: 19, highlight: 'normal', start: 15 },
            ],
            line_number: 1,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 1,
        additions: 1,
        deletionLineIndex: 1,
        deletions: 0,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLine, newLine);

  expect(ranges.additions).toEqual({});
});

test('buildIntraLineRangesForHunks drops ranges on a one-sided row when only spaces are unmatched', () => {
  // Same suppression as full-byte coverage: when every non-whitespace
  // byte on a one-sided row is covered, the gaps are just whitespace —
  // still noise.
  const oldLine = 'first\n';
  const newLine = 'first\nfoo bar baz\n';
  const difft = file({
    chunks: [
      [
        {
          rhs: {
            changes: [
              { content: 'foo', end: 3, highlight: 'normal', start: 0 },
              { content: 'bar', end: 7, highlight: 'normal', start: 4 },
              { content: 'baz', end: 11, highlight: 'normal', start: 8 },
            ],
            line_number: 1,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 1,
        additions: 1,
        deletionLineIndex: 1,
        deletions: 0,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLine, newLine);

  expect(ranges.additions).toEqual({});
});

test('buildIntraLineRangesForHunks drops per-character fallback ranges even on paired rows', () => {
  // Difft sometimes emits per-byte ranges (e.g., on template-literal
  // continuations) instead of meaningful tokens. The signature is a
  // long run of adjacent 1-byte changes; the ranges convey nothing
  // useful even on a paired row.
  const oldLine = '            }`,\n';
  const newLine = "            }:${flag ? 'a' : 'b'}`,\n";
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            // 14 consecutive 1-byte ranges (12 spaces + `}` + backtick).
            changes: Array.from({ length: 14 }, (_, i) => ({
              content: ' ',
              end: i + 1,
              highlight: 'normal' as const,
              start: i,
            })),
            line_number: 0,
          },
          rhs: {
            // 16 consecutive 1-byte ranges, then a real token, then more
            // small ranges. The leading run is enough to flag this.
            changes: [
              ...Array.from({ length: 16 }, (_, i) => ({
                content: ' ',
                end: i + 1,
                highlight: 'normal' as const,
                start: i,
              })),
              { content: 'flag', end: 20, highlight: 'normal' as const, start: 16 },
            ],
            line_number: 0,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 1,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLine, newLine);

  expect(ranges.deletions).toEqual({});
  expect(ranges.additions).toEqual({});
});

test('buildIntraLineRangesForHunks suppresses all ranges when difft fell back to text mode', () => {
  // Difft hits DFT_GRAPH_LIMIT on large/complex files and produces
  // per-character output with language='Text (exceeded DFT_GRAPH_LIMIT)'.
  // Those annotations are no better than pierre's char-diff — drop them.
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'oldName', end: 21, highlight: 'normal', start: 14 }],
            line_number: 0,
          },
          rhs: {
            changes: [{ content: 'newName', end: 21, highlight: 'normal', start: 14 }],
            line_number: 0,
          },
        },
      ],
    ],
    language: 'Text (exceeded DFT_GRAPH_LIMIT)',
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 0,
        additions: 1,
        deletionLineIndex: 0,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(
    difft,
    hunks,
    'const value = oldName;\n',
    'const value = newName;\n',
  );

  expect(ranges.deletions).toEqual({});
  expect(ranges.additions).toEqual({});
});

test('buildIntraLineRangesForHunks handles multiple hunks', () => {
  const oldLines =
    'header line zero\nconst alpha = oldOne;\nfiller\nfiller\nfiller\nconst beta = oldTwo;\n';
  const newLines =
    'header line zero\nconst alpha = newOne;\nfiller\nfiller\nfiller\nconst beta = newTwo;\n';
  const difft = file({
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'oldOne', end: 21, highlight: 'normal', start: 15 }],
            line_number: 1,
          },
          rhs: {
            changes: [{ content: 'newOne', end: 21, highlight: 'normal', start: 15 }],
            line_number: 1,
          },
        },
      ],
      [
        {
          lhs: {
            changes: [{ content: 'oldTwo', end: 20, highlight: 'normal', start: 14 }],
            line_number: 5,
          },
          rhs: {
            changes: [{ content: 'newTwo', end: 20, highlight: 'normal', start: 14 }],
            line_number: 5,
          },
        },
      ],
    ],
    status: 'changed',
  });
  const hunks = [
    makeHunk([
      {
        additionLineIndex: 1,
        additions: 1,
        deletionLineIndex: 1,
        deletions: 1,
        type: 'change',
      },
    ]),
    makeHunk([
      {
        additionLineIndex: 5,
        additions: 1,
        deletionLineIndex: 5,
        deletions: 1,
        type: 'change',
      },
    ]),
  ];

  const ranges = buildIntraLineRangesForHunks(difft, hunks, oldLines, newLines);

  expect(ranges.deletions).toEqual({
    1: [{ end: 21, start: 15 }],
    5: [{ end: 20, start: 14 }],
  });
  expect(ranges.additions).toEqual({
    1: [{ end: 21, start: 15 }],
    5: [{ end: 20, start: 14 }],
  });
});
