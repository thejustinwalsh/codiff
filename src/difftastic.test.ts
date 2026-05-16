import { expect, test } from 'vite-plus/test';
import { buildFileDiff, parseDifftJson, type DifftFile } from './difftastic.ts';

const file = (overrides: Partial<DifftFile> = {}): DifftFile => ({
  aligned_lines: [],
  chunks: [],
  language: 'Text',
  path: 'a.txt',
  status: 'unchanged',
  ...overrides,
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

test('buildFileDiff returns null for unchanged files', () => {
  const result = buildFileDiff(file({ status: 'unchanged' }), '', '');
  expect(result).toBeNull();
});

test('buildFileDiff handles a created file as one all-addition hunk', () => {
  const result = buildFileDiff(
    file({ path: 'new.txt', status: 'created' }),
    '',
    'one\ntwo\nthree\n',
  );

  expect(result).not.toBeNull();
  expect(result!.type).toBe('new');
  expect(result!.additionLines).toEqual(['one\n', 'two\n', 'three\n']);
  expect(result!.deletionLines).toEqual([]);
  expect(result!.hunks).toHaveLength(1);

  const hunk = result!.hunks[0];
  expect(hunk.additionStart).toBe(1);
  expect(hunk.additionLines).toBe(3);
  expect(hunk.deletionLines).toBe(0);
  expect(hunk.hunkContent).toEqual([
    {
      additionLineIndex: 0,
      additions: 3,
      deletionLineIndex: 0,
      deletions: 0,
      type: 'change',
    },
  ]);
});

test('buildFileDiff handles a deleted file as one all-deletion hunk', () => {
  const result = buildFileDiff(file({ path: 'old.txt', status: 'deleted' }), 'one\ntwo\n', '');

  expect(result).not.toBeNull();
  expect(result!.type).toBe('deleted');
  expect(result!.additionLines).toEqual([]);
  expect(result!.deletionLines).toEqual(['one\n', 'two\n']);
  expect(result!.hunks).toHaveLength(1);
  expect(result!.hunks[0].hunkContent).toEqual([
    {
      additionLineIndex: 0,
      additions: 0,
      deletionLineIndex: 0,
      deletions: 2,
      type: 'change',
    },
  ]);
});

test('buildFileDiff builds a single hunk with surrounding context for an in-place change', () => {
  // 10-line file, single-line change at line 5 (1-indexed). With the
  // default 4-line context window, the hunk runs lines 1..9 (the trailing
  // line is not reached).
  const oldContents = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const newContents = 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj\n';

  const difft: DifftFile = {
    aligned_lines: Array.from({ length: 10 }, (_, i) => [i, i] as [number, number]),
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'e', end: 1, highlight: 'normal', start: 0 }],
            line_number: 4,
          },
          rhs: {
            changes: [{ content: 'E', end: 1, highlight: 'normal', start: 0 }],
            line_number: 4,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);

  expect(result).not.toBeNull();
  expect(result!.type).toBe('change');
  expect(result!.hunks).toHaveLength(1);

  const hunk = result!.hunks[0];
  expect(hunk.additionStart).toBe(1);
  expect(hunk.deletionStart).toBe(1);
  expect(hunk.additionCount).toBe(9);
  expect(hunk.deletionCount).toBe(9);
  expect(hunk.additionLines).toBe(1);
  expect(hunk.deletionLines).toBe(1);
  expect(hunk.collapsedBefore).toBe(0);
  expect(hunk.hunkContent).toEqual([
    { additionLineIndex: 0, deletionLineIndex: 0, lines: 4, type: 'context' },
    { additionLineIndex: 4, additions: 1, deletionLineIndex: 4, deletions: 1, type: 'change' },
    { additionLineIndex: 5, deletionLineIndex: 5, lines: 4, type: 'context' },
  ]);
});

test('buildFileDiff handles a pure insertion: filler on the deletion side', () => {
  const oldContents = 'a\nb\nc\n';
  const newContents = 'a\nb\nINSERTED\nc\n';

  const difft: DifftFile = {
    aligned_lines: [
      [0, 0],
      [1, 1],
      [null, 2],
      [2, 3],
    ],
    chunks: [
      [
        {
          rhs: {
            changes: [{ content: 'INSERTED', end: 8, highlight: 'normal', start: 0 }],
            line_number: 2,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);

  expect(result).not.toBeNull();
  const hunk = result!.hunks[0];
  expect(hunk.additionStart).toBe(1);
  expect(hunk.deletionStart).toBe(1);
  expect(hunk.additionLines).toBe(1);
  expect(hunk.deletionLines).toBe(0);
  expect(hunk.additionCount).toBe(4);
  expect(hunk.deletionCount).toBe(3);
  expect(hunk.hunkContent).toEqual([
    { additionLineIndex: 0, deletionLineIndex: 0, lines: 2, type: 'context' },
    { additionLineIndex: 2, additions: 1, deletionLineIndex: 2, deletions: 0, type: 'change' },
    { additionLineIndex: 3, deletionLineIndex: 2, lines: 1, type: 'context' },
  ]);
});

test('buildFileDiff merges nearby change regions into one hunk when context overlaps', () => {
  // 13 lines; changes on rows 2 and 10 (0-indexed). The 4-line context
  // windows touch, so the two chunks merge into one hunk that spans the
  // whole file (matches parseDiffFromFile).
  const oldContents = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n';
  const newContents = 'a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nK\nl\nm\n';

  const difft: DifftFile = {
    aligned_lines: Array.from({ length: 13 }, (_, i) => [i, i] as [number, number]),
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'c', end: 1, highlight: 'normal', start: 0 }],
            line_number: 2,
          },
          rhs: {
            changes: [{ content: 'C', end: 1, highlight: 'normal', start: 0 }],
            line_number: 2,
          },
        },
      ],
      [
        {
          lhs: {
            changes: [{ content: 'k', end: 1, highlight: 'normal', start: 0 }],
            line_number: 10,
          },
          rhs: {
            changes: [{ content: 'K', end: 1, highlight: 'normal', start: 0 }],
            line_number: 10,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);

  expect(result).not.toBeNull();
  expect(result!.hunks).toHaveLength(1);

  const hunk = result!.hunks[0];
  expect(hunk.hunkContent).toEqual([
    { additionLineIndex: 0, deletionLineIndex: 0, lines: 2, type: 'context' },
    { additionLineIndex: 2, additions: 1, deletionLineIndex: 2, deletions: 1, type: 'change' },
    { additionLineIndex: 3, deletionLineIndex: 3, lines: 7, type: 'context' },
    { additionLineIndex: 10, additions: 1, deletionLineIndex: 10, deletions: 1, type: 'change' },
    { additionLineIndex: 11, deletionLineIndex: 11, lines: 2, type: 'context' },
  ]);
  expect(hunk.additionLines).toBe(2);
  expect(hunk.deletionLines).toBe(2);
});

test('buildFileDiff keeps distant changes in separate hunks with correct collapsedBefore', () => {
  // 20 lines; changes on rows 2 and 17 (0-indexed). Their 4-line context
  // windows do not touch, so the hunks stay separate. collapsedBefore on
  // the second hunk counts the unchanged rows between them.
  const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
  const oldContents = lines.join('\n') + '\n';
  const modified = [...lines];
  modified[2] = 'CHANGED-2';
  modified[17] = 'CHANGED-17';
  const newContents = modified.join('\n') + '\n';

  const difft: DifftFile = {
    aligned_lines: Array.from({ length: 20 }, (_, i) => [i, i] as [number, number]),
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'line2', end: 5, highlight: 'normal', start: 0 }],
            line_number: 2,
          },
          rhs: {
            changes: [{ content: 'CHANGED-2', end: 9, highlight: 'normal', start: 0 }],
            line_number: 2,
          },
        },
      ],
      [
        {
          lhs: {
            changes: [{ content: 'line17', end: 6, highlight: 'normal', start: 0 }],
            line_number: 17,
          },
          rhs: {
            changes: [{ content: 'CHANGED-17', end: 10, highlight: 'normal', start: 0 }],
            line_number: 17,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'lines.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);

  expect(result).not.toBeNull();
  expect(result!.hunks).toHaveLength(2);

  const [first, second] = result!.hunks;
  expect(first.deletionStart).toBe(1);
  expect(first.collapsedBefore).toBe(0);
  expect(first.deletionCount).toBe(7);
  expect(second.deletionStart).toBe(14);
  // First hunk covers rows 0..6, second covers rows 13..19. Rows 7..12 = 6 unchanged rows collapsed.
  expect(second.collapsedBefore).toBe(6);
  expect(second.deletionCount).toBe(7);
});

test('buildFileDiff handles a hunk that begins at file start (no leading context)', () => {
  const oldContents = 'one\ntwo\nthree\n';
  const newContents = 'ONE\ntwo\nthree\n';

  const difft: DifftFile = {
    aligned_lines: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'one', end: 3, highlight: 'normal', start: 0 }],
            line_number: 0,
          },
          rhs: {
            changes: [{ content: 'ONE', end: 3, highlight: 'normal', start: 0 }],
            line_number: 0,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);

  expect(result).not.toBeNull();
  const hunk = result!.hunks[0];
  expect(hunk.additionStart).toBe(1);
  expect(hunk.deletionStart).toBe(1);
  expect(hunk.collapsedBefore).toBe(0);
  expect(hunk.hunkContent[0]).toEqual({
    additionLineIndex: 0,
    additions: 1,
    deletionLineIndex: 0,
    deletions: 1,
    type: 'change',
  });
});

test('buildFileDiff reports noEOF flags when files lack a trailing newline', () => {
  const oldContents = 'a\nb';
  const newContents = 'a\nB';

  const difft: DifftFile = {
    aligned_lines: [
      [0, 0],
      [1, 1],
    ],
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'b', end: 1, highlight: 'normal', start: 0 }],
            line_number: 1,
          },
          rhs: {
            changes: [{ content: 'B', end: 1, highlight: 'normal', start: 0 }],
            line_number: 1,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);

  expect(result).not.toBeNull();
  expect(result!.hunks[0].noEOFCRAdditions).toBe(true);
  expect(result!.hunks[0].noEOFCRDeletions).toBe(true);
});

test('buildFileDiff splits lines so each line includes its trailing newline', () => {
  const result = buildFileDiff(file({ path: 'new.txt', status: 'created' }), '', 'one\ntwo\n');

  expect(result!.additionLines).toEqual(['one\n', 'two\n']);
});

test('buildFileDiff drops difft phantom EOF rows so context never references undefined lines', () => {
  // Real difft output for a 10-line file ending with `\n` has 11
  // aligned_lines rows — the trailing [10, 10] is a phantom EOF row that
  // points one past the last real line. The transformer must not surface
  // that row to the renderer, which would otherwise display "undefined"
  // for the context line at index 10.
  const oldContents = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const newContents = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n';

  const difft: DifftFile = {
    aligned_lines: Array.from({ length: 11 }, (_, i) => [i, i] as [number, number]),
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'j', end: 1, highlight: 'normal', start: 0 }],
            line_number: 9,
          },
          rhs: {
            changes: [{ content: 'J', end: 1, highlight: 'normal', start: 0 }],
            line_number: 9,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);
  expect(result).not.toBeNull();

  // The hunk should not include the phantom row 10; its trailing context
  // should stop at row 9 (the change). Otherwise additionLineIndex would
  // exceed additionLines.length.
  for (const hunk of result!.hunks) {
    for (const block of hunk.hunkContent) {
      const lastAddition =
        block.additionLineIndex + (block.type === 'context' ? block.lines : block.additions);
      const lastDeletion =
        block.deletionLineIndex + (block.type === 'context' ? block.lines : block.deletions);
      expect(lastAddition).toBeLessThanOrEqual(result!.additionLines.length);
      expect(lastDeletion).toBeLessThanOrEqual(result!.deletionLines.length);
    }
  }
});

test('buildFileDiff exposes file-level splitLineCount and unifiedLineCount', () => {
  // Same input as the in-place change test: 4 ctx + 1 change + 4 ctx = 9 split rows; 10 unified rows.
  const oldContents = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const newContents = 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj\n';

  const difft: DifftFile = {
    aligned_lines: Array.from({ length: 10 }, (_, i) => [i, i] as [number, number]),
    chunks: [
      [
        {
          lhs: {
            changes: [{ content: 'e', end: 1, highlight: 'normal', start: 0 }],
            line_number: 4,
          },
          rhs: {
            changes: [{ content: 'E', end: 1, highlight: 'normal', start: 0 }],
            line_number: 4,
          },
        },
      ],
    ],
    language: 'Text',
    path: 'a.txt',
    status: 'changed',
  };

  const result = buildFileDiff(difft, oldContents, newContents);
  expect(result!.splitLineCount).toBe(9);
  expect(result!.unifiedLineCount).toBe(10);
});
