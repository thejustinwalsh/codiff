import type { FileIntraLineRanges, Hunk, IntraLineRange } from '@pierre/diffs';

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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

// Difft offsets are UTF-8 bytes; pierre wants UTF-16 chars.
const byteToCharOffset = (line: string, byteOffset: number): number => {
  if (byteOffset <= 0) {
    return 0;
  }
  const bytes = utf8Encoder.encode(line);
  if (byteOffset >= bytes.length) {
    return line.length;
  }
  return utf8Decoder.decode(bytes.subarray(0, byteOffset)).length;
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

const splitLines = (contents: string): ReadonlyArray<string> => {
  if (contents.length === 0) {
    return [];
  }
  const parts = contents.split('\n');
  if (parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
};

const collectLineBuckets = (
  difftFile: DifftFile,
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
) => {
  const lhsByLine = new Map<number, Array<IntraLineRange>>();
  const rhsByLine = new Map<number, Array<IntraLineRange>>();

  const pushChanges = (
    target: Map<number, Array<IntraLineRange>>,
    lineNumber: number,
    line: string,
    changes: ReadonlyArray<DifftChange>,
    isOneSided: boolean,
  ) => {
    // Detect difft's per-character fallback (seen on template-literal
    // continuations and similar): a long run of adjacent 1-byte ranges
    // means difft gave up on structural pairing and just emitted every
    // byte. Suppress regardless of pairing — there's nothing to compare.
    let run = 0;
    let maxRun = 0;
    let lastEnd = Number.NEGATIVE_INFINITY;
    for (const change of changes) {
      const isSingleByte = change.end - change.start === 1;
      if (isSingleByte && change.start === lastEnd) {
        run += 1;
      } else if (isSingleByte) {
        run = 1;
      } else {
        run = 0;
      }
      if (run > maxRun) {
        maxRun = run;
      }
      lastEnd = change.end;
    }
    if (maxRun >= 5) {
      return;
    }

    // One-sided rows (pure add/delete in difft's chunk) with every
    // non-whitespace byte covered are just visual noise — the row-level
    // bg already conveys it. Paired rows keep their boxes so the user
    // can compare lhs↔rhs token-for-token.
    if (isOneSided) {
      const lineBytes = utf8Encoder.encode(line);
      if (lineBytes.length > 0) {
        const covered = new Uint8Array(lineBytes.length);
        for (const change of changes) {
          const start = Math.max(0, change.start);
          const end = Math.min(lineBytes.length, change.end);
          for (let i = start; i < end; i += 1) {
            covered[i] = 1;
          }
        }
        let hasUncoveredToken = false;
        for (let i = 0; i < lineBytes.length; i += 1) {
          const byte = lineBytes[i];
          if (!covered[i] && byte !== 0x20 && byte !== 0x09) {
            hasUncoveredToken = true;
            break;
          }
        }
        if (!hasUncoveredToken) {
          return;
        }
      }
    }

    let list = target.get(lineNumber);
    for (const change of changes) {
      const start = byteToCharOffset(line, change.start);
      const end = byteToCharOffset(line, change.end);
      if (end <= start) {
        continue;
      }
      if (!list) {
        list = [];
        target.set(lineNumber, list);
      }
      list.push({ end, start });
    }
  };

  for (const chunk of difftFile.chunks) {
    for (const row of chunk) {
      const isOneSided = !(row.lhs && row.rhs);
      if (row.lhs && row.lhs.line_number < oldLines.length) {
        pushChanges(
          lhsByLine,
          row.lhs.line_number,
          oldLines[row.lhs.line_number],
          row.lhs.changes,
          isOneSided,
        );
      }
      if (row.rhs && row.rhs.line_number < newLines.length) {
        pushChanges(
          rhsByLine,
          row.rhs.line_number,
          newLines[row.rhs.line_number],
          row.rhs.changes,
          isOneSided,
        );
      }
    }
  }

  return { lhsByLine, rhsByLine };
};

// Always returns a non-null object so pierre's char/word fallback never
// fires — empty entries leave rows undecorated rather than re-running
// char-diff on them.
export const buildIntraLineRangesForHunks = (
  difftFile: DifftFile,
  hunks: ReadonlyArray<Hunk>,
  oldContents: string,
  newContents: string,
): FileIntraLineRanges => {
  // Text-mode means difft bailed (unsupported language or DFT_GRAPH_LIMIT
  // exceeded); its per-char output is no better than pierre's char-diff.
  if (difftFile.language === 'Text' || difftFile.language.startsWith('Text (')) {
    return { additions: {}, deletions: {} };
  }
  const oldLines = splitLines(oldContents);
  const newLines = splitLines(newContents);
  const { lhsByLine, rhsByLine } = collectLineBuckets(difftFile, oldLines, newLines);

  const deletions: Record<number, Array<IntraLineRange>> = {};
  const additions: Record<number, Array<IntraLineRange>> = {};

  for (const hunk of hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== 'change') {
        continue;
      }
      for (let i = 0; i < content.deletions; i += 1) {
        const delIdx = content.deletionLineIndex + i;
        const delRanges = lhsByLine.get(delIdx);
        if (delRanges && delRanges.length > 0) {
          deletions[delIdx] = delRanges;
        }
      }
      for (let i = 0; i < content.additions; i += 1) {
        const addIdx = content.additionLineIndex + i;
        const addRanges = rhsByLine.get(addIdx);
        if (addRanges && addRanges.length > 0) {
          additions[addIdx] = addRanges;
        }
      }
    }
  }

  return { additions, deletions };
};
