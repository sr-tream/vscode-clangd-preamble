// Mutating helpers over raw LSP position/range/edit shapes.
// All shifts are line-only; characters never move.

export interface LspPosition { line: number; character: number; }
export interface LspRange { start: LspPosition; end: LspPosition; }

export function shiftPos(p: LspPosition | undefined | null, n: number): void {
    if (p && typeof p.line === 'number') p.line += n;
}

export function shiftRange(r: LspRange | undefined | null, n: number): void {
    if (!r) return;
    shiftPos(r.start, n);
    shiftPos(r.end, n);
}

// Returns true if the range falls entirely inside the preamble (caller should drop it).
// Otherwise clips a straddling start to the preamble boundary.
export function clipToUser(r: LspRange | undefined | null, n: number): boolean {
    if (!r) return false;
    if (r.end.line < n) return true;
    if (r.start.line < n) {
        r.start.line = n;
        r.start.character = 0;
    }
    return false;
}

export function shiftCompletionItem(item: any, n: number): void {
    if (!item) return;
    if (item.textEdit) {
        shiftRange(item.textEdit.range, n);
        shiftRange(item.textEdit.insert, n);
        shiftRange(item.textEdit.replace, n);
    }
    if (Array.isArray(item.additionalTextEdits)) {
        for (const te of item.additionalTextEdits) shiftRange(te.range, n);
    }
}

export function shiftLocations(result: any, n: number, headerUri: string): any {
    if (!result) return result;
    const one = (loc: any) => {
        if (!loc) return;
        if (loc.uri) {
            if (loc.uri === headerUri) shiftRange(loc.range, n);
        } else if (loc.targetUri) {
            if (loc.targetUri === headerUri) {
                shiftRange(loc.targetRange, n);
                shiftRange(loc.targetSelectionRange, n);
            }
            if (loc.originSelectionRange) shiftRange(loc.originSelectionRange, n);
        }
    };
    if (Array.isArray(result)) result.forEach(one);
    else one(result);
    return result;
}

// DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat with .location).
export function shiftDocSymbols(syms: any, n: number, headerUri: string): any {
    if (!Array.isArray(syms)) return syms;
    const out: any[] = [];
    for (const s of syms) {
        if (s.location) {
            if (s.location.uri === headerUri) {
                if (!clipToUser(s.location.range, n)) {
                    shiftRange(s.location.range, -n);
                    out.push(s);
                }
            } else {
                out.push(s);
            }
        } else {
            if (!clipToUser(s.range, n)) {
                shiftRange(s.range, -n);
                if (s.selectionRange) {
                    if (clipToUser(s.selectionRange, n)) {
                        s.selectionRange = JSON.parse(JSON.stringify(s.range));
                    } else {
                        shiftRange(s.selectionRange, -n);
                    }
                }
                if (s.children) s.children = shiftDocSymbols(s.children, n, headerUri);
                out.push(s);
            }
        }
    }
    return out;
}

// FoldingRange uses flat startLine/endLine ints, NOT a Range.
export function shiftFoldingRanges(ranges: any[], n: number): any[] {
    const out: any[] = [];
    for (const fr of ranges) {
        const sl = fr.startLine ?? 0;
        const el = fr.endLine ?? 0;
        if (el >= n) {
            let s = sl;
            if (s < n) { s = n; fr.startCharacter = undefined; }
            fr.startLine = s - n;
            fr.endLine = el - n;
            out.push(fr);
        }
    }
    return out;
}

// Drop edits inside the preamble, then shift the rest. Used for formatting/etc.
export function processTextEdits(edits: any[], n: number): any[] {
    if (!Array.isArray(edits)) return edits;
    const out: any[] = [];
    for (const te of edits) {
        if (!clipToUser(te.range, n)) {
            shiftRange(te.range, -n);
            out.push(te);
        }
    }
    return out;
}

export function walkWorkspaceEdit(we: any, headerUri: string, n: number, dir: 1 | -1): void {
    if (!we) return;
    const process = (edits: any[] | undefined): any[] | undefined => {
        if (!Array.isArray(edits)) return edits;
        if (dir < 0) {
            const out: any[] = [];
            for (const e of edits) {
                if (e.range && !clipToUser(e.range, n)) {
                    shiftRange(e.range, dir * n);
                    out.push(e);
                } else if (!e.range) {
                    out.push(e);
                }
            }
            return out;
        } else {
            for (const e of edits) shiftRange(e.range, dir * n);
            return edits;
        }
    };
    if (we.changes) {
        for (const uri of Object.keys(we.changes)) {
            if (uri === headerUri) we.changes[uri] = process(we.changes[uri]);
        }
    }
    if (Array.isArray(we.documentChanges)) {
        for (const dc of we.documentChanges) {
            if (dc.textDocument && dc.textDocument.uri === headerUri && dc.edits) {
                dc.edits = process(dc.edits);
            }
        }
    }
}

// Process diagnostics array (raw LSP) — drop preamble-range entries, clip & shift the rest.
// Returns { kept, dropped }.
export function processDiagnostics(
    diags: any[],
    n: number,
    headerUri: string,
): { kept: any[]; dropped: any[] } {
    const kept: any[] = [];
    const dropped: any[] = [];
    for (const d of diags) {
        if (d.range.end.line < n) {
            dropped.push(d);
            continue;
        }
        if (d.range.start.line < n) {
            d.range.start.line = n;
            d.range.start.character = 0;
        }
        shiftRange(d.range, -n);
        if (Array.isArray(d.relatedInformation)) {
            const rel: any[] = [];
            for (const ri of d.relatedInformation) {
                if (ri.location && ri.location.uri === headerUri) {
                    if (!clipToUser(ri.location.range, n)) {
                        shiftRange(ri.location.range, -n);
                        rel.push(ri);
                    }
                } else {
                    rel.push(ri);
                }
            }
            d.relatedInformation = rel;
        }
        kept.push(d);
    }
    return { kept, dropped };
}

// ===== Semantic tokens =====
// Encoded as flat [deltaLine, deltaStart, length, type, mods] tuples.
// First token's deltaLine is from line 0; deltaStart is column-relative-on-same-line
// or absolute when deltaLine > 0.

interface DecodedToken { line: number; col: number; len: number; typ: number; mods: number; }

export function decodeFull(data: number[]): DecodedToken[] {
    const out: DecodedToken[] = [];
    let cl = 0, cc = 0;
    for (let i = 0; i < data.length; i += 5) {
        const dl = data[i];
        const ds = data[i + 1];
        if (dl > 0) { cl += dl; cc = ds; }
        else { cc += ds; }
        out.push({ line: cl, col: cc, len: data[i + 2], typ: data[i + 3], mods: data[i + 4] });
    }
    return out;
}

export function encodeFull(tokens: DecodedToken[]): number[] {
    const out: number[] = [];
    let pl = 0, pc = 0;
    let first = true;
    for (const t of tokens) {
        let dl: number, ds: number;
        if (first) { dl = t.line; ds = t.col; first = false; }
        else {
            dl = t.line - pl;
            ds = dl > 0 ? t.col : t.col - pc;
        }
        out.push(dl, ds, t.len, t.typ, t.mods);
        pl = t.line; pc = t.col;
    }
    return out;
}

export function shiftSemtokFull(serverData: number[], n: number): number[] {
    if (!serverData || serverData.length === 0) return [];
    const toks = decodeFull(serverData);
    const kept: DecodedToken[] = [];
    for (const t of toks) {
        if (t.line >= n) kept.push({ line: t.line - n, col: t.col, len: t.len, typ: t.typ, mods: t.mods });
    }
    return encodeFull(kept);
}

export function applySemtokEdits(dataServer: number[], edits: any[]): number[] {
    let result = dataServer.slice();
    const sorted = edits.slice().sort((a, b) => b.start - a.start);
    for (const e of sorted) {
        const before = result.slice(0, e.start);
        const after = result.slice(e.start + (e.deleteCount ?? 0));
        result = before.concat(e.data ?? [], after);
    }
    return result;
}
