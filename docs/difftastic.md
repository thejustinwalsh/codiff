# Difftastic engine

Codiff can optionally use [difftastic](https://difftastic.wilfred.me.uk/) as its
diff engine. When enabled, codiff replaces its line-based hunking with
difftastic's syntax-aware structural diff and renders the result through the
existing `@pierre/diffs` `CodeView`.

## Activation

- Difftastic support is gated on `difft` being available on the user's `PATH`.
  - The Electron main process probes for `difft` at startup and on demand.
  - When `difft` is not found, the renderer hides the toggle UI entirely.
- When `difft` is found, the renderer shows a "Diff engine" toggle alongside
  the existing whitespace preference. The toggle is per-session and switches
  the engine for every visible file.

The integration shells out to `difft --display=json --color=never`. The
`DFT_UNSTABLE=yes` environment variable is set because the JSON format is
documented as unstable upstream; this matches how every other tool that
consumes difftastic JSON (clabby/difftastic.nvim, marcoroth/difftastic-ruby,
…) opts in.

## Pipeline

```
git diff → DiffSection (oldFile, newFile, patch)
                         │
                         ▼ (only when engine === 'difftastic')
                   write temp files
                         │
                         ▼
       difft --display=json --color=never <old> <new>
                         │
                         ▼
                  DifftFile JSON
                         │
                         ▼ transformer (renderer-side, pure)
                   FileDiffMetadata
                         │
                         ▼
                       CodeView
```

The pipeline preserves the existing UI affordances (sticky headers, line
selection, viewed/collapsed state, fingerprint-based caching). Only the
hunking and per-file diff content changes.

## JSON shape

Difftastic emits one JSON object per file. The fields we consume:

| Field           | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | `"changed" \| "created" \| "deleted" \| "unchanged"`                                                                                                                |
| `language`      | Detected language string, e.g. `"JavaScript"`                                                                                                                       |
| `aligned_lines` | Array of `[lhsLine, rhsLine]` pairs covering the full file. Either side may be `null` to indicate a filler row (pure addition/deletion). 0-indexed.                 |
| `chunks`        | Array of hunks. Each hunk is an array of `{lhs?, rhs?}` rows. Each side has `{line_number, changes[]}`. `changes[]` describes the highlighted regions on that line. |

Difftastic's chunks contain only changed rows. Context rows are recovered from
`aligned_lines`.

The type model ports directly from
[clabby/difftastic.nvim's `src/difftastic.rs`](https://github.com/clabby/difftastic.nvim/blob/main/src/difftastic.rs)
to keep us aligned with an existing, well-tested consumer. The chunk-to-hunk
walk borrows from `src/processor.rs` in the same project.

## Transformer

Module: `src/difftastic.ts`

Exports:

- `DifftFile` and friends — TypeScript ports of the JSON types.
- `parseDifftJson(stdout: string): ReadonlyArray<DifftFile>` —
  newline-separated JSON objects (git) and single-array (jj) both accepted.
- `buildFileDiff(file: DifftFile, oldContents: string, newContents: string):
FileDiffMetadata | null` — the structural transformer. Returns `null` for
  `unchanged` files so callers can filter them via the existing
  `sectionHasVisibleDiff` predicate.

The transformer:

1. For `created`: one hunk where every new-file line is an addition.
2. For `deleted`: one hunk where every old-file line is a deletion.
3. For `changed`:
   - Identify the rows in `aligned_lines` that are part of at least one
     difftastic chunk (their `line_number` appears on either side, or the
     row has a filler).
   - Group these into hunks, including up to 4 context rows on either side
     (matching `parseDiffFromFile`'s default context, so codiff- and
     difftastic-rendered hunks have the same shape). Adjacent groups whose
     context windows touch are merged.
   - For each hunk, walk its rows in order, alternating `ContextContent`
     and `ChangeContent` blocks. A row is a "change" iff either side is
     `null` (filler) or the matching difftastic chunk row has a non-empty
     `changes[]`.
   - Compute `additionStart`, `deletionStart`, line counts, and the
     split/unified line counts in the form `@pierre/diffs` expects.
4. For `unchanged`: return `null` so the section can be filtered out by the
   existing `sectionHasVisibleDiff` predicate.

Intra-line char highlights are left to `@pierre/diffs`'s built-in
`lineDiffType: 'char'` pass. Difftastic's `Change.start/end` ranges are
ignored for v1 — the structural-vs-line distinction at the hunk level is
where most of the value lies, and feeding custom intra-line highlights
through `FileDiffMetadata` is not part of its public surface. We can
revisit if upstream wants it.

## Electron IPC

Module: `electron/difftastic.cjs` (new), wired through `electron/main.cjs`.

New IPC handlers:

- `codiff:isDifftAvailable()` → `boolean`. Probes `which difft` (or
  `where difft` on Windows) and caches the result for the session.
- `codiff:refreshDifftAvailability()` → `boolean`. Forces a re-probe.
- `codiff:runDifft({oldContents, newContents, oldName, newName})` →
  `{json?: string, error?: string}`. Writes the two contents to a
  per-call temp directory (`mkdtemp` under `os.tmpdir()`), invokes
  `difft`, returns stdout. The temp directory is removed in a `finally`
  block regardless of outcome.

`difft` is invoked as `difft --display=json --color=never <old> <new>`
with `DFT_UNSTABLE=yes` set in the environment. The temp filenames keep
the original `basename` so difftastic's filename-based language
detection still fires.

The binary name is `difft` by default. The
`CODIFF_DIFFT_BINARY` environment variable overrides this — used by the
electron tests to simulate a missing binary, but it could also let users
point at an installation outside `PATH`.

## Renderer wiring

- The diff engine is per-window React state, not a persisted preference.
  Difftastic is opt-in, ephemeral, and only ever shown when the binary
  is present — there is nothing to migrate, and switching engines
  doesn't bleed across windows.
- On mount, `App` calls `window.codiff.isDifftAvailable()` and stores
  the result. When `false`, the toggle is not rendered at all.
- When the user enables difftastic, an effect walks `visibleFiles` and
  starts a `runDifft` IPC call for each section whose JSON we haven't
  cached yet, tracking in-flight requests via a `ref` to satisfy the
  `react-hooks/set-state-in-effect` lint rule. The codiff engine is
  used as a fallback while the JSON loads (and permanently if `difft`
  errors out for that section).
- `parseSectionDiffWithOptions` takes the engine and the per-section
  JSON map. When `engine === 'difftastic'` and JSON exists, it parses
  via `parseDifftJson` and transforms via `buildFileDiff`. Otherwise it
  falls through to the existing codiff path.
- Cache keys gain a `:codiff` / `:difft:<len>:<prefix>` suffix so the
  two engines' results don't collide in the existing
  `parsedDiffCache`.

## Failure modes

- `difft` exits non-zero or stderr is non-empty → fall back to the codiff
  engine for that section, show an inline notice once per session.
- File > `MANUAL_TEXT_FILE_LIMIT` → keep the existing oversized-file
  short-circuit; difftastic is only invoked on `ready` sections.
- Binary files → skip difftastic entirely; the existing binary section
  rendering path is reused.

## Tests

`src/difftastic.test.ts` covers:

- `parseDifftJson` for the git (newline-separated) and jj (array) shapes,
  including blank-line tolerance.
- `buildFileDiff` for: pure addition (`created`), pure deletion
  (`deleted`), single in-place modification with surrounding context, a
  pure insertion that lands as a filler row, two changes whose context
  windows touch (merged hunk), two changes whose context windows do not
  touch (separate hunks with correct `collapsedBefore`), a hunk that
  begins at line 1 with no leading context, a file with no trailing
  newline on either side (`noEOFCR*` flags), the line-splitting helper,
  and the file-level `splitLineCount`/`unifiedLineCount` aggregates.

`src/difftastic-electron.test.ts` covers:

- Availability detection when `difft` is on `PATH` (skipped if not).
- Availability detection when `CODIFF_DIFFT_BINARY` points at a bogus
  binary — the run helper returns an `error` rather than throwing.
- End-to-end `runDifft` returning real JSON for a real diff (skipped if
  `difft` is not on `PATH`).
- Smoke check that the temp directory is cleaned up after each run.

## Future work (out of scope for this PR)

- Plumb difftastic's intra-line `Change.start/end` through to override
  the renderer's char-level diff. Likely needs a new option on
  `@pierre/diffs` or a custom decoration layer.
- Map difftastic's `language` to `FileDiffMetadata.lang` for files where
  shiki's filename-based detection would be wrong.
- Bundling `difft` per-platform with the Electron app. The current PR
  intentionally keeps installation out of band.
