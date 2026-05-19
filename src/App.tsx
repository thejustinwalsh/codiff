import {
  parseDiffFromFile,
  parsePatchFiles,
  registerCustomTheme,
  type CodeViewItem,
  type CodeViewOptions,
  type FileDiffMetadata,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { buildIntraLineRangesForHunks, parseDifftJson } from './difftastic.ts';
import { DifftStore, type DifftStatus, useDifftStore } from './difftStore.ts';
import { ParsedDiffCache } from './parsedDiffCache.ts';
import dunkelTheme from './themes/dunkel.json' with { type: 'json' };
import lichtTheme from './themes/licht.json' with { type: 'json' };
import type {
  ChangedFile,
  CodiffPreferences,
  DiffSection,
  GitFileStatus,
  RepositoryState,
} from './types.ts';

type DiffEngine = 'codiff' | 'difftastic';

const DIFFT_MAX_INFLIGHT = 6;
const DIFFT_QUEUE_MAX = 8;

type CodeViewInstance = NonNullable<ReturnType<CodeViewHandle<undefined>['getInstance']>>;

registerCustomTheme('Licht', async () => lichtTheme as never);
registerCustomTheme('Dunkel', async () => dunkelTheme as never);

const statusLabel: Record<GitFileStatus, string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

const sectionLabel: Record<DiffSection['kind'], string> = {
  commit: 'Commit',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

const statusForTree: Record<
  GitFileStatus,
  'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'
> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  untracked: 'untracked',
};

// 11px needed to account for the box shadow around individual diffs
const DEFAULT_PADDING = 11;

const codeViewLayout = {
  // 2px is used to account for a 10px gap with the 1px box shadows
  gap: 12,
  paddingBottom: DEFAULT_PADDING,
  paddingTop: DEFAULT_PADDING,
};

const codeViewItemMetrics = {
  diffHeaderHeight: 54,
};

const workerHighlighterOptions = {
  lineDiffType: 'char' as const,
  maxLineDiffLength: 2000,
  theme: {
    dark: 'Dunkel',
    light: 'Licht',
  },
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

const maxWorkerThreads = 3;

const fileTreeSort = (
  left: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
  right: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
) => compareTreePaths(left.path, right.path);

const defaultPreferences: CodiffPreferences = {
  showWhitespace: false,
};

const codeViewUnsafeCSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
    --diffs-light-bg: #ffffff;
    --diffs-dark-bg: #1c1c1c;
  }

  /* Align scrollbar with number column */
  [data-code]::-webkit-scrollbar-track {
    margin-left: var(--diffs-column-number-width);
  }

  /* Ensure right edge of scrollbar never gets cropped by rounded corners */
  [data-file] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="single"] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="split"] [data-code][data-additions]::-webkit-scrollbar-track {
    margin-right: 14px;
  }
`;

const compactPath = (path: string) => {
  const homePath = path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~');
  const parts = homePath.split('/').filter(Boolean);

  if (parts.length <= 2) {
    return homePath;
  }

  const prefix = homePath.startsWith('/') ? '/' : '';
  const [first, ...rest] = parts;
  const last = rest.pop();
  const middle = rest.map((part) => part[0]).join('/');

  return `${prefix}${first}/${middle ? `${middle}/` : ''}${last}`;
};

function compareTreePaths(leftPath: string, rightPath: string) {
  const leftParts = leftPath.split('/');
  const rightParts = rightPath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === right) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return left.localeCompare(right);
  }

  return leftParts.length - rightParts.length;
}

const sortFiles = (files: ReadonlyArray<ChangedFile>) =>
  [...files].sort((left, right) => compareTreePaths(left.path, right.path));

const fuzzyMatches = (path: string, query: string) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const normalizedPath = path.toLowerCase();
  let pathIndex = 0;
  for (const character of normalizedQuery) {
    pathIndex = normalizedPath.indexOf(character, pathIndex);
    if (pathIndex === -1) {
      return false;
    }
    pathIndex += 1;
  }
  return true;
};

type NativeInputEventTarget = EventTarget & {
  closest?: (selector: string) => Element | null;
  isContentEditable?: boolean;
};

export const isNativeInputTarget = (target: EventTarget | null) => {
  const candidate = target as NativeInputEventTarget | null;
  return (
    candidate?.closest?.('input, select, textarea') != null || candidate?.isContentEditable === true
  );
};

const getViewedKey = (root: string) => `codiff:viewed:${root}`;

const getReloadShortcutLabel = () => {
  const platform = navigator.platform.toLowerCase();
  return platform.includes('mac') ? '⌘R' : 'Ctrl+R';
};

const readViewed = (root: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(getViewedKey(root)) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const writeViewed = (root: string, viewed: Record<string, string>) => {
  localStorage.setItem(getViewedKey(root), JSON.stringify(viewed));
};

const getItemId = (section: DiffSection) => `diff:${section.id}`;

const getItemVersion = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash >>> 0;
};

type CodeViewItemMetadata = {
  difftStatus: DifftStatus;
  file: ChangedFile;
  isCollapsed: boolean;
  isSelected: boolean;
  isViewed: boolean;
  section: DiffSection;
  sectionCount: number;
};

const createBinaryFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: [`${section.summary?.reason ?? 'Binary file changed.'}\n`],
  cacheKey: `summary:${file.fingerprint}:${section.id}:${section.loadState ?? 'binary'}:${
    section.summary?.reason ?? ''
  }`,
  deletionLines: [],
  hunks: [
    {
      additionCount: 1,
      additionLineIndex: 0,
      additionLines: 1,
      additionStart: 1,
      collapsedBefore: 0,
      deletionCount: 0,
      deletionLineIndex: 0,
      deletionLines: 0,
      deletionStart: 0,
      hunkContent: [
        {
          additionLineIndex: 0,
          additions: 1,
          deletionLineIndex: 0,
          deletions: 0,
          type: 'change',
        },
      ],
      hunkSpecs: '@@ -0,0 +1 @@\n',
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
      splitLineCount: 1,
      splitLineStart: 0,
      unifiedLineCount: 1,
      unifiedLineStart: 0,
    },
  ],
  isPartial: true,
  name: file.path,
  prevName: file.oldPath,
  splitLineCount: 1,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 1,
});

const createEmptyFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: section.newFile?.contents.split('\n') ?? [],
  cacheKey: `empty:${file.fingerprint}:${section.id}`,
  deletionLines: section.oldFile?.contents.split('\n') ?? [],
  hunks: [],
  isPartial: false,
  name: section.newFile?.name ?? file.path,
  prevName: section.oldFile?.name ?? file.oldPath,
  splitLineCount: 0,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 0,
});

const parsedDiffCache = new ParsedDiffCache();

const getSectionCacheIdentity = (section: DiffSection) =>
  [
    section.loadState ?? 'ready',
    section.summary?.reason ?? '',
    section.oldFile?.cacheKey ?? '',
    section.newFile?.cacheKey ?? '',
    section.patch.length,
  ].join(':');

const parseSectionDiffWithOptions = (
  file: ChangedFile,
  section: DiffSection,
  showWhitespace: boolean,
  engine: DiffEngine,
  difftJson: string | null,
  difftErrored: boolean,
): FileDiffMetadata => {
  const baseCacheKey = `${file.fingerprint}:${section.id}:${getSectionCacheIdentity(section)}:${
    showWhitespace ? 'ws' : 'ignore-ws'
  }`;
  const cacheKey =
    engine === 'difftastic'
      ? difftJson
        ? `${baseCacheKey}:difft:${difftJson.length}:${difftJson.slice(0, 64)}`
        : difftErrored
          ? `${baseCacheKey}:difft-errored`
          : `${baseCacheKey}:difft-pending`
      : `${baseCacheKey}:codiff`;
  const cached = parsedDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let fileDiff: FileDiffMetadata;
  if (section.binary || (section.loadState != null && section.loadState !== 'ready')) {
    fileDiff = createBinaryFileDiff(file, section);
  } else if (section.oldFile && section.newFile) {
    try {
      const base = parseDiffFromFile(section.oldFile, section.newFile, {
        ignoreWhitespace: !showWhitespace,
      });
      let overlayed = base;
      if (engine === 'difftastic') {
        if (difftJson) {
          overlayed = overlayDifftRanges(
            base,
            difftJson,
            section.oldFile.contents,
            section.newFile.contents,
          );
        } else if (!difftErrored) {
          // Pending — keep pierre's char-diff suppressed until ranges land.
          overlayed = { ...base, intraLineRanges: EMPTY_INTRA_LINE_RANGES };
        }
        // Errored: leave intraLineRanges unset → pierre falls back to char-diff.
      }
      fileDiff = { ...overlayed, cacheKey };
    } catch {
      fileDiff = createEmptyFileDiff(file, section);
    }
  } else {
    const parsedFileDiff = parsePatchFiles(section.patch)[0]?.files[0];
    fileDiff = parsedFileDiff
      ? {
          ...parsedFileDiff,
          cacheKey,
        }
      : createBinaryFileDiff(file, section);
  }

  parsedDiffCache.set(cacheKey, fileDiff);
  return fileDiff;
};

// Empty entries while difft is in-flight so pierre's char-diff fallback
// doesn't briefly fire and then disappear once ranges land.
const EMPTY_INTRA_LINE_RANGES = { additions: {}, deletions: {} };

const overlayDifftRanges = (
  base: FileDiffMetadata,
  difftJson: string,
  oldContents: string,
  newContents: string,
): FileDiffMetadata => {
  try {
    // IPC invokes difft once per (oldFile, newFile) pair, so the JSON has
    // exactly one entry — [0] is the file we care about.
    const difftFile = parseDifftJson(difftJson)[0];
    if (!difftFile) {
      return base;
    }
    const intraLineRanges = buildIntraLineRangesForHunks(
      difftFile,
      base.hunks,
      oldContents,
      newContents,
    );
    return { ...base, intraLineRanges };
  } catch {
    // Fall back to pierre's char-diff by leaving intraLineRanges unset.
    return base;
  }
};

const fileHasMetadataDiff = (file: ChangedFile) =>
  file.status === 'renamed' && file.oldPath != null && file.oldPath !== file.path;

const sectionHasVisibleDiff = (
  file: ChangedFile,
  section: DiffSection,
  fileDiff: FileDiffMetadata,
) =>
  section.binary ||
  (section.loadState != null && section.loadState !== 'ready') ||
  fileHasMetadataDiff(file) ||
  fileDiff.hunks.length > 0;

export type DifftLookup = (sectionId: string) => { errored: boolean; json: string | null };

const NO_DIFFT_LOOKUP: DifftLookup = () => ({ errored: false, json: null });

export const getVisibleDiffSections = (
  file: ChangedFile,
  showWhitespace: boolean,
  engine: DiffEngine = 'codiff',
  difftLookup: DifftLookup = NO_DIFFT_LOOKUP,
) =>
  file.sections
    .map((section) => {
      const state = difftLookup(section.id);
      return {
        fileDiff: parseSectionDiffWithOptions(
          file,
          section,
          showWhitespace,
          engine,
          state.json,
          state.errored,
        ),
        section,
      };
    })
    .filter(({ fileDiff, section }) => sectionHasVisibleDiff(file, section, fileDiff));

export const fileHasVisibleDiff = (
  file: ChangedFile,
  showWhitespace: boolean,
  engine: DiffEngine = 'codiff',
  difftLookup: DifftLookup = NO_DIFFT_LOOKUP,
) => getVisibleDiffSections(file, showWhitespace, engine, difftLookup).length > 0;

const getFirstVisibleSection = (
  file: ChangedFile,
  showWhitespace: boolean,
  engine: DiffEngine,
  difftLookup: DifftLookup,
) => getVisibleDiffSections(file, showWhitespace, engine, difftLookup)[0]?.section;

function Sidebar({
  files,
  onActivatePath,
  onSearchQueryChange,
  onSelectPath,
  searchQuery,
  selectedPath,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectPath: (path: string) => void;
  searchQuery: string;
  selectedPath: string | null;
}) {
  const allowSelectionScroll = useRef(false);
  const allowSelectionScrollTimer = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const treeHostRef = useRef<HTMLDivElement>(null);
  const suppressSelectionChange = useRef(false);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    onSelectionChange: (paths) => {
      if (suppressSelectionChange.current) {
        return;
      }

      if (!allowSelectionScroll.current) {
        return;
      }
      allowSelectionScroll.current = false;
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
        allowSelectionScrollTimer.current = null;
      }

      const path = paths.at(-1);
      if (path) {
        onSelectPath(path);
      }
    },
    paths,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        border-radius: 14px;
        corner-shape: squircle;
      }
    `,
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(status);
  }, [model, paths, status]);

  const scrollPathIntoView = useCallback(
    (path: string) => {
      model.focusPath(path);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const host = treeHostRef.current?.querySelector('file-tree-container');
          const row = Array.from(
            host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [],
          ).find((element) => element.getAttribute('data-item-path') === path);
          row?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      });
    },
    [model],
  );

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  useEffect(
    () => () => {
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !isNativeInputTarget(event.target) &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) {
      return;
    }

    suppressSelectionChange.current = true;
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    requestAnimationFrame(() => scrollPathIntoView(selectedPath));
    window.setTimeout(() => {
      suppressSelectionChange.current = false;
    }, 0);
  }, [model, scrollPathIntoView, selectedPath]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          placeholder="Filter files"
          ref={searchInputRef}
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      <div className="file-tree-shell" ref={treeHostRef}>
        <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
      </div>
    </>
  );
}

function CodeViewHeader({
  meta,
  onToggleCollapsed,
  onToggleViewed,
}: {
  meta: CodeViewItemMetadata;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
}) {
  const { difftStatus, file, isCollapsed, isSelected, isViewed, section, sectionCount } = meta;

  return (
    <div
      className={`codiff-file-header${isCollapsed ? ' collapsed' : ''}${
        isSelected ? ' selected' : ''
      }${isViewed ? ' viewed' : ''}`}
    >
      <button
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
        className="codiff-header-toggle"
        onClick={() => onToggleCollapsed(file, isCollapsed)}
        title={isCollapsed ? 'Expand' : 'Collapse'}
        type="button"
      >
        <span className="codiff-chevron-box">
          <span className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'} />
        </span>
        <span className="codiff-file-heading">
          <span className="codiff-file-path">{file.path}</span>
          {file.oldPath ? <span className="codiff-file-old-path">{file.oldPath}</span> : null}
        </span>
        {sectionCount > 1 ? (
          <span className={`codiff-section-badge ${section.kind}`}>
            {sectionLabel[section.kind]}
          </span>
        ) : null}
      </button>
      <DifftStatusIndicator status={difftStatus} />
      <div className={`codiff-status-badge ${file.status}`}>{statusLabel[file.status]}</div>
      <button
        aria-pressed={isViewed}
        className={`codiff-viewed-button${isViewed ? ' active' : ''}`}
        onClick={() => onToggleViewed(file, isViewed)}
        type="button"
      >
        <span aria-hidden className="codiff-viewed-checkbox" />
        Viewed
      </button>
    </div>
  );
}

function DifftStatusIndicator({ status }: { status: DifftStatus }) {
  if (status === 'pending') {
    return (
      <span className="codiff-difft-indicator" data-state="pending" role="status">
        <span className="codiff-sr-only">Computing structural diff</span>
      </span>
    );
  }
  if (status === 'errored') {
    return (
      <span
        aria-label="Structural diff failed; showing line-level fallback."
        className="codiff-difft-indicator"
        data-state="errored"
        role="img"
        title="Structural diff failed; showing line-level fallback."
      />
    );
  }
  return <span aria-hidden className="codiff-difft-indicator" data-state="idle" />;
}

function ReviewCodeView({
  collapsed,
  diffEngine,
  difft,
  difftLookup,
  files,
  itemVersionByPath,
  onSelectPathFromScroll,
  onToggleCollapsed,
  onToggleViewed,
  scrollTarget,
  selectedPath,
  showWhitespace,
  viewed,
}: {
  collapsed: ReadonlySet<string>;
  diffEngine: DiffEngine;
  difft: { getStatus: (sectionId: string) => DifftStatus };
  difftLookup: DifftLookup;
  files: ReadonlyArray<ChangedFile>;
  itemVersionByPath: Readonly<Record<string, number>>;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  scrollTarget: { path: string; request: number } | null;
  selectedPath: string | null;
  showWhitespace: boolean;
  viewed: Record<string, string>;
}) {
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const handledScrollRequestRef = useRef<number | null>(null);

  const { firstItemByPath, itemMetadata, items } = useMemo(() => {
    const nextItems: Array<CodeViewItem> = [];
    const nextFirstItemByPath = new Map<string, string>();
    const nextItemMetadata = new Map<string, CodeViewItemMetadata>();

    for (const file of files) {
      const isViewed = viewed[file.path] === file.fingerprint;
      const isCollapsed = collapsed.has(file.path);
      const visibleSections = getVisibleDiffSections(file, showWhitespace, diffEngine, difftLookup);
      const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;

      for (const [index, { fileDiff, section }] of sections.entries()) {
        const id = getItemId(section);
        const difftStatus = difft.getStatus(section.id);
        nextItemMetadata.set(id, {
          difftStatus,
          file,
          isCollapsed,
          isSelected: selectedPath === file.path,
          isViewed,
          section,
          sectionCount: file.sections.length,
        });
        nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
        nextItems.push({
          collapsed: isCollapsed,
          fileDiff,
          id,
          type: 'diff',
          version: getItemVersion(
            `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:${
              isCollapsed ? 'collapsed' : 'open'
            }:${isViewed ? 'viewed' : 'pending'}:${index}:${
              selectedPath === file.path ? 'selected' : 'idle'
            }:${showWhitespace ? 'ws' : 'ignore-ws'}:${diffEngine}:${difftStatus}`,
          ),
        });
      }
    }

    return {
      firstItemByPath: nextFirstItemByPath,
      itemMetadata: nextItemMetadata,
      items: nextItems,
    };
  }, [
    collapsed,
    diffEngine,
    difft,
    difftLookup,
    files,
    itemVersionByPath,
    selectedPath,
    showWhitespace,
    viewed,
  ]);

  const codeViewOptions: CodeViewOptions<undefined> = useMemo(
    () =>
      ({
        diffIndicators: 'bars',
        diffStyle: 'split',
        enableLineSelection: true,
        hunkSeparators: 'simple',
        itemMetrics: codeViewItemMetrics,
        layout: codeViewLayout,
        lineDiffType: 'char',
        stickyHeaders: true,
        theme: {
          dark: 'Dunkel',
          light: 'Licht',
        },
        themeType: 'system',
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<undefined>,
    [],
  );

  const workerPoolOptions = useMemo(
    () => ({
      poolSize: Math.min(
        maxWorkerThreads,
        Math.max(1, navigator.hardwareConcurrency || maxWorkerThreads),
      ),
      workerFactory: () =>
        new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
          type: 'module',
        }),
    }),
    [],
  );

  const scrollItemHeaderIntoView = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return false;
    }

    handle.scrollTo({
      behavior: 'instant',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });

    return true;
  }, []);

  useEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      const itemId = firstItemByPath.get(scrollTarget.path);
      if (itemId && scrollItemHeaderIntoView(itemId)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (attempts < 6) {
        attempts += 1;
        frame = window.requestAnimationFrame(tryScroll);
      }
    };

    tryScroll();

    return () => {
      canceled = true;
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [firstItemByPath, scrollItemHeaderIntoView, scrollTarget]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem) => {
      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          meta={meta}
          onToggleCollapsed={onToggleCollapsed}
          onToggleViewed={onToggleViewed}
        />
      ) : null;
    },
    [itemMetadata, onToggleCollapsed, onToggleViewed],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
    },
    [onSelectPathFromScroll],
  );

  return (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      <CodeView
        className="code-view"
        items={items}
        onScroll={handleScroll}
        options={codeViewOptions}
        ref={codeViewRef}
        renderCustomHeader={renderCustomHeader}
      />
    </WorkerPoolContextProvider>
  );
}

function RepositoryChangeBanner({ visible }: { visible: boolean }) {
  return (
    <div aria-live="polite" className={`repository-change-banner${visible ? ' visible' : ''}`}>
      <span>Local changes detected,</span>
      <button onClick={() => window.location.reload()} type="button">
        {getReloadShortcutLabel()} to reload.
      </button>
    </div>
  );
}

const difftStore = new DifftStore({
  maxInflight: DIFFT_MAX_INFLIGHT,
  maxQueue: DIFFT_QUEUE_MAX,
  onError: (path, reason) => {
    // eslint-disable-next-line no-console
    console.error(`[difft] ${path}:`, reason);
  },
  runner: (params) => window.codiff.runDifft(params),
});

const pruneCachesForState = (state: RepositoryState) => {
  const liveSectionIds = new Set<string>();
  const livePrefixes = new Set<string>();
  for (const file of state.files) {
    for (const section of file.sections) {
      liveSectionIds.add(section.id);
      livePrefixes.add(`${file.fingerprint}:${section.id}`);
    }
  }
  difftStore.prune(liveSectionIds);
  parsedDiffCache.pruneByPrefix(livePrefixes);
};

const ensureDifftForVisibleFiles = (
  state: RepositoryState | null,
  searchQuery: string,
  showWhitespace: boolean,
  engine: DiffEngine,
  difftLookup: DifftLookup,
) => {
  if (engine !== 'difftastic' || !state) {
    return;
  }
  for (const file of state.files) {
    if (
      !fuzzyMatches(file.path, searchQuery) ||
      !fileHasVisibleDiff(file, showWhitespace, engine, difftLookup)
    ) {
      continue;
    }
    for (const section of file.sections) {
      if (
        section.binary ||
        (section.loadState != null && section.loadState !== 'ready') ||
        !section.oldFile ||
        !section.newFile
      ) {
        continue;
      }
      difftStore.ensureRequested({
        newContents: section.newFile.contents,
        newName: section.newFile.name,
        oldContents: section.oldFile.contents,
        oldName: section.oldFile.name,
        path: file.path,
        sectionId: section.id,
      });
    }
  }
};

export default function App() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [difftAvailable, setDifftAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemVersionByPath, setItemVersionByPath] = useState<Record<string, number>>({});
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [scrollTarget, setScrollTarget] = useState<{ path: string; request: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [state, setState] = useState<RepositoryState | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);

  const difft = useDifftStore(difftStore);

  const difftLookup = useCallback<DifftLookup>(
    (sectionId) => ({
      errored: difft.getStatus(sectionId) === 'errored',
      json: difft.getJson(sectionId),
    }),
    [difft],
  );

  const bumpItemVersion = useCallback((path: string) => {
    setItemVersionByPath((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1,
    }));
  }, []);

  useEffect(() => {
    let canceled = false;

    window.codiff
      .getRepositoryState()
      .then((nextState) => {
        if (canceled) {
          return;
        }

        const orderedState = {
          ...nextState,
          files: sortFiles(nextState.files),
        };
        const nextViewed = readViewed(orderedState.root);

        setState(orderedState);
        setError(null);
        setCollapsed(
          new Set(
            orderedState.files
              .filter((file) => nextViewed[file.path] === file.fingerprint)
              .map((file) => file.path),
          ),
        );
        setItemVersionByPath({});
        setViewed(nextViewed);
        setSelectedPath((current) => current ?? orderedState.files[0]?.path ?? null);
      })
      .catch((error: unknown) => {
        if (!canceled) {
          setError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(
    () =>
      window.codiff.onRepositoryChanged(() => {
        setLocalChangesDetected(true);
      }),
    [],
  );

  useEffect(() => {
    if (!state || state.source.type !== 'working-tree' || !selectedPath) {
      return;
    }

    const selectedFile = state.files.find((file) => file.path === selectedPath);
    if (!selectedFile) {
      return;
    }

    const deferredSections = selectedFile.sections.filter(
      (section) => section.loadState === 'deferred' && section.summary?.canLoad !== false,
    );

    if (!deferredSections.length) {
      return;
    }

    let canceled = false;

    for (const section of deferredSections) {
      const key = `${state.root}:${section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        continue;
      }

      loadingSectionKeysRef.current.add(key);
      window.codiff
        .getDiffSectionContent({
          force: true,
          kind: section.kind,
          path: selectedFile.path,
          source: state.source,
        })
        .then((loadedSection) => {
          if (canceled) {
            return;
          }

          setState((current) => {
            if (!current || current.root !== state.root) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === selectedFile.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === section.id ? loadedSection : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(selectedFile.path);
        })
        .catch(() => {
          if (!canceled) {
            setState((current) => {
              if (!current || current.root !== state.root) {
                return current;
              }

              return {
                ...current,
                files: current.files.map((file) =>
                  file.path === selectedFile.path
                    ? {
                        ...file,
                        sections: file.sections.map((candidate) =>
                          candidate.id === section.id
                            ? {
                                ...candidate,
                                loadState: 'error',
                                summary: {
                                  canLoad: false,
                                  reason: 'Codiff could not load this file.',
                                },
                              }
                            : candidate,
                        ),
                      }
                    : file,
                ),
              };
            });
            bumpItemVersion(selectedFile.path);
          }
        })
        .finally(() => {
          loadingSectionKeysRef.current.delete(key);
        });
    }

    return () => {
      canceled = true;
    };
  }, [bumpItemVersion, selectedPath, state]);

  useEffect(() => {
    let canceled = false;

    window.codiff.getPreferences().then((nextPreferences) => {
      if (!canceled) {
        setPreferences(nextPreferences);
      }
    });

    const removeListener = window.codiff.onPreferencesChanged((nextPreferences) => {
      setPreferences(nextPreferences);
    });

    return () => {
      canceled = true;
      removeListener();
    };
  }, []);

  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let canceled = false;
    window.codiff.isDifftAvailable().then((available) => {
      if (!canceled) {
        setDifftAvailable(available);
      }
    });
    return () => {
      canceled = true;
    };
  }, []);

  const showWhitespace = preferences.showWhitespace;
  const diffEngine: DiffEngine = difftAvailable ? 'difftastic' : 'codiff';

  const visibleFiles = useMemo(
    () =>
      state
        ? state.files.filter(
            (file) =>
              fuzzyMatches(file.path, searchQuery) &&
              fileHasVisibleDiff(file, showWhitespace, diffEngine, difftLookup),
          )
        : [],
    [diffEngine, difftLookup, searchQuery, showWhitespace, state],
  );

  useEffect(() => {
    if (state) {
      pruneCachesForState(state);
    }
  }, [state]);

  useEffect(() => {
    ensureDifftForVisibleFiles(
      state,
      searchQuery,
      preferences.showWhitespace,
      diffEngine,
      difftLookup,
    );
  }, [diffEngine, difftLookup, preferences.showWhitespace, searchQuery, state]);

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const activatePath = useCallback((path: string) => {
    setSelectedPath(path);
    setScrollTarget((current) => ({
      path,
      request: (current?.request ?? 0) + 1,
    }));
    programmaticScrollPathRef.current = path;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollPathRef.current = null;
      programmaticScrollTimerRef.current = null;
    }, 1200);
  }, []);

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion],
  );

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (!visibleFiles.length) {
        return;
      }

      const scrollTop = viewer.getScrollTop();
      const activationTop = scrollTop + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, showWhitespace, diffEngine, difftLookup);
        const itemId = section ? getItemId(section) : null;
        const itemTop = itemId ? viewer.getTopForItem(itemId) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      const programmaticScrollPath = programmaticScrollPathRef.current;
      if (programmaticScrollPath && nextPath !== programmaticScrollPath) {
        return;
      }

      if (programmaticScrollPath) {
        programmaticScrollPathRef.current = null;
        if (programmaticScrollTimerRef.current != null) {
          window.clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [diffEngine, difftLookup, showWhitespace, visibleFiles],
  );

  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean) => {
      if (!state) {
        return;
      }

      setViewed((current) => {
        if (isViewed) {
          const next = { ...current };
          delete next[file.path];
          writeViewed(state.root, next);
          return next;
        }

        const next = {
          ...current,
          [file.path]: file.fingerprint,
        };
        writeViewed(state.root, next);
        return next;
      });

      setCollapsed((current) => {
        if (isViewed) {
          const next = new Set(current);
          next.delete(file.path);
          return next;
        }

        const next = new Set(current);
        next.add(file.path);
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion, state],
  );

  if (error) {
    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          <strong>Unable to read repository</strong>
          <span>{error}</span>
        </div>
      </main>
    );
  }

  if (!state) {
    return <main className="loading">Loading</main>;
  }

  const visibleSelectedPath =
    selectedPath && visibleFiles.some((file) => file.path === selectedPath)
      ? selectedPath
      : (visibleFiles[0]?.path ?? null);

  return (
    <div className="app-shell">
      <RepositoryChangeBanner visible={localChangesDetected} />
      <aside className="sidebar squircle">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            <div className="sidebar-path" title={state.root}>
              {compactPath(state.root)}
            </div>
          </div>
        </div>
        <Sidebar
          files={visibleFiles}
          onActivatePath={activatePath}
          onSearchQueryChange={setSearchQuery}
          onSelectPath={selectPath}
          searchQuery={searchQuery}
          selectedPath={visibleSelectedPath}
        />
      </aside>
      <main className="review">
        {state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>No local changes</strong>
              <span>{state.root}</span>
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>No matching files</strong>
              <span>
                {searchQuery || (showWhitespace ? state.root : 'Whitespace-only changes hidden')}
              </span>
            </div>
          </div>
        ) : (
          <ReviewCodeView
            collapsed={collapsed}
            diffEngine={diffEngine}
            difft={difft}
            difftLookup={difftLookup}
            files={visibleFiles}
            itemVersionByPath={itemVersionByPath}
            onSelectPathFromScroll={updateSelectedPathFromScroll}
            onToggleCollapsed={toggleCollapsed}
            onToggleViewed={toggleViewed}
            scrollTarget={scrollTarget}
            selectedPath={visibleSelectedPath}
            showWhitespace={showWhitespace}
            viewed={viewed}
          />
        )}
      </main>
    </div>
  );
}
