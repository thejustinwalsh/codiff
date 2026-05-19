# Difftastic engine — handoff

State snapshot for resuming the `feat/difftastic-engine` work on another
machine. **Delete this file before merging upstream.**

## Branch state

```
fc8b2b9 Wire the difftastic engine into the diff view.
12203d2 Add size-bounded LRU cache for parsed diff metadata.
0fbc722 Add bounded async queue for difftastic requests.
e31d0c1 Add difftastic JSON parser and intra-line range decorator.
5fa3676 Add electron IPC for invoking difftastic.
ac3f6ea Fix for large directories of untracked files + binary files.
```

Five focused commits on top of `ac3f6ea`. Each builds/tests/lints green
in isolation (later commits depend on earlier ones, but no in-between
commit is broken). 51 tests pass at HEAD.

## What's uncommitted (and intentionally so)

- `pnpm-workspace.yaml` and `pnpm-lock.yaml` — a local override pointing
  `@pierre/diffs` at the pierre fork tarball. Required for local dev
  until pierre publishes the `intraLineRanges` field upstream. **Do not
  push.**

## Architecture (one-paragraph version)

Pierre's `parseDiffFromFile` drives everything — hunks, line layout,
pairing. Difftastic runs out-of-process via IPC and contributes only
per-token `intraLineRanges` as an overlay on the resulting
`FileDiffMetadata`. Pierre's renderer checks `intraLineRanges`; when
set, it skips its char/word fallback for each row, otherwise falls back
to char-diff. When difft errors for a file we deliberately leave
`intraLineRanges` unset so the user gets pierre's char-diff plus a small
warning icon in the file header.

## Module map

- `src/difftastic.ts` — JSON parser + `buildIntraLineRangesForHunks`. The
  pure decorator: walks pierre's hunks, looks up difft's per-line tokens
  for the addition/deletion rows in `change` blocks, applies suppression
  heuristics (text-mode bailout; long runs of consecutive 1-byte ranges;
  one-sided rows where every non-whitespace byte is covered).
- `src/difftStore.ts` — Bounded async queue (6 in-flight, 8 pending,
  oldest-pending eviction), result/error tracking, `useDifftStore` hook
  that encapsulates `useSyncExternalStore`.
- `src/parsedDiffCache.ts` — Size-bounded LRU (~100MB JS heap cap) for
  parsed `FileDiffMetadata`. Prune-by-prefix for stale fingerprints.
- `src/App.tsx` — Integration: `useDifftStore`, `difftLookup` callback,
  `DifftStatusIndicator` (pending / errored / idle), two forwarding
  effects that call `pruneCachesForState` / `ensureDifftForVisibleFiles`
  with the latest React state.
- `electron/difftastic.cjs` — IPC handler. Bumps `DFT_GRAPH_LIMIT` to
  30M so fewer files fall back to per-character text mode.

## Pierre fork dependency

Codiff's `intraLineRanges` field comes from a pierre fork:

- Repo: `/Users/tjw/Developer/pierre` (remote `origin` is
  `git@github.com:thejustinwalsh/pierre.git`, upstream is
  `git@github.com:pierrecomputer/pierre.git`).
- Branch: `feat/intra-line-ranges` (based on tag `diffs-v1.2.0-beta.6`).
- Uncommitted on that branch:
  - `packages/diffs/src/types.ts` — adds `intraLineRanges?` to
    `FileDiffMetadata`, plus `IntraLineRange` and `FileIntraLineRanges`.
  - `packages/diffs/src/utils/renderDiffWithHighlighter.ts` — checks
    `diff.intraLineRanges` first; if set, emits `data-diff-span` from the
    supplied ranges instead of running `diffChars`/`diffWordsWithSpace`.
  - `packages/diffs/test/intraLineRanges.test.ts` — 4 tests.
  - `packages/diffs/pierre-diffs-1.2.0-beta.6-difft-ranges.1.tgz` — the
    packed tarball codiff currently consumes.

The codiff PR cannot land upstream until the pierre changes are
published (Pierre owns the version cadence).

## How to resume on a fresh machine

```sh
# 1. Clone both repos.
git clone git@github.com:thejustinwalsh/codiff.git
git clone git@github.com:thejustinwalsh/pierre.git

# 2. Check out the branches.
cd codiff && git checkout feat/difftastic-engine
cd ../pierre && git checkout feat/intra-line-ranges

# 3. Pack the pierre fork. Strip devDependencies first — bun catalog
#    refs break pnpm consumers.
cd packages/diffs
# (edit package.json: delete the "devDependencies" block)
bun pm pack
git checkout package.json
cp pierre-diffs-1.2.0-beta.6-difft-ranges.1.tgz /tmp/pierre-diffs-difft-ranges.tgz

# 4. In codiff, add the override + install.
cd ../../../codiff
# Edit pnpm-workspace.yaml — add under `overrides:`:
#   '@pierre/diffs': 'file:/tmp/pierre-diffs-difft-ranges.tgz'
pnpm install --force

# 5. Verify.
node node_modules/vite-plus/bin/vp test     # → 51 passed
node node_modules/vite-plus/bin/vp check    # → clean
node node_modules/vite-plus/bin/vp build    # → ✓
node bin/codiff.js .                        # → Electron app launches
```

## Next steps (in roughly the right order)

1. **Visual sanity-check** on the new machine — open codiff against its
   own repo, confirm: spinner appears while difft runs, structural
   per-token boxes show on real edits, warning icon appears if difft
   errors, pierre's char-diff falls back on text-mode files.
2. **Pierre fork**: commit the uncommitted changes on
   `feat/intra-line-ranges`. Pierre's `AGENTS.md` requires that PR
   title/body/comments be human-written and disclose AI assistance.
3. **Open upstream pierre PR** against `pierrecomputer/pierre`. Justin
   composes title/body/comments. Tarball can be regenerated as needed
   while the PR is open.
4. **Revert** `pnpm-workspace.yaml` + `pnpm-lock.yaml` once the
   `intraLineRanges` field ships in an upstream `@pierre/diffs` release.
   Bump the `@pierre/diffs` dependency to that version.
5. **Delete this file** (`HANDOFF.md`).
6. **Open codiff PR** against `nkzw-tech/codiff` with screenshots
   showing the structural diff in action. Link the pierre PR as a
   dependency.

## Backups

- `backup/difftastic-decorator-20260517-144202` — pre-cleanup snapshot
  commit (`84d371d`). Captures the working state before the
  store-extraction + per-store hooks refactor. Safe to delete after
  upstream PRs land.

## Gotchas

- **`bin/codiff.js` loads `dist/`** — code edits don't show in the
  running Electron until you run `vp build`. There's no dev server in
  this flow.
- **`difft` must be on PATH** — codiff's IPC handler probes for it with
  `which difft`. If absent, difft is silently disabled (no spinner, no
  warning icon) and pierre's char-diff runs as the only intra-line
  source. That's the intended fallback.
- **safe-chain bypass**: do not pass `--safe-chain-skip-minimum-package-age`
  without explicit approval. Justin's npm policy uses safe-chain for
  supply-chain protection.
- **Git commit identity**: configured author is
  `Justin Walsh <contact.me@thejustinwalsh.com>`. Do not override with
  `-c user.email`. Do not add `Co-Authored-By: Claude` trailers.
- **Codiff commit style** (cpojer): single-line subject, sentence-case,
  period-terminated, no body, no conventional-commit prefix, no AI
  trailer. See `git log --oneline` for examples.
