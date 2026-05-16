import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from '@pierre/diffs';

export type DifftStatus = 'changed' | 'created' | 'deleted' | 'unchanged';

export type DifftHighlight =
  | 'comment'
  | 'delimiter'
  | 'keyword'
  | 'normal'
  | 'string'
  | 'tree_sitter_error'
  | 'type';

export type DifftChange = {
  content: string;
  end: number;
  highlight: DifftHighlight;
  start: number;
};

export type DifftSide = {
  changes: ReadonlyArray<DifftChange>;
  line_number: number;
};

export type DifftRow = {
  lhs?: DifftSide;
  rhs?: DifftSide;
};

export type DifftChunk = ReadonlyArray<DifftRow>;

export type DifftFile = {
  aligned_lines: ReadonlyArray<[number | null, number | null]>;
  chunks: ReadonlyArray<DifftChunk>;
  language: string;
  path: string;
  status: DifftStatus;
};

const CONTEXT_LINES = 4;

// Difftastic emits one aligned_lines row per file row plus a phantom EOF
// row pointing one past the last real line on both sides (its convention
// for representing the trailing newline). Surfacing that row to the
// renderer makes additionLineIndex/deletionLineIndex run off the end of
// the file's line arrays, which the CodeView prints as `undefined`. Trim
// those trailing phantom rows here.
const dropPhantomEofRows = (
  alignedLines: DifftFile['aligned_lines'],
  deletionLineCount: number,
  additionLineCount: number,
): DifftFile['aligned_lines'] => {
  let end = alignedLines.length;
  while (end > 0) {
    const [lhs, rhs] = alignedLines[end - 1];
    const lhsExceeds = lhs === null || lhs >= deletionLineCount;
    const rhsExceeds = rhs === null || rhs >= additionLineCount;
    if (lhsExceeds && rhsExceeds) {
      end -= 1;
    } else {
      break;
    }
  }
  return end === alignedLines.length ? alignedLines : alignedLines.slice(0, end);
};

const splitFileLines = (contents: string): { lines: Array<string>; noEOF: boolean } => {
  if (contents.length === 0) {
    return { lines: [], noEOF: false };
  }

  if (contents.endsWith('\n')) {
    const trimmed = contents.slice(0, -1);
    const parts = trimmed.length === 0 ? [''] : trimmed.split('\n');
    return { lines: parts.map((line) => `${line}\n`), noEOF: false };
  }

  const parts = contents.split('\n');
  const lines = parts.map((line, index) => (index < parts.length - 1 ? `${line}\n` : line));
  return { lines, noEOF: true };
};

export const parseDifftJson = (stdout: string): ReadonlyArray<DifftFile> => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as ReadonlyArray<DifftFile>;
  }

  return trimmed
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DifftFile);
};

type RowKind = 'context' | 'add' | 'del' | 'mod';

type ResolvedRow = {
  additionLineIndex: number | null;
  deletionLineIndex: number | null;
  kind: RowKind;
};

type HunkRange = {
  endRow: number;
  startRow: number;
};

const buildChangedRowSet = (
  alignedLines: DifftFile['aligned_lines'],
  chunks: DifftFile['chunks'],
): Set<number> => {
  const lhsChangedLines = new Set<number>();
  const rhsChangedLines = new Set<number>();

  for (const chunk of chunks) {
    for (const row of chunk) {
      if (row.lhs) {
        lhsChangedLines.add(row.lhs.line_number);
      }
      if (row.rhs) {
        rhsChangedLines.add(row.rhs.line_number);
      }
    }
  }

  const changed = new Set<number>();
  for (const [index, [lhs, rhs]] of alignedLines.entries()) {
    if (lhs === null || rhs === null) {
      changed.add(index);
      continue;
    }
    if (lhsChangedLines.has(lhs) || rhsChangedLines.has(rhs)) {
      changed.add(index);
    }
  }
  return changed;
};

const computeHunkRanges = (
  changedRows: Set<number>,
  totalRows: number,
): ReadonlyArray<HunkRange> => {
  if (changedRows.size === 0 || totalRows === 0) {
    return [];
  }

  const sorted = [...changedRows].sort((left, right) => left - right);
  const ranges: Array<HunkRange> = [];

  for (const changedRow of sorted) {
    const startRow = Math.max(0, changedRow - CONTEXT_LINES);
    const endRow = Math.min(totalRows - 1, changedRow + CONTEXT_LINES);
    const last = ranges.at(-1);

    if (last && startRow <= last.endRow + 1) {
      last.endRow = Math.max(last.endRow, endRow);
    } else {
      ranges.push({ endRow, startRow });
    }
  }

  return ranges;
};

const resolveRow = (
  alignedLines: DifftFile['aligned_lines'],
  rowIndex: number,
  changedRows: Set<number>,
): ResolvedRow => {
  const [lhs, rhs] = alignedLines[rowIndex];
  const isChange = changedRows.has(rowIndex);
  let kind: RowKind;
  if (!isChange) {
    kind = 'context';
  } else if (lhs === null) {
    kind = 'add';
  } else if (rhs === null) {
    kind = 'del';
  } else {
    kind = 'mod';
  }

  return {
    additionLineIndex: rhs,
    deletionLineIndex: lhs,
    kind,
  };
};

type HunkBuildResult = {
  hunk: Hunk;
  splitLines: number;
  unifiedLines: number;
};

const buildHunk = (
  range: HunkRange,
  alignedLines: DifftFile['aligned_lines'],
  changedRows: Set<number>,
  collapsedBefore: number,
  splitLineStart: number,
  unifiedLineStart: number,
  noEOFLastAdditionLineIndex: number | null,
  noEOFLastDeletionLineIndex: number | null,
  noEOFAdditions: boolean,
  noEOFDeletions: boolean,
): HunkBuildResult => {
  const resolved: Array<ResolvedRow> = [];
  for (let index = range.startRow; index <= range.endRow; index += 1) {
    resolved.push(resolveRow(alignedLines, index, changedRows));
  }

  let additionStartIndex: number | null = null;
  let deletionStartIndex: number | null = null;
  let additionRowCount = 0;
  let deletionRowCount = 0;
  let addedLineCount = 0;
  let deletedLineCount = 0;

  for (const row of resolved) {
    if (row.additionLineIndex !== null) {
      if (additionStartIndex === null) {
        additionStartIndex = row.additionLineIndex;
      }
      additionRowCount += 1;
    }
    if (row.deletionLineIndex !== null) {
      if (deletionStartIndex === null) {
        deletionStartIndex = row.deletionLineIndex;
      }
      deletionRowCount += 1;
    }
    if (row.kind === 'add') {
      addedLineCount += 1;
    } else if (row.kind === 'del') {
      deletedLineCount += 1;
    } else if (row.kind === 'mod') {
      addedLineCount += 1;
      deletedLineCount += 1;
    }
  }

  // Default base for empty rows (e.g. a hunk that starts with a filler) —
  // fall back to the file-level position so indices remain monotonic.
  const additionBase = additionStartIndex ?? resolved[0]?.deletionLineIndex ?? 0;
  const deletionBase = deletionStartIndex ?? resolved[0]?.additionLineIndex ?? 0;

  const hunkContent: Array<ChangeContent | ContextContent> = [];
  let cursor = 0;
  let runningAdditionIndex = additionBase;
  let runningDeletionIndex = deletionBase;

  while (cursor < resolved.length) {
    const row = resolved[cursor];
    if (row.kind === 'context') {
      let runEnd = cursor;
      while (runEnd < resolved.length && resolved[runEnd].kind === 'context') {
        runEnd += 1;
      }
      const lines = runEnd - cursor;
      hunkContent.push({
        additionLineIndex: runningAdditionIndex,
        deletionLineIndex: runningDeletionIndex,
        lines,
        type: 'context',
      });
      runningAdditionIndex += lines;
      runningDeletionIndex += lines;
      cursor = runEnd;
      continue;
    }

    let runEnd = cursor;
    let additionsInRun = 0;
    let deletionsInRun = 0;
    while (runEnd < resolved.length && resolved[runEnd].kind !== 'context') {
      const block = resolved[runEnd];
      if (block.kind === 'add') {
        additionsInRun += 1;
      } else if (block.kind === 'del') {
        deletionsInRun += 1;
      } else {
        additionsInRun += 1;
        deletionsInRun += 1;
      }
      runEnd += 1;
    }
    hunkContent.push({
      additionLineIndex: runningAdditionIndex,
      additions: additionsInRun,
      deletionLineIndex: runningDeletionIndex,
      deletions: deletionsInRun,
      type: 'change',
    });
    runningAdditionIndex += additionsInRun;
    runningDeletionIndex += deletionsInRun;
    cursor = runEnd;
  }

  let splitLines = 0;
  let unifiedLines = 0;
  for (const block of hunkContent) {
    if (block.type === 'context') {
      splitLines += block.lines;
      unifiedLines += block.lines;
    } else {
      splitLines += Math.max(block.additions, block.deletions);
      unifiedLines += block.additions + block.deletions;
    }
  }

  const lastAdditionIndex = runningAdditionIndex - 1;
  const lastDeletionIndex = runningDeletionIndex - 1;
  const noEOFAdditionsForHunk =
    noEOFAdditions &&
    noEOFLastAdditionLineIndex !== null &&
    lastAdditionIndex === noEOFLastAdditionLineIndex;
  const noEOFDeletionsForHunk =
    noEOFDeletions &&
    noEOFLastDeletionLineIndex !== null &&
    lastDeletionIndex === noEOFLastDeletionLineIndex;

  const hunk: Hunk = {
    additionCount: additionRowCount,
    additionLineIndex: additionBase,
    additionLines: addedLineCount,
    additionStart: additionBase + 1,
    collapsedBefore,
    deletionCount: deletionRowCount,
    deletionLineIndex: deletionBase,
    deletionLines: deletedLineCount,
    deletionStart: deletionBase + 1,
    hunkContent,
    hunkSpecs: `@@ -${deletionBase + 1},${deletionRowCount} +${additionBase + 1},${additionRowCount} @@\n`,
    noEOFCRAdditions: noEOFAdditionsForHunk,
    noEOFCRDeletions: noEOFDeletionsForHunk,
    splitLineCount: splitLines,
    splitLineStart,
    unifiedLineCount: unifiedLines,
    unifiedLineStart,
  };

  return { hunk, splitLines, unifiedLines };
};

const buildSingleChunkHunk = (
  type: 'add' | 'del',
  lineCount: number,
): { hunk: Hunk; splitLines: number; unifiedLines: number } => {
  const additions = type === 'add' ? lineCount : 0;
  const deletions = type === 'del' ? lineCount : 0;

  const hunk: Hunk = {
    additionCount: additions,
    additionLineIndex: 0,
    additionLines: additions,
    additionStart: additions > 0 ? 1 : 0,
    collapsedBefore: 0,
    deletionCount: deletions,
    deletionLineIndex: 0,
    deletionLines: deletions,
    deletionStart: deletions > 0 ? 1 : 0,
    hunkContent: [
      {
        additionLineIndex: 0,
        additions,
        deletionLineIndex: 0,
        deletions,
        type: 'change',
      },
    ],
    hunkSpecs: `@@ -${deletions > 0 ? 1 : 0},${deletions} +${additions > 0 ? 1 : 0},${additions} @@\n`,
    noEOFCRAdditions: false,
    noEOFCRDeletions: false,
    splitLineCount: lineCount,
    splitLineStart: 0,
    unifiedLineCount: lineCount,
    unifiedLineStart: 0,
  };

  return { hunk, splitLines: lineCount, unifiedLines: lineCount };
};

export const buildFileDiff = (
  file: DifftFile,
  oldContents: string,
  newContents: string,
): FileDiffMetadata | null => {
  const { lines: additionLines, noEOF: noEOFAdditions } = splitFileLines(newContents);
  const { lines: deletionLines, noEOF: noEOFDeletions } = splitFileLines(oldContents);

  if (file.status === 'unchanged') {
    return null;
  }

  if (file.status === 'created') {
    const result = buildSingleChunkHunk('add', additionLines.length);
    return {
      additionLines,
      cacheKey: undefined,
      deletionLines,
      hunks: additionLines.length > 0 ? [result.hunk] : [],
      isPartial: false,
      name: file.path,
      splitLineCount: result.splitLines,
      type: 'new',
      unifiedLineCount: result.unifiedLines,
    };
  }

  if (file.status === 'deleted') {
    const result = buildSingleChunkHunk('del', deletionLines.length);
    return {
      additionLines,
      cacheKey: undefined,
      deletionLines,
      hunks: deletionLines.length > 0 ? [result.hunk] : [],
      isPartial: false,
      name: file.path,
      splitLineCount: result.splitLines,
      type: 'deleted',
      unifiedLineCount: result.unifiedLines,
    };
  }

  const alignedLines = dropPhantomEofRows(
    file.aligned_lines,
    deletionLines.length,
    additionLines.length,
  );
  const changedRows = buildChangedRowSet(alignedLines, file.chunks);
  const ranges = computeHunkRanges(changedRows, alignedLines.length);

  if (ranges.length === 0) {
    return {
      additionLines,
      cacheKey: undefined,
      deletionLines,
      hunks: [],
      isPartial: false,
      name: file.path,
      splitLineCount: 0,
      type: 'change',
      unifiedLineCount: 0,
    };
  }

  const noEOFLastAdditionLineIndex = additionLines.length > 0 ? additionLines.length - 1 : null;
  const noEOFLastDeletionLineIndex = deletionLines.length > 0 ? deletionLines.length - 1 : null;

  const hunks: Array<Hunk> = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let previousEndRow = -1;

  for (const range of ranges) {
    const collapsedBefore =
      previousEndRow === -1 ? range.startRow : range.startRow - previousEndRow - 1;
    const built = buildHunk(
      range,
      alignedLines,
      changedRows,
      collapsedBefore,
      splitLineCount,
      unifiedLineCount,
      noEOFLastAdditionLineIndex,
      noEOFLastDeletionLineIndex,
      noEOFAdditions,
      noEOFDeletions,
    );
    hunks.push(built.hunk);
    splitLineCount += built.splitLines;
    unifiedLineCount += built.unifiedLines;
    previousEndRow = range.endRow;
  }

  return {
    additionLines,
    cacheKey: undefined,
    deletionLines,
    hunks,
    isPartial: false,
    name: file.path,
    splitLineCount,
    type: 'change',
    unifiedLineCount,
  };
};
