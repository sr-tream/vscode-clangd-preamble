# clangd-preamble (VS Code)

Make non-self-contained C/C++ headers parse cleanly under clangd in VS Code.

![Demo](./demo.png)

When a header relies on transitive includes from its TU's preamble (`std::string_view`
without `#include <string_view>`, forward-decls without the full type, macros set
upstream of `#include "foo.h"`, etc.), clangd parsed alone produces a cascade of
false-positive errors, broken hover, broken go-to-def, and so on. This extension
hooks the clangd language client to observe outgoing `didOpen` notifications,
builds a TU→header include graph, synthesizes a fake preamble from a recently-seen
includer, prepends it to the buffer text sent to clangd, and bidirectionally
remaps line/column positions across ~30 LSP request/response methods so the
unmodified header is what you see. Diagnostics whose ranges fall inside the
synthesized preamble are dropped; edits that target the preamble are filtered
out before they hit the buffer.

The synthesized preamble is wrapped in `#if __INCLUDE_LEVEL__ == 0 ... #endif`,
so it's only active when clangd parses the header as the translation root —
when the same header is later `#include`'d through some other file's chain the
body is skipped, no redefinition cascades.

This is a port of [clangd-preamble.nvim](https://github.com/sr-tream/clangd-preamble.nvim).

## Requirements

- VS Code **1.75+**
- The official [clangd extension](https://marketplace.visualstudio.com/items?itemName=llvm-vs-code-extensions.vscode-clangd) (declared as an extension dependency).

## Install

Download the latest `vscode-clangd-preamble.vsix` from the
[Releases](https://github.com/sr-tream/vscode-clangd-preamble/releases) page and run:

```bash
code --install-extension vscode-clangd-preamble.vsix
```

The extension activates automatically when a C, C++, CUDA, or Objective-C/C++
file is opened. It piggybacks on the running clangd language client — no
configuration required for the common case.

## Commands

All commands live under the `clangd` category in the command palette.

| Command | Action |
|---|---|
| `clangd Preamble: Reattach Middleware` | Re-install hooks on the running clangd client (use after manual restarts) |
| `clangd Preamble: Refresh Current Header` | Re-pick the includer TU, re-build the preamble, replay `didOpen` |
| `clangd Preamble: Disable for Current File` | Strip preamble for the current file; force a clean re-open |
| `clangd Preamble: Enable for Current File` | Force preamble injection (bypasses the self-contained heuristic) |
| `clangd Preamble: Dump Include Graph` | Dump the observed TU/header graph into the output channel |
| `clangd Preamble: Dump State for Current File` | Print state for the current header (preamble text, includer TU, line count) |
| `clangd Preamble: Dump Suppressed Preamble Diagnostics` | List diagnostics that were suppressed because they fell inside the preamble |
| `clangd Preamble: Scan Project for Includer TUs` | Walk all workspace folders for `.cpp/.cc/...` files and observe their includes — useful when no TU has been opened yet |

## Settings

| Setting | Default | Description |
|---|---|---|
| `clangd-preamble.enabled` | `true` | Master switch. When off, traffic passes through unchanged. |
| `clangd-preamble.maxPreambleLines` | `1500` | Cap on lines emitted into the synthetic preamble. |
| `clangd-preamble.maxPreambleBytes` | `65536` | Cap on bytes emitted into the synthetic preamble. |
| `clangd-preamble.projectScanLimit` | `2000` | Maximum number of TU files visited by `Scan Project for Includer TUs`. |
| `clangd-preamble.defaultSelector` | `preambleSize` | Default preamble source selector for headers without a per-file override. Use `preambleSize` for the smallest include prefix before the header, or `lastSeen` for the most recently observed includer TU. |
| `clangd-preamble.markerComment` | `// __NSC_PREAMBLE_END__` | Single-line comment appended to the preamble so it ends on a known marker. |
| `clangd-preamble.log` | `false` | Log middleware activity to the `clangd Preamble` output channel. |

## Status bar

When the active editor is a header with an injected preamble, the status bar
shows `Preamble: <TU>.cpp` with a tooltip listing the includer TU, preamble
line count, direct/indirect flag, and dropped-diagnostic count. Clicking it
runs `Refresh Current Header`. While a header is waiting for an includer TU
to be observed, the status item shows `Preamble: pending` instead.

## How it works

1. **Include graph.** Outgoing `didOpen` for `.cpp/.cc/.cxx/.c/.C/.mm` files is
   intercepted; the file's `#include` directives are parsed into a TU↔header
   graph indexed by basename.
2. **Includer pick.** When a header opens, the graph is queried for the TU
   with the **shortest prefix-before-this-header** (tie-break: most recent
   observation) by default. `clangd-preamble.defaultSelector` can instead make
   the default follow the most recently observed includer TU. Per-header
   selector choices override this setting. Companion-TU fallback (`Foo.cpp`
   next to `Foo.h`) covers the header-opened-alone case.
3. **Self-contained skip.** Headers with **3 or more own `#include`
   directives** are likely self-contained and skipped automatically — the
   preamble can only introduce conflicts in that case. Manual commands
   (`Refresh Current Header`, `Enable for Current File`) override.
4. **Cycle filter.** Each prefix entry is checked (1 level deep) against the
   target header's basename — entries that transitively re-include the target
   are dropped to prevent redefinition cascades.
5. **Dedup.** Prefix entries that appear in the header's own `#include` set
   are dropped, and within-prefix duplicates are collapsed —
   `bugprone-duplicate-include` doesn't fire.
6. **Synthesis.** The remaining entries are wrapped in
   `#if __INCLUDE_LEVEL__ == 0 ... // __NSC_PREAMBLE_END__ ... #endif` and
   prepended to the header's `didOpen.text`.
7. **Position remap.** ~30 LSP methods (hover, definition, references,
   completion, semantic-tokens full+range+delta, inlay hints, formatting,
   prepare-rename / rename, code-action with `context.diagnostics` back-shift,
   document-symbol, folding-range, code-lens, selection-range, linked-editing-
   range, call-hierarchy, type-hierarchy, …) shift positions and ranges in
   both directions so the user sees user-space coordinates.
8. **Diagnostic suppression.** The `handleDiagnostics` middleware drops entries
   whose range is fully in the preamble, clips entries straddling the boundary,
   and shifts surviving entries to user-space. Suppressed entries are kept
   for `Dump Suppressed Preamble Diagnostics`.
9. **Pending-header replay.** If a header is opened before any matching TU
   has been observed, the original `didOpen` is stashed; when a later TU's
   `didOpen` populates the graph with a basename match, the stored open is
   replayed through the wrapped notify so the preamble injection runs against
   the saved text.
10. **Pre-wrap catch-up.** vscode-languageclient may have already sent
    `didOpen` for documents that were open at activation, before our
    `sendNotification` wrapper went in. At install we observe open TU buffers
    into the graph and replay open headers without state.
11. **Source-after-header refresh.** When a TU's `didOpen` arrives via the
    editor for the first time, active header state whose includer pick now
    resolves to that TU is replayed — so a header parsed against a disk-read
    companion gets re-evaluated when the user finally opens the source.
12. **Compile-flags refresh.** `workspace/didChangeConfiguration` carries
    clangd's `compilationDatabaseChanges` extension (used by
    [vscode-clangd-cmake](https://github.com/sr-tream/vscode-clangd-cmake)
    to deliver per-file flags). clangd updates its in-memory CDB on receipt
    but does not reparse already-open files — so we replay `didOpen` for
    any active header whose includer TU is in the change set.

## Caveats

- Header opened alone with no companion `.cpp` and no observed TU yields a
  pass-through (no preamble) until either an includer TU's `didOpen` is
  observed or `Scan Project for Includer TUs` is run.
- Pull-diagnostics (`textDocument/diagnostic`) is not yet handled; rely on
  push (`publishDiagnostics`) for now.
- The same header reached through two distinct buffers via different paths is
  treated as two separate buffers (each gets its own state).

## Build from source

```bash
npm install
npm run build              # esbuild bundle to out/extension.js
npm run typecheck          # tsc --noEmit
npx @vscode/vsce package   # produces vscode-clangd-preamble.vsix
```

## License

MIT — see [LICENSE](LICENSE).
