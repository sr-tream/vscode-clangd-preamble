import * as vscode from 'vscode';
import * as fs from 'fs';
import { Graph, isHeaderPath, isTuPath } from './graph';
import { buildState, DocState, StateStore } from './preamble';
import {
    LspRange,
    shiftPos, shiftRange,
    shiftCompletionItem, shiftLocations, shiftDocSymbols, shiftFoldingRanges,
    processTextEdits, walkWorkspaceEdit, processDiagnostics,
    shiftSemtokFull, applySemtokEdits,
} from './positions';

const SENTINEL = '__clangdPreambleInstalled__';
const SUPPRESS = Symbol.for('clangdPreamble.suppress');

// Companion TUs opened virtually (bypassing wrapper) so clangd builds their
// PCH before the user opens them in the editor.
const virtualTus = new Map<string, { uri: string; pchReady: boolean }>();

// Header URIs whose didClose is part of a scheduleReissue cycle (didClose +
// didOpen). Used to skip companion cleanup during the cycle so we don't
// close-and-reopen the companion mid-reissue and trigger an infinite loop.
const reissueInProgress = new Set<string>();

export interface InstallContext {
    graph: Graph;
    store: StateStore;
    isEnabled: () => boolean;
    log: (msg: string) => void;
    marker: () => string;
    onStateChange?: (uri: string) => void;
    // Set by installHooks; lets external code (commands, scans) trigger a
    // pending-header replay that goes back through the wrapped notify.
    scheduleReissue?: (h: PendingHeader) => void;
}

interface MutableLanguageClient {
    clientOptions: { middleware?: any };
    sendNotification(method: any, params?: any): any;
    sendRequest(method: any, ...args: any[]): Thenable<any>;
}

function methodOf(x: any): string | undefined {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object' && typeof x.method === 'string') return x.method;
    return undefined;
}

// Headers opened before any includer TU is known. Keyed by URI; value is the
// original didOpen.textDocument so we can replay it once the graph gains a
// matching TU.
export interface PendingHeader { uri: string; languageId: string; version: number; text: string; }
const pendingHeaders = new Map<string, PendingHeader>();
export function _pendingCount(): number { return pendingHeaders.size; }
export function _pendingUris(): string[] { return Array.from(pendingHeaders.keys()); }

// One-shot bypass: URIs the user manually requested via Refresh/EnableBuf
// should be processed with findIncluder({force:true}) on the next didOpen,
// overriding the self-contained heuristic. Consumed once.
const forcedUris = new Set<string>();
export function markForced(uri: string): void { forcedUris.add(uri); }
export function clearForced(uri: string): void { forcedUris.delete(uri); }

// TU paths whose `didOpen` we have observed via the editor (wrapped notify or
// the install-time syncOpenDocs sweep). Distinct from `graph.tuIncludes`,
// which also contains disk-only entries created by the companion-TU fallback
// in `findIncluder`. We refresh active header state the first time a TU
// appears in this set, so a header whose preamble was synthesized from a
// disk-read companion gets re-evaluated when the user finally opens the
// source. Cleared on `didClose` for the TU.
const tusObservedFromEditor = new Set<string>();

function uriToFsPath(uri: string): string {
    try { return vscode.Uri.parse(uri).fsPath; } catch { return uri; }
}

function deepCopy<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

function openTuVirtually(origNotify: (...args: any[]) => any, tuPath: string): void {
    if (virtualTus.has(tuPath)) return;
    let text: string;
    try { text = fs.readFileSync(tuPath, 'utf8'); } catch { return; }
    const uri = vscode.Uri.file(tuPath).toString();
    const ext = tuPath.split('.').pop() ?? 'cpp';
    const lang = ext === 'c' || ext === 'C' ? 'c' : 'cpp';
    origNotify('textDocument/didOpen', {
        textDocument: { uri, languageId: lang, version: 0, text },
    });
    virtualTus.set(tuPath, { uri, pchReady: false });
}

function closeTuVirtually(origNotify: (...args: any[]) => any, tuPath: string): void {
    const vt = virtualTus.get(tuPath);
    if (!vt) return;
    origNotify('textDocument/didClose', { textDocument: { uri: vt.uri } });
    virtualTus.delete(tuPath);
}

// Returns true if tuPath was virtually open (caller should suppress the
// duplicate didOpen that the editor would otherwise send to clangd).
function promoteVirtualTu(tuPath: string): boolean {
    if (!virtualTus.has(tuPath)) return false;
    virtualTus.delete(tuPath);
    return true;
}

// Track a TU as virtually open without sending didOpen — clangd already has
// the file open from the user's prior didOpen. Caller must suppress the
// matching didClose so clangd keeps its PCH alive for active headers.
function demoteToVirtual(tuPath: string, uri: string): void {
    if (virtualTus.has(tuPath)) return;
    virtualTus.set(tuPath, { uri, pchReady: true });
}

// ===== Outgoing param shifts =====
type OutFn = (params: any, st: DocState) => void;
const OUT_POS: OutFn = (p, st) => shiftPos(p.position, st.preambleLines);
const OUT_RANGE: OutFn = (p, st) => shiftRange(p.range, st.preambleLines);

const OUT: Record<string, OutFn> = {
    'textDocument/hover': OUT_POS,
    'textDocument/definition': OUT_POS,
    'textDocument/declaration': OUT_POS,
    'textDocument/typeDefinition': OUT_POS,
    'textDocument/implementation': OUT_POS,
    'textDocument/references': OUT_POS,
    'textDocument/documentHighlight': OUT_POS,
    'textDocument/signatureHelp': OUT_POS,
    'textDocument/prepareRename': OUT_POS,
    'textDocument/rename': OUT_POS,
    'textDocument/prepareCallHierarchy': OUT_POS,
    'textDocument/prepareTypeHierarchy': OUT_POS,
    'textDocument/linkedEditingRange': OUT_POS,
    'textDocument/onTypeFormatting': OUT_POS,
    'textDocument/completion': OUT_POS,
    'textDocument/semanticTokens/range': OUT_RANGE,
    'textDocument/rangeFormatting': OUT_RANGE,
    'textDocument/inlayHint': OUT_RANGE,
    'codeLens/resolve': OUT_RANGE,
    'textDocument/codeAction': (p, st) => {
        shiftRange(p.range, st.preambleLines);
        if (p.context && Array.isArray(p.context.diagnostics)) {
            for (const d of p.context.diagnostics) shiftRange(d.range, st.preambleLines);
        }
    },
    'textDocument/selectionRange': (p, st) => {
        if (Array.isArray(p.positions)) {
            for (const pp of p.positions) shiftPos(pp, st.preambleLines);
        }
    },
    'textDocument/semanticTokens/full/delta': (p, st) => {
        if (st.semtokResultIdUser && p.previousResultId === st.semtokResultIdUser) {
            p.previousResultId = st.semtokResultIdServer;
        }
    },
};

// ===== Incoming response shifts =====
type InFn = (result: any, st: DocState) => any;

function shiftSelectionTree(sr: any, n: number): any {
    if (!sr) return undefined;
    if (sr.range.end.line < n) return undefined;
    if (sr.range.start.line < n) {
        sr.range.start.line = n;
        sr.range.start.character = 0;
    }
    shiftRange(sr.range, -n);
    if (sr.parent) sr.parent = shiftSelectionTree(sr.parent, n);
    return sr;
}

function shiftHierarchyItems(items: any[], st: DocState): any[] {
    if (!Array.isArray(items)) return items;
    for (const it of items) {
        if (it.uri === st.headerUri) {
            shiftRange(it.range, -st.preambleLines);
            shiftRange(it.selectionRange, -st.preambleLines);
        }
    }
    return items;
}

const IN: Record<string, InFn> = {
    'textDocument/hover': (r, st) => {
        if (r && r.range) shiftRange(r.range, -st.preambleLines);
        return r;
    },
    'textDocument/definition': (r, st) => shiftLocations(r, -st.preambleLines, st.headerUri),
    'textDocument/declaration': (r, st) => shiftLocations(r, -st.preambleLines, st.headerUri),
    'textDocument/typeDefinition': (r, st) => shiftLocations(r, -st.preambleLines, st.headerUri),
    'textDocument/implementation': (r, st) => shiftLocations(r, -st.preambleLines, st.headerUri),
    'textDocument/references': (r, st) => shiftLocations(r, -st.preambleLines, st.headerUri),
    'textDocument/documentHighlight': (r, st) => {
        if (Array.isArray(r)) for (const h of r) shiftRange(h.range, -st.preambleLines);
        return r;
    },
    'textDocument/inlayHint': (r, st) => {
        if (!Array.isArray(r)) return r;
        const out: any[] = [];
        for (const h of r) {
            if (h.position && h.position.line >= st.preambleLines) {
                shiftPos(h.position, -st.preambleLines);
                if (Array.isArray(h.textEdits)) for (const te of h.textEdits) shiftRange(te.range, -st.preambleLines);
                if (Array.isArray(h.label)) {
                    for (const lp of h.label) {
                        if (lp.location && lp.location.uri === st.headerUri) {
                            shiftRange(lp.location.range, -st.preambleLines);
                        }
                    }
                }
                out.push(h);
            }
        }
        return out;
    },
    'textDocument/completion': (r, st) => {
        if (!r) return r;
        const items = Array.isArray(r) ? r : (r.items as any[] | undefined);
        if (Array.isArray(items)) for (const it of items) shiftCompletionItem(it, -st.preambleLines);
        return r;
    },
    'textDocument/codeAction': (r, st) => {
        if (!Array.isArray(r)) return r;
        for (const a of r) {
            if (a.edit) walkWorkspaceEdit(a.edit, st.headerUri, st.preambleLines, -1);
            if (Array.isArray(a.diagnostics)) {
                for (const d of a.diagnostics) shiftRange(d.range, -st.preambleLines);
            }
        }
        return r;
    },
    'textDocument/documentSymbol': (r, st) => shiftDocSymbols(r, st.preambleLines, st.headerUri),
    'textDocument/foldingRange': (r, st) => Array.isArray(r) ? shiftFoldingRanges(r, st.preambleLines) : r,
    'textDocument/documentLink': (r, st) => {
        if (!Array.isArray(r)) return r;
        const out: any[] = [];
        for (const dl of r) {
            if (dl.range.end.line >= st.preambleLines) {
                if (dl.range.start.line < st.preambleLines) {
                    dl.range.start.line = st.preambleLines;
                    dl.range.start.character = 0;
                }
                shiftRange(dl.range, -st.preambleLines);
                out.push(dl);
            }
        }
        return out;
    },
    'textDocument/formatting': (r, st) => processTextEdits(r, st.preambleLines),
    'textDocument/rangeFormatting': (r, st) => processTextEdits(r, st.preambleLines),
    'textDocument/onTypeFormatting': (r, st) => processTextEdits(r, st.preambleLines),
    'textDocument/willSaveWaitUntil': (r, st) => processTextEdits(r, st.preambleLines),
    'textDocument/prepareRename': (r, st) => {
        if (!r) return r;
        if (r.range) shiftRange(r.range, -st.preambleLines);
        else if (r.start && r.end) shiftRange(r as LspRange, -st.preambleLines);
        return r;
    },
    'textDocument/rename': (r, st) => {
        if (r) walkWorkspaceEdit(r, st.headerUri, st.preambleLines, -1);
        return r;
    },
    'textDocument/codeLens': (r, st) => {
        if (!Array.isArray(r)) return r;
        const out: any[] = [];
        for (const cl of r) {
            if (cl.range.end.line >= st.preambleLines) {
                if (cl.range.start.line < st.preambleLines) {
                    cl.range.start.line = st.preambleLines;
                    cl.range.start.character = 0;
                }
                shiftRange(cl.range, -st.preambleLines);
                out.push(cl);
            }
        }
        return out;
    },
    'codeLens/resolve': (r, st) => {
        if (r && r.range) shiftRange(r.range, -st.preambleLines);
        return r;
    },
    'textDocument/selectionRange': (r, st) => {
        if (!Array.isArray(r)) return r;
        const out: any[] = [];
        for (const sr of r) {
            const kept = shiftSelectionTree(sr, st.preambleLines);
            if (kept) out.push(kept);
        }
        return out;
    },
    'textDocument/linkedEditingRange': (r, st) => {
        if (!r || !Array.isArray(r.ranges)) return r;
        const out: any[] = [];
        for (const rng of r.ranges) {
            if (rng.end.line >= st.preambleLines) {
                if (rng.start.line < st.preambleLines) {
                    rng.start.line = st.preambleLines;
                    rng.start.character = 0;
                }
                shiftRange(rng, -st.preambleLines);
                out.push(rng);
            }
        }
        r.ranges = out;
        return r;
    },
    'textDocument/prepareCallHierarchy': (r, st) => shiftHierarchyItems(r, st),
    'textDocument/prepareTypeHierarchy': (r, st) => shiftHierarchyItems(r, st),
    'typeHierarchy/supertypes': (r, st) => shiftHierarchyItems(r, st),
    'typeHierarchy/subtypes': (r, st) => shiftHierarchyItems(r, st),
    'callHierarchy/incomingCalls': (r, st) => {
        if (!Array.isArray(r)) return r;
        for (const c of r) {
            if (c.from && c.from.uri === st.headerUri) {
                shiftRange(c.from.range, -st.preambleLines);
                shiftRange(c.from.selectionRange, -st.preambleLines);
                if (Array.isArray(c.fromRanges)) for (const rng of c.fromRanges) shiftRange(rng, -st.preambleLines);
            }
        }
        return r;
    },
    'callHierarchy/outgoingCalls': (r, st) => {
        if (!Array.isArray(r)) return r;
        for (const c of r) {
            if (c.to && c.to.uri === st.headerUri) {
                shiftRange(c.to.range, -st.preambleLines);
                shiftRange(c.to.selectionRange, -st.preambleLines);
            }
            if (Array.isArray(c.fromRanges)) for (const rng of c.fromRanges) shiftRange(rng, -st.preambleLines);
        }
        return r;
    },
    'textDocument/signatureHelp': (r, _st) => r,
    'textDocument/semanticTokens/full': (r, st) => {
        if (!r || !Array.isArray(r.data)) return r;
        const userData = shiftSemtokFull(r.data, st.preambleLines);
        st.semtokDataServer = r.data;
        st.semtokDataUser = userData;
        st.semtokResultIdServer = r.resultId;
        st.semtokResultIdUser = `nsc-${r.resultId ?? '0'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { resultId: st.semtokResultIdUser, data: userData };
    },
    'textDocument/semanticTokens/range': (r, st) => {
        if (!r || !Array.isArray(r.data)) return r;
        return { resultId: r.resultId, data: shiftSemtokFull(r.data, st.preambleLines) };
    },
    'textDocument/semanticTokens/full/delta': (r, st) => {
        if (!r) return r;
        if (Array.isArray(r.data)) {
            return IN['textDocument/semanticTokens/full'](r, st);
        }
        if (Array.isArray(r.edits) && st.semtokDataServer) {
            st.semtokDataServer = applySemtokEdits(st.semtokDataServer, r.edits);
            st.semtokDataUser = shiftSemtokFull(st.semtokDataServer, st.preambleLines);
            st.semtokResultIdServer = r.resultId;
            st.semtokResultIdUser = `nsc-${r.resultId ?? '0'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            return { resultId: st.semtokResultIdUser, data: st.semtokDataUser };
        }
        return r;
    },
};

// ===== Notification handler — didOpen/didChange/didClose =====

function handleOutgoingNotification(
    method: string,
    params: any,
    ctx: InstallContext,
    scheduleReissue: (h: PendingHeader) => void,
    origNotify: (...args: any[]) => any,
): any {
    if (!params) return params;
    if (method === 'textDocument/didOpen') {
        const td = params.textDocument;
        if (!td) return params;
        const path = uriToFsPath(td.uri);
        if (isHeaderPath(path)) {
            const force = forcedUris.delete(td.uri);
            const includer = ctx.graph.findIncluder(path, { force });
            if (includer) {
                const st = buildState(path, td.uri, td.text, includer, ctx.marker());
                ctx.store.set(td.uri, st);
                pendingHeaders.delete(td.uri);
                ctx.onStateChange?.(td.uri);
                ctx.log(`didOpen header ${path}: preamble ${st.preambleLines} lines from ${includer.tuPath} (direct=${includer.direct})`);
                // Open companion virtually if not already live so clangd builds its PCH
                if (!tusObservedFromEditor.has(includer.tuPath) && !virtualTus.has(includer.tuPath)) {
                    const isOpenInEditor = vscode.workspace.textDocuments.some(d => d.uri.fsPath === includer.tuPath);
                    if (!isOpenInEditor) {
                        openTuVirtually(origNotify, includer.tuPath);
                        ctx.log(`didOpen header ${path}: opening companion ${includer.tuPath} virtually for PCH`);
                    }
                }
                const copy = deepCopy(params);
                copy.textDocument.text = st.preambleText + (copy.textDocument.text ?? '');
                return copy;
            } else {
                pendingHeaders.set(td.uri, {
                    uri: td.uri,
                    languageId: td.languageId,
                    version: td.version ?? 0,
                    text: td.text ?? '',
                });
                ctx.onStateChange?.(td.uri);
                ctx.log(`didOpen header ${path}: no includer found, marked pending (queue=${pendingHeaders.size})`);
            }
        } else if (isTuPath(path) && typeof td.text === 'string') {
            const alreadyOpen = promoteVirtualTu(path);
            const firstEditorObservation = !tusObservedFromEditor.has(path);
            tusObservedFromEditor.add(path);
            ctx.graph.observeTu(path, td.text);
            ctx.log(`didOpen TU ${path}: observed ${td.text.length} bytes (pending headers: ${pendingHeaders.size}, first-editor=${firstEditorObservation}, promoted=${alreadyOpen})`);
            // Promotion does disk I/O for every pending header (findIncluder +
            // cycle filter + file reads). Defer it off the wrapped-notify path
            // so didOpen stays responsive on large projects.
            if (pendingHeaders.size > 0 || firstEditorObservation) {
                setImmediate(() => {
                    tryResolvePending(ctx, scheduleReissue);
                    if (firstEditorObservation) refreshActiveHeadersForTu(ctx, scheduleReissue, path);
                });
            }
            // clangd already has this file open via virtual open; suppress the duplicate didOpen
            if (alreadyOpen) return SUPPRESS;
        }
        return params;
    }
    if (method === 'textDocument/didChange') {
        const uri = params.textDocument?.uri;
        if (!uri) return params;
        const st = ctx.store.get(uri);
        let result = params;
        if (st && st.active) {
            result = deepCopy(params);
            for (const c of result.contentChanges) {
                if (c.range) shiftRange(c.range, st.preambleLines);
                else if (typeof c.text === 'string') c.text = st.preambleText + c.text;
            }
        }
        const path = uriToFsPath(uri);
        if (isTuPath(path)) {
            ctx.graph.invalidate(path);
            // Re-observe with the dirty buffer text would need the full text here;
            // didChange only carries deltas. Defer fresh observation to disk read on
            // demand via tryResolvePending (which calls findIncluder, which falls back
            // to observeTuFromDisk via the companion path when a basename match is
            // missing). Worst case: next didOpen of this TU re-observes.
        }
        // Also pending headers might track this changed buffer.
        return result;
    }
    if (method === 'textDocument/didClose') {
        const uri = params.textDocument?.uri;
        if (uri) {
            const fsPath = uriToFsPath(uri);
            const st = ctx.store.get(uri);
            const had = ctx.store.delete(uri) || pendingHeaders.delete(uri);
            if (had) ctx.onStateChange?.(uri);
            if (isTuPath(fsPath)) {
                tusObservedFromEditor.delete(fsPath);
                // If any active header still uses this TU as its includer,
                // keep it open in clangd virtually — header diagnostics depend
                // on the companion's PCH, which clangd would drop on didClose.
                const stillUsedByHeader = Array.from(ctx.store.values()).some(s => s.includerTu === fsPath);
                if (stillUsedByHeader) {
                    demoteToVirtual(fsPath, uri);
                    ctx.log(`didClose TU ${fsPath}: demoted to virtual (still used by active header)`);
                    return SUPPRESS;
                }
            } else if (st && isHeaderPath(fsPath) && !reissueInProgress.has(uri)) {
                // Header genuinely closing (not a scheduleReissue cycle):
                // close the virtual companion if no other header uses it.
                const compPath = st.includerTu;
                if (compPath && virtualTus.has(compPath)) {
                    const stillUsedComp = Array.from(ctx.store.values()).some(s => s.includerTu === compPath);
                    if (!stillUsedComp) closeTuVirtually(origNotify, compPath);
                }
            }
        }
        return params;
    }
    // The clangd extension to `workspace/didChangeConfiguration` (Protocol.h:575
    // in llvm-project) carries `compilationDatabaseChanges` keyed by source
    // path. vscode-clangd-cmake delivers per-file flags this way. clangd
    // updates its in-memory CDB but does NOT re-parse already-open files, so a
    // header that we opened (and clangd parsed against fallback flags) before
    // the config arrived stays bound to those wrong flags. After the
    // notification reaches clangd, replay didOpen for any active header whose
    // includer TU appears in the change set so it re-fetches flags.
    if (method === 'workspace/didChangeConfiguration') {
        const changes = params?.settings?.compilationDatabaseChanges;
        if (changes && typeof changes === 'object') {
            const changedTus = new Set<string>(Object.keys(changes));
            if (changedTus.size > 0) {
                ctx.log(`workspace/didChangeConfiguration: ${changedTus.size} TU flag entries`);
                setImmediate(() => refreshHeadersForFlagChange(ctx, scheduleReissue, changedTus));
            }
        }
        return params;
    }
    return params;
}

// Walk pending headers; for each whose graph now resolves an includer, schedule
// a didClose+didOpen replay through the wrapped notify so preamble injection
// runs against the saved original text.
//
// Also sweep VS Code's open documents for headers that have NO state and aren't
// in pendingHeaders — typically headers whose original didOpen fired before our
// sendNotification wrapper was installed (clangd client started, sent didOpens
// for already-open docs, then this extension activated). Mirrors the nvim
// `try_promote_pending` walk over all loaded buffers.
function tryResolvePending(
    ctx: InstallContext,
    scheduleReissue: (h: PendingHeader) => void,
): void {
    if (pendingHeaders.size > 0) {
        const ready: PendingHeader[] = [];
        for (const [uri, h] of pendingHeaders) {
            const path = uriToFsPath(uri);
            if (ctx.graph.findIncluder(path)) ready.push(h);
        }
        for (const h of ready) {
            pendingHeaders.delete(h.uri);
            ctx.onStateChange?.(h.uri);
            ctx.log(`pending header ${uriToFsPath(h.uri)}: includer now available, replaying didOpen`);
            scheduleReissue(h);
        }
    }
    for (const doc of vscode.workspace.textDocuments) {
        const uri = doc.uri.toString();
        if (ctx.store.get(uri)) continue;
        if (pendingHeaders.has(uri)) continue;
        const fsPath = doc.uri.fsPath;
        if (!isHeaderPath(fsPath)) continue;
        if (!ctx.graph.findIncluder(fsPath)) continue;
        ctx.log(`untracked header ${fsPath}: includer now available, replaying didOpen`);
        scheduleReissue({
            uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.getText(),
        });
    }
}

// One-shot at install: VS Code's language client may have already sent didOpens
// for documents open at activation, before our sendNotification wrapper was in
// place. Observe those TUs into the graph from buffer text, then run the same
// pending sweep so any pre-wrap headers get a wrapped-replay didOpen with the
// preamble injected. Mirrors the per-buffer reissue inside nvim's `attach()`.
function syncOpenDocs(
    ctx: InstallContext,
    scheduleReissue: (h: PendingHeader) => void,
): void {
    for (const doc of vscode.workspace.textDocuments) {
        const fsPath = doc.uri.fsPath;
        if (isTuPath(fsPath)) {
            tusObservedFromEditor.add(fsPath);
            ctx.graph.observeTu(fsPath, doc.getText());
        }
    }
    tryResolvePending(ctx, scheduleReissue);
}

// When a TU's `didOpen` arrives via the editor for the first time, walk active
// header state and replay `didOpen` for any header whose includer pick now
// resolves to that TU. Catches the case where a header opened first, the
// companion-TU disk fallback synthesized a thin preamble, and the user later
// opens the actual source — without this, the header stays bound to the
// disk-read snapshot and never re-evaluates.
function refreshActiveHeadersForTu(
    ctx: InstallContext,
    scheduleReissue: (h: PendingHeader) => void,
    observedTu: string,
): void {
    for (const doc of vscode.workspace.textDocuments) {
        const uri = doc.uri.toString();
        const st = ctx.store.get(uri);
        if (!st || !st.active) continue;
        const fsPath = doc.uri.fsPath;
        if (!isHeaderPath(fsPath)) continue;
        const includer = ctx.graph.findIncluder(fsPath);
        if (!includer || includer.tuPath !== observedTu) continue;
        ctx.log(`active header ${fsPath}: includer ${observedTu} now in editor, replaying didOpen`);
        scheduleReissue({
            uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.getText(),
        });
    }
}

// Replay `didOpen` for active headers whose includer TU is in `changedTus`
// (the keys of the `compilationDatabaseChanges` clangd extension). Triggered
// from a `workspace/didChangeConfiguration` interceptor so headers parsed
// against stale or fallback flags get a fresh parse with the new CDB entries.
function refreshHeadersForFlagChange(
    ctx: InstallContext,
    scheduleReissue: (h: PendingHeader) => void,
    changedTus: Set<string>,
): void {
    for (const doc of vscode.workspace.textDocuments) {
        const uri = doc.uri.toString();
        const st = ctx.store.get(uri);
        if (!st || !st.active) continue;
        if (!changedTus.has(st.includerTu)) continue;
        const fsPath = doc.uri.fsPath;
        if (!isHeaderPath(fsPath)) continue;
        ctx.log(`active header ${fsPath}: includer TU ${st.includerTu} flags changed, replaying didOpen`);
        scheduleReissue({
            uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.getText(),
        });
    }
}

// Trigger a pending-header sweep externally (e.g. after a project scan).
// Returns the number of pending headers that resolved.
export function resolvePendingNow(ctx: InstallContext): number {
    if (!ctx.scheduleReissue) return 0;
    const before = pendingHeaders.size;
    tryResolvePending(ctx, ctx.scheduleReissue);
    return before - pendingHeaders.size;
}

// ===== Install hooks on a running language client =====

export function installHooks(client: MutableLanguageClient, ctx: InstallContext): boolean {
    const opts: any = client.clientOptions ?? ((client as any).clientOptions = {});
    const middleware: any = opts.middleware ?? (opts.middleware = {});
    if (middleware[SENTINEL]) return false;

    // 1) Mutate the existing middleware object in place so it stays live for the
    //    already-running client. Don't overwrite — chain to whatever filter-files
    //    or other extensions installed.
    const prevDiag = middleware.handleDiagnostics;
    middleware.handleDiagnostics = (uri: vscode.Uri, diagnostics: vscode.Diagnostic[], next: any) => {
        if (!ctx.isEnabled()) return (prevDiag ?? next)(uri, diagnostics, next);

        // Virtual TU PCH-ready: first publishDiagnostics for the companion means
        // its PCH is built; re-analyze any header that opened before it was ready.
        const diagFsPath = uri.fsPath;
        const diagVt = virtualTus.get(diagFsPath);
        if (diagVt && !diagVt.pchReady) {
            diagVt.pchReady = true;
            const sr = ctx.scheduleReissue;
            if (sr) setImmediate(() => refreshActiveHeadersForTu(ctx, sr, diagFsPath));
        }

        const uriStr = uri.toString();
        const st = ctx.store.get(uriStr);
        if (!st || !st.active) {
            // If a pending header is now publishing diagnostics (typically the
            // unresolved-symbol cascade), check if the graph has since gained an
            // includer and replay didOpen if so.
            if (pendingHeaders.has(uriStr) && diagnostics.length > 0) {
                resolvePendingNow(ctx);
            }
            return (prevDiag ?? next)(uri, diagnostics, next);
        }

        const kept: vscode.Diagnostic[] = [];
        const dropped: vscode.Diagnostic[] = [];
        for (const d of diagnostics) {
            if (d.range.end.line < st.preambleLines) { dropped.push(d); continue; }
            const startLine = Math.max(d.range.start.line, st.preambleLines);
            const startChar = d.range.start.line < st.preambleLines ? 0 : d.range.start.character;
            const newRange = new vscode.Range(
                startLine - st.preambleLines, startChar,
                d.range.end.line - st.preambleLines, d.range.end.character,
            );
            const nd = new vscode.Diagnostic(newRange, d.message, d.severity);
            nd.code = d.code;
            nd.source = d.source;
            nd.tags = d.tags ? [...d.tags] : undefined;
            if (d.relatedInformation) {
                const rel: vscode.DiagnosticRelatedInformation[] = [];
                for (const ri of d.relatedInformation) {
                    if (ri.location.uri.toString() === st.headerUri) {
                        if (ri.location.range.end.line < st.preambleLines) continue;
                        const rsLine = Math.max(ri.location.range.start.line, st.preambleLines);
                        const rsChar = ri.location.range.start.line < st.preambleLines ? 0 : ri.location.range.start.character;
                        rel.push(new vscode.DiagnosticRelatedInformation(
                            new vscode.Location(
                                ri.location.uri,
                                new vscode.Range(
                                    rsLine - st.preambleLines, rsChar,
                                    ri.location.range.end.line - st.preambleLines, ri.location.range.end.character,
                                ),
                            ),
                            ri.message,
                        ));
                    } else {
                        rel.push(ri);
                    }
                }
                nd.relatedInformation = rel;
            }
            kept.push(nd);
        }
        st.droppedDiags = dropped;
        ctx.log(`publishDiagnostics ${uri.toString()}: ${diagnostics.length} → ${kept.length} (dropped ${dropped.length})`);
        return (prevDiag ?? next)(uri, kept, next);
    };
    middleware[SENTINEL] = true;

    // 2) Wrap sendNotification on the running client instance. We rebind to the
    //    client (notification methods may use `this`). The scheduleReissue
    //    callback is stable: it captures `client` so pending-header replays go
    //    through the WRAPPED notify (which finds the now-available includer).
    const origNotify = client.sendNotification.bind(client) as (...args: any[]) => any;
    const scheduleReissue = (h: PendingHeader) => {
        queueMicrotask(() => {
            reissueInProgress.add(h.uri);
            try {
                client.sendNotification('textDocument/didClose', { textDocument: { uri: h.uri } });
                client.sendNotification('textDocument/didOpen', {
                    textDocument: {
                        uri: h.uri,
                        languageId: h.languageId,
                        version: h.version,
                        text: h.text,
                    },
                });
            } catch (e) {
                ctx.log(`reissue ${h.uri} failed: ${(e as Error).message}`);
            } finally {
                reissueInProgress.delete(h.uri);
            }
        });
    };
    ctx.scheduleReissue = scheduleReissue;
    client.sendNotification = function (this: any, ...args: any[]) {
        if (!ctx.isEnabled()) return origNotify(...args);
        const method = methodOf(args[0]);
        if (!method) return origNotify(...args);
        const newParams = handleOutgoingNotification(method, args[1], ctx, scheduleReissue, origNotify);
        if (newParams === SUPPRESS) return;
        const newArgs = args.slice();
        newArgs[1] = newParams;
        return origNotify(...newArgs);
    } as any;

    // 3) Wrap sendRequest similarly.
    const origRequest = client.sendRequest.bind(client) as (...args: any[]) => Thenable<any>;
    client.sendRequest = function (this: any, ...args: any[]): Thenable<any> {
        if (!ctx.isEnabled()) return origRequest(...args);
        const method = methodOf(args[0]);
        if (!method) return origRequest(...args);
        const params = args[1];
        const uri: string | undefined = params?.textDocument?.uri;
        const st = uri ? ctx.store.get(uri) : undefined;
        if (!st || !st.active) return origRequest(...args);

        const outFn = OUT[method];
        const newArgs = args.slice();
        if (outFn) {
            newArgs[1] = deepCopy(params);
            outFn(newArgs[1], st);
        }

        const promise = origRequest(...newArgs);
        const inFn = IN[method];
        if (!inFn) return promise;
        return Promise.resolve(promise).then((result: any) => {
            if (result == null) return result;
            try { return inFn(result, st); } catch (e) {
                ctx.log(`IN[${method}] threw: ${(e as Error).message}`);
                return result;
            }
        });
    } as any;

    // Catch up with documents already opened pre-wrap.
    queueMicrotask(() => syncOpenDocs(ctx, scheduleReissue));

    return true;
}
