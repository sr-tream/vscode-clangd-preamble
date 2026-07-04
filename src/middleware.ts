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
const APPLY_EDIT_SENTINEL = '__clangdPreambleApplyEditInstalled__';
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
    defaultSelector?: () => 'preambleSize' | 'lastSeen';
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
    handleApplyWorkspaceEdit?(params: any): Thenable<any>;
}

function methodOf(x: any): string | undefined {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object' && typeof x.method === 'string') return x.method;
    return undefined;
}

// Headers opened before any includer TU is known. Keyed by URI; value is the
// original didOpen.textDocument so we can replay it once the graph gains a
// matching TU.
export interface PendingHeader { uri: string; languageId: string; version: number; text: string; waitForTuReady?: string; }
const pendingHeaders = new Map<string, PendingHeader>();
export function _pendingCount(): number { return pendingHeaders.size; }
export function _pendingUris(): string[] { return Array.from(pendingHeaders.keys()); }

// One-shot bypass: URIs the user manually requested via Refresh/EnableBuf
// should be processed with findIncluder({force:true}) on the next didOpen,
// overriding the self-contained heuristic. Consumed once.
const forcedUris = new Set<string>();
export function markForced(uri: string): void { forcedUris.add(uri); }
export function clearForced(uri: string): void { forcedUris.delete(uri); }

// Headers that looked self-contained by the cheap include-count heuristic, but
// later produced clangd diagnostics when opened without a preamble. These become
// eligible for a forced includer search while clean self-contained headers stay
// pass-through and hidden from the status bar.
const diagnosticSelfContainedUris = new Set<string>();

// Sticky per-buffer includer override chosen from the status-bar selector.
// It survives reissue cycles until the user switches back to auto or disables
// the header.
const preferredIncluders = new Map<string, string>();
const recentIncluderUris = new Set<string>();
export function setPreferredIncluder(uri: string, tuPath: string): void {
    preferredIncluders.set(uri, tuPath);
    recentIncluderUris.delete(uri);
    disabledUris.delete(uri);
}
export function setRecentIncluderMode(uri: string): void {
    recentIncluderUris.add(uri);
    preferredIncluders.delete(uri);
    disabledUris.delete(uri);
}
export function clearPreferredIncluder(uri: string): void {
    preferredIncluders.delete(uri);
    recentIncluderUris.delete(uri);
}
export function getPreferredIncluder(uri: string): string | undefined { return preferredIncluders.get(uri); }
export function isRecentIncluderMode(uri: string): boolean { return recentIncluderUris.has(uri); }

// Per-buffer opt-out. A disabled header must survive didClose+didOpen replays
// used by commands, otherwise Disable immediately reopens and injects again.
const disabledUris = new Set<string>();
export function markDisabled(uri: string): void {
    disabledUris.add(uri);
    forcedUris.delete(uri);
    diagnosticSelfContainedUris.delete(uri);
    preferredIncluders.delete(uri);
    recentIncluderUris.delete(uri);
    pendingHeaders.delete(uri);
}
export function clearDisabled(uri: string): void { disabledUris.delete(uri); }
export function isDisabled(uri: string): boolean { return disabledUris.has(uri); }

// TU paths whose `didOpen` we have observed via the editor (wrapped notify or
// the install-time syncOpenDocs sweep). Distinct from `graph.tuIncludes`,
// which also contains disk-only entries created by the companion-TU fallback
// in `findIncluder`. We refresh active header state the first time a TU
// appears in this set, so a header whose preamble was synthesized from a
// disk-read companion gets re-evaluated when the user finally opens the
// source. Cleared on `didClose` for the TU.
const tusObservedFromEditor = new Set<string>();

// TUs whose first diagnostics have arrived from clangd. `syncOpenDocs` can see
// an editor-open TU before clangd has finished building its preamble. Delaying
// synthetic headers that depend on that TU avoids poisoning the TU parse with
// the modified open header contents during startup.
const tusReady = new Set<string>();

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

function isTuReadyForPreamble(tuPath: string): boolean {
    if (tusObservedFromEditor.has(tuPath)) return tusReady.has(tuPath);
    const vt = virtualTus.get(tuPath);
    return !vt || vt.pchReady;
}

function rememberPendingHeader(
    h: PendingHeader,
    ctx: InstallContext,
    reason: string,
): void {
    pendingHeaders.set(h.uri, h);
    ctx.onStateChange?.(h.uri);
    ctx.log(`${reason} (queue=${pendingHeaders.size})`);
}

function findHeaderIncluder(
    ctx: InstallContext,
    headerPath: string,
    headerUri: string,
    force = false,
): ReturnType<Graph['findIncluder']> {
    const preferredTu = preferredIncluders.get(headerUri);
    if (preferredTu) {
        return ctx.graph.findIncluder(headerPath, { force: true, preferredTu });
    }
    if (recentIncluderUris.has(headerUri)) {
        return ctx.graph.findRecentIncluder(headerPath, { force: true })
            ?? ctx.graph.findIncluder(headerPath, { force: true });
    }
    if (ctx.defaultSelector?.() === 'lastSeen') {
        return ctx.graph.findRecentIncluder(headerPath, { force })
            ?? ctx.graph.findIncluder(headerPath, { force });
    }
    return ctx.graph.findIncluder(headerPath, { force });
}

export function markTuReadyForPreamble(ctx: InstallContext, tuPath: string, reason: string): void {
    if (!isTuPath(tuPath)) return;
    tusObservedFromEditor.add(tuPath);
    if (tusReady.has(tuPath)) return;
    tusReady.add(tuPath);
    ctx.log(`TU ${tuPath}: marked includer ready from ${reason}`);
    const sr = ctx.scheduleReissue;
    if (!sr) return;
    setImmediate(() => {
        tryResolvePending(ctx, sr);
        refreshActiveHeadersForTu(ctx, sr, tuPath);
    });
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

function summarizeWorkspaceEdit(we: any): string {
    const parts: string[] = [];
    const push = (uri: string | undefined, edits: any[] | undefined) => {
        if (!uri || !Array.isArray(edits)) return;
        const ranges = edits
            .filter(e => e?.range)
            .slice(0, 3)
            .map(e => `${e.range.start.line}:${e.range.start.character}-${e.range.end.line}:${e.range.end.character}`)
            .join(',');
        parts.push(`${uri}#${edits.length}${ranges ? `(${ranges})` : ''}`);
    };
    if (we?.changes) {
        for (const uri of Object.keys(we.changes)) push(uri, we.changes[uri]);
    }
    if (Array.isArray(we?.documentChanges)) {
        for (const dc of we.documentChanges) {
            push(dc?.textDocument?.uri, dc?.edits);
        }
    }
    return parts.length > 0 ? parts.join(' | ') : '<no text edits>';
}

function shiftWorkspaceEditForActiveHeaders(we: any, store: StateStore, dir: 1 | -1): number {
    let shifted = 0;
    for (const st of store.values()) {
        if (st.active) shifted += walkWorkspaceEdit(we, st.headerUri, st.preambleLines, dir);
    }
    return shifted;
}

function activeHeaderCount(store: StateStore): number {
    let active = 0;
    for (const st of store.values()) {
        if (st.active) active++;
    }
    return active;
}

function summarizeCodeActionEdits(actions: any): string {
    if (!Array.isArray(actions)) return '<not an array>';
    const parts: string[] = [];
    for (const action of actions) {
        if (!action?.edit) continue;
        parts.push(summarizeWorkspaceEdit(action.edit));
        if (parts.length >= 5) break;
    }
    return parts.length > 0 ? parts.join(' || ') : '<no text edits>';
}

function shiftCodeActionEditsForActiveHeaders(actions: any, store: StateStore): number {
    if (!Array.isArray(actions)) return 0;
    let shifted = 0;
    for (const action of actions) {
        if (action?.edit) shifted += shiftWorkspaceEditForActiveHeaders(action.edit, store, -1);
    }
    return shifted;
}

function shiftCodeActionDiagnostics(actions: any, st: DocState): number {
    if (!Array.isArray(actions)) return 0;
    let shifted = 0;
    for (const action of actions) {
        if (!Array.isArray(action?.diagnostics)) continue;
        for (const d of action.diagnostics) {
            shiftRange(d.range, -st.preambleLines);
            shifted++;
        }
    }
    return shifted;
}

function remapCodeActionResult(result: any, ctx: InstallContext, requestUri: string | undefined, requestState?: DocState): any {
    const active = activeHeaderCount(ctx.store);
    if (active === 0) return result;
    const before = summarizeCodeActionEdits(result);
    const editShifted = shiftCodeActionEditsForActiveHeaders(result, ctx.store);
    const diagShifted = requestState ? shiftCodeActionDiagnostics(result, requestState) : 0;
    const after = summarizeCodeActionEdits(result);
    ctx.log(`textDocument/codeAction: request=${requestUri ?? '<no-uri>'} activeHeaders=${active} shiftedEdits=${editShifted} shiftedDiagnostics=${diagShifted} before=${before} after=${after}`);
    return result;
}

function remapWorkspaceEditResult(method: string, result: any, ctx: InstallContext, requestUri: string | undefined): any {
    const active = activeHeaderCount(ctx.store);
    if (active === 0) return result;
    const before = summarizeWorkspaceEdit(result);
    const shifted = shiftWorkspaceEditForActiveHeaders(result, ctx.store, -1);
    const after = summarizeWorkspaceEdit(result);
    ctx.log(`${method}: request=${requestUri ?? '<no-uri>'} activeHeaders=${active} shifted=${shifted} before=${before} after=${after}`);
    return result;
}

function installApplyWorkspaceEditHook(client: MutableLanguageClient, ctx: InstallContext): boolean {
    const c = client as any;
    if (c[APPLY_EDIT_SENTINEL]) {
        ctx.log('workspace/applyEdit hook already installed');
        return false;
    }
    if (typeof client.handleApplyWorkspaceEdit !== 'function') {
        ctx.log(`workspace/applyEdit hook unavailable (type=${typeof client.handleApplyWorkspaceEdit})`);
        return false;
    }

    const origApplyWorkspaceEdit = client.handleApplyWorkspaceEdit.bind(client);
    client.handleApplyWorkspaceEdit = function (this: any, params: any): Thenable<any> {
        if (!ctx.isEnabled() || !params?.edit) return origApplyWorkspaceEdit(params);
        try {
            const copy = deepCopy(params);
            const activeHeaders = Array.from(ctx.store.values()).filter(st => st.active).length;
            const before = summarizeWorkspaceEdit(copy.edit);
            const shifted = shiftWorkspaceEditForActiveHeaders(copy.edit, ctx.store, -1);
            const after = summarizeWorkspaceEdit(copy.edit);
            ctx.log(`workspace/applyEdit: active=${activeHeaders} shifted=${shifted} before=${before} after=${after}`);
            return origApplyWorkspaceEdit(copy);
        } catch (e) {
            ctx.log(`workspace/applyEdit shift failed: ${(e as Error).message}`);
            return origApplyWorkspaceEdit(params);
        }
    };
    c[APPLY_EDIT_SENTINEL] = true;
    ctx.log('workspace/applyEdit hook installed');
    return true;
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
            if (disabledUris.has(td.uri)) {
                forcedUris.delete(td.uri);
                pendingHeaders.delete(td.uri);
                if (ctx.store.delete(td.uri)) ctx.onStateChange?.(td.uri);
                ctx.log(`didOpen header ${path}: preamble disabled for buffer, passing through`);
                return params;
            }
            const force = forcedUris.delete(td.uri);
            const diagnosticRetry = diagnosticSelfContainedUris.has(td.uri);
            if (!force && !diagnosticRetry && ctx.graph.isSelfContainedHeader(path)) {
                const hadPending = pendingHeaders.delete(td.uri);
                const hadState = ctx.store.delete(td.uri);
                if (hadPending || hadState) ctx.onStateChange?.(td.uri);
                ctx.log(`didOpen header ${path}: self-contained, passing through`);
                return params;
            }
            const includer = findHeaderIncluder(ctx, path, td.uri, force || diagnosticRetry);
            if (includer) {
                // Open companion virtually if not already live so clangd builds its PCH.
                // If the source is already open in the editor, wait until clangd has
                // actually parsed it before sending modified header contents.
                const openInEditorDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === includer.tuPath);
                if (openInEditorDoc && !tusObservedFromEditor.has(includer.tuPath)) {
                    tusObservedFromEditor.add(includer.tuPath);
                    tusReady.delete(includer.tuPath);
                    ctx.graph.observeTu(includer.tuPath, openInEditorDoc.getText());
                    origNotify('textDocument/didChange', {
                        textDocument: { uri: openInEditorDoc.uri.toString(), version: openInEditorDoc.version },
                        contentChanges: [{ text: openInEditorDoc.getText() }],
                    });
                    ctx.log(`didOpen header ${path}: requested readiness parse for already-open includer ${includer.tuPath}`);
                }
                if (!tusObservedFromEditor.has(includer.tuPath) && !virtualTus.has(includer.tuPath)) {
                    if (!openInEditorDoc) {
                        openTuVirtually(origNotify, includer.tuPath);
                        ctx.log(`didOpen header ${path}: opening companion ${includer.tuPath} virtually for PCH`);
                    }
                }
                if (!isTuReadyForPreamble(includer.tuPath)) {
                    rememberPendingHeader({
                        uri: td.uri,
                        languageId: td.languageId,
                        version: td.version ?? 0,
                        text: td.text ?? '',
                        waitForTuReady: includer.tuPath,
                    }, ctx, `didOpen header ${path}: includer ${includer.tuPath} not ready, delaying preamble`);
                    return params;
                }
                const st = buildState(path, td.uri, td.text, includer, ctx.marker());
                ctx.store.set(td.uri, st);
                pendingHeaders.delete(td.uri);
                ctx.onStateChange?.(td.uri);
                ctx.log(`didOpen header ${path}: preamble ${st.preambleLines} lines from ${includer.tuPath} (direct=${includer.direct})`);
                const copy = deepCopy(params);
                copy.textDocument.text = st.preambleText + (copy.textDocument.text ?? '');
                return copy;
            } else {
                rememberPendingHeader({
                    uri: td.uri,
                    languageId: td.languageId,
                    version: td.version ?? 0,
                    text: td.text ?? '',
                }, ctx, `didOpen header ${path}: no includer found, marked pending`);
            }
        } else if (isTuPath(path) && typeof td.text === 'string') {
            const alreadyOpen = promoteVirtualTu(path);
            const firstEditorObservation = !tusObservedFromEditor.has(path);
            tusObservedFromEditor.add(path);
            tusReady.delete(path);
            ctx.graph.observeTu(path, td.text);
            ctx.log(`didOpen TU ${path}: observed ${td.text.length} bytes (pending headers: ${pendingHeaders.size}, first-editor=${firstEditorObservation}, promoted=${alreadyOpen})`);
            // Promotion does disk I/O for every pending header (findIncluder +
            // cycle filter + file reads). Defer it off the wrapped-notify path
            // so didOpen stays responsive on large projects.
            if (pendingHeaders.size > 0 || firstEditorObservation) {
                setImmediate(() => {
                    tryResolvePending(ctx, scheduleReissue);
                });
            }
            // clangd already has this file open via virtual open. Suppress the
            // duplicate didOpen, but first sync the real editor text so clangd
            // stops using the disk snapshot opened for the companion PCH.
            if (alreadyOpen) {
                origNotify('textDocument/didChange', {
                    textDocument: { uri: td.uri, version: td.version ?? 0 },
                    contentChanges: [{ text: td.text }],
                });
                ctx.log(`didOpen TU ${path}: synced promoted virtual TU from editor text`);
                return SUPPRESS;
            }
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
            tusReady.delete(path);
            const fullTextChange = Array.isArray(params.contentChanges)
                && params.contentChanges.length === 1
                && !params.contentChanges[0].range
                && typeof params.contentChanges[0].text === 'string';
            if (fullTextChange) {
                ctx.graph.observeTu(path, params.contentChanges[0].text);
            } else {
                ctx.graph.invalidate(path);
            }
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
                tusReady.delete(fsPath);
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
                setImmediate(() => {
                    refreshVirtualTusForFlagChange(ctx, origNotify, changedTus);
                    refreshHeadersForFlagChange(ctx, scheduleReissue, changedTus);
                });
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
    const scheduledUris = new Set<string>();
    if (pendingHeaders.size > 0) {
        const ready: PendingHeader[] = [];
        for (const [uri, h] of pendingHeaders) {
            const path = uriToFsPath(uri);
            const diagnosticRetry = diagnosticSelfContainedUris.has(uri);
            if (!diagnosticRetry && ctx.graph.isSelfContainedHeader(path)) {
                pendingHeaders.delete(uri);
                ctx.onStateChange?.(uri);
                ctx.log(`pending header ${path}: self-contained, removing from pending`);
                continue;
            }
            const includer = findHeaderIncluder(ctx, path, uri, diagnosticRetry);
            if (includer && isTuReadyForPreamble(includer.tuPath)) {
                ready.push(h);
            } else if (includer && h.waitForTuReady !== includer.tuPath) {
                h.waitForTuReady = includer.tuPath;
                ctx.log(`pending header ${path}: includer ${includer.tuPath} not ready yet`);
            }
        }
        for (const h of ready) {
            pendingHeaders.delete(h.uri);
            ctx.onStateChange?.(h.uri);
            ctx.log(`pending header ${uriToFsPath(h.uri)}: includer now available, replaying didOpen`);
            scheduledUris.add(h.uri);
            scheduleReissue(h);
        }
    }
    for (const doc of vscode.workspace.textDocuments) {
        const uri = doc.uri.toString();
        if (ctx.store.get(uri)) continue;
        if (scheduledUris.has(uri)) continue;
        if (pendingHeaders.has(uri)) continue;
        if (disabledUris.has(uri)) continue;
        const fsPath = doc.uri.fsPath;
        if (!isHeaderPath(fsPath)) continue;
        const diagnosticRetry = diagnosticSelfContainedUris.has(uri);
        if (!diagnosticRetry && ctx.graph.isSelfContainedHeader(fsPath)) continue;
        const includer = findHeaderIncluder(ctx, fsPath, uri, diagnosticRetry);
        if (!includer) continue;
        if (!isTuReadyForPreamble(includer.tuPath)) {
            rememberPendingHeader({
                uri,
                languageId: doc.languageId,
                version: doc.version,
                text: doc.getText(),
                waitForTuReady: includer.tuPath,
            }, ctx, `untracked header ${fsPath}: includer ${includer.tuPath} not ready, delaying preamble`);
            continue;
        }
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
    client: MutableLanguageClient,
): void {
    for (const doc of vscode.workspace.textDocuments) {
        const fsPath = doc.uri.fsPath;
        if (isTuPath(fsPath)) {
            tusObservedFromEditor.add(fsPath);
            tusReady.delete(fsPath);
            ctx.graph.observeTu(fsPath, doc.getText());
            client.sendNotification('textDocument/didChange', {
                textDocument: { uri: doc.uri.toString(), version: doc.version },
                contentChanges: [{ text: doc.getText() }],
            });
            ctx.log(`syncOpenDocs TU ${fsPath}: requested clangd readiness parse`);
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
    if (!isTuReadyForPreamble(observedTu)) return;
    for (const doc of vscode.workspace.textDocuments) {
        const uri = doc.uri.toString();
        const st = ctx.store.get(uri);
        if (!st || !st.active) continue;
        const fsPath = doc.uri.fsPath;
        if (!isHeaderPath(fsPath)) continue;
        const includer = findHeaderIncluder(ctx, fsPath, uri);
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

// Reopen virtual companions whose compile flags changed. clangd doesn't
// necessarily reparse already-open files after the vscode-clangd configuration
// extension updates its in-memory CDB, and virtual TU diagnostics are hidden, so
// force a close/open cycle to rebuild the companion parse with current flags.
function refreshVirtualTusForFlagChange(
    ctx: InstallContext,
    origNotify: (...args: any[]) => any,
    changedTus: Set<string>,
): void {
    for (const tuPath of changedTus) {
        if (!virtualTus.has(tuPath)) continue;
        closeTuVirtually(origNotify, tuPath);
        openTuVirtually(origNotify, tuPath);
        ctx.log(`virtual TU ${tuPath}: flags changed, replaying virtual didOpen`);
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
        if (!isTuReadyForPreamble(st.includerTu)) {
            ctx.log(`active header ${doc.uri.fsPath}: includer TU ${st.includerTu} flags changed but is not ready yet`);
            continue;
        }
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
    const didInstallApplyEditHook = installApplyWorkspaceEditHook(client, ctx);
    if (middleware[SENTINEL]) return didInstallApplyEditHook;

    // 1) Mutate the existing middleware object in place so it stays live for the
    //    already-running client. Don't overwrite — chain to whatever filter-files
    //    or other extensions installed.
    const prevDiag = middleware.handleDiagnostics;
    middleware.handleDiagnostics = (uri: vscode.Uri, diagnostics: vscode.Diagnostic[], next: any) => {
        if (!ctx.isEnabled()) return (prevDiag ?? next)(uri, diagnostics, next);

        // Virtual TU PCH-ready: first publishDiagnostics for the companion means
        // its PCH is built; re-analyze any header that opened before it was ready.
        const diagFsPath = uri.fsPath;
        if (isTuPath(diagFsPath) && tusObservedFromEditor.has(diagFsPath) && !tusReady.has(diagFsPath)) {
            tusReady.add(diagFsPath);
            ctx.log(`publishDiagnostics TU ${uri.toString()}: marked includer ready (${diagnostics.length} diagnostics)`);
            const sr = ctx.scheduleReissue;
            if (sr) {
                setImmediate(() => {
                    tryResolvePending(ctx, sr);
                    refreshActiveHeadersForTu(ctx, sr, diagFsPath);
                });
            }
        }
        const diagVt = virtualTus.get(diagFsPath);
        if (diagVt) {
            if (!diagVt.pchReady) {
                diagVt.pchReady = true;
                const sr = ctx.scheduleReissue;
                if (sr) {
                    setImmediate(() => {
                        tryResolvePending(ctx, sr);
                        refreshActiveHeadersForTu(ctx, sr, diagFsPath);
                    });
                }
            }
            ctx.log(`publishDiagnostics virtual TU ${uri.toString()}: ${diagnostics.length} → 0 (dropped virtual companion diagnostics)`);
            return (prevDiag ?? next)(uri, [], next);
        }

        const uriStr = uri.toString();
        const st = ctx.store.get(uriStr);
        if (!st || !st.active) {
            if (diagnostics.length > 0) {
                if (isHeaderPath(diagFsPath) && !disabledUris.has(uriStr) && ctx.graph.isSelfContainedHeader(diagFsPath)) {
                    const wasDiagnosticRetry = diagnosticSelfContainedUris.has(uriStr);
                    diagnosticSelfContainedUris.add(uriStr);
                    if (!pendingHeaders.has(uriStr)) {
                        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr);
                        const sr = ctx.scheduleReissue;
                        const includer = sr && doc ? findHeaderIncluder(ctx, diagFsPath, uriStr, true) : undefined;
                        if (doc && sr && includer && isTuReadyForPreamble(includer.tuPath)) {
                            ctx.log(`self-contained header ${diagFsPath}: diagnostics received, replaying with includer ${includer.tuPath}`);
                            sr({
                                uri: uriStr,
                                languageId: doc.languageId,
                                version: doc.version,
                                text: doc.getText(),
                            });
                        } else if (doc && includer) {
                            rememberPendingHeader({
                                uri: uriStr,
                                languageId: doc.languageId,
                                version: doc.version,
                                text: doc.getText(),
                                waitForTuReady: includer.tuPath,
                            }, ctx, `self-contained header ${diagFsPath}: diagnostics received, includer ${includer.tuPath} not ready`);
                        } else if (!wasDiagnosticRetry) {
                            ctx.log(`self-contained header ${diagFsPath}: diagnostics received, no includer available yet`);
                        }
                    }
                }
                // If a pending header is now publishing diagnostics (typically
                // the unresolved-symbol cascade), check if the graph has since
                // gained an includer and replay didOpen if so.
                if (pendingHeaders.has(uriStr)) resolvePendingNow(ctx);
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
        if (method === 'workspace/executeCommand') {
            const arg = Array.isArray(params?.arguments) ? params.arguments[0] : undefined;
            const uri = arg?.textDocument?.uri ?? arg?.file ?? '<no-uri>';
            const pos = arg?.position ? `${arg.position.line}:${arg.position.character}` : '<no-pos>';
            ctx.log(`workspace/executeCommand: command=${params?.command ?? '<unknown>'} uri=${uri} pos=${pos}`);
        }
        const uri: string | undefined = params?.textDocument?.uri;
        const st = uri ? ctx.store.get(uri) : undefined;
        if (!st || !st.active) {
            const promise = origRequest(...args);
            if (method !== 'textDocument/codeAction' && method !== 'textDocument/rename') return promise;
            return Promise.resolve(promise).then((result: any) => {
                if (result == null) return result;
                try {
                    if (method === 'textDocument/codeAction') return remapCodeActionResult(result, ctx, uri);
                    if (method === 'textDocument/rename') return remapWorkspaceEditResult(method, result, ctx, uri);
                } catch (e) {
                    ctx.log(`${method} shift failed: ${(e as Error).message}`);
                }
                return result;
            });
        }

        const outFn = OUT[method];
        const newArgs = args.slice();
        if (outFn) {
            newArgs[1] = deepCopy(params);
            outFn(newArgs[1], st);
        }

        const promise = origRequest(...newArgs);
        if (method === 'textDocument/codeAction' || method === 'textDocument/rename') {
            return Promise.resolve(promise).then((result: any) => {
                if (result == null) return result;
                try {
                    if (method === 'textDocument/codeAction') return remapCodeActionResult(result, ctx, uri, st);
                    if (method === 'textDocument/rename') return remapWorkspaceEditResult(method, result, ctx, uri);
                } catch (e) {
                    ctx.log(`${method} shift failed: ${(e as Error).message}`);
                }
                return result;
            });
        }
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
    queueMicrotask(() => syncOpenDocs(ctx, scheduleReissue, client));

    return true;
}
