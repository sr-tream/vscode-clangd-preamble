import * as fs from 'fs';
import * as path from 'path';

const INCLUDE_RE = /^\s*#\s*include\s*([\"<])([^\">]+)[\">]/;

const CYCLE_CHECK_DEPTH = 1;
const SELF_CONTAINED_INCLUDE_THRESHOLD = 3;
const DEFAULT_INDIRECT_INCLUDE_DEPTH = 2;

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'out', '.cache', '.pixi', '.venv',
    'cmake-build-debug', 'cmake-build-release',
]);

export interface IncludeEntry {
    name: string;
    kind: '"' | '<';
    line: number;
    raw: string;
}

export interface IncluderPick {
    tuPath: string;
    prefixLines: string[];
    direct: boolean;
}

export interface IncluderCandidate extends IncluderPick {
    includeIndex: number;
    observedOrder: number;
    companion: boolean;
    includeDepth?: number;
}

const HEADER_EXTS = new Set(['.h', '.hh', '.hpp', '.hxx', '.inl', '.inc', '.ipp', '.tcc', '.tpp']);
const TU_EXTS = new Set(['.cpp', '.cc', '.cxx', '.c', '.C', '.mm']);

export function isHeaderPath(p: string): boolean {
    return HEADER_EXTS.has(path.extname(p));
}
export function isTuPath(p: string): boolean {
    return TU_EXTS.has(path.extname(p));
}

export interface FindIncluderOptions {
    force?: boolean;
    preferredTu?: string;
}

export interface CachedTuEntry {
    path: string;
    includes: IncludeEntry[];
    mtimeMs: number;
    size: number;
    observedOrder: number;
}

export interface GraphSnapshot {
    version: 1;
    createdAt: number;
    lruSeq: number;
    tus: CachedTuEntry[];
}

export interface GraphRestoreResult {
    loaded: number;
    dropped: number;
    unsupported: boolean;
}

interface PrefixState {
    lines: string[];
    bytes: number;
}

interface IndirectMatch {
    prefixLines: string[];
    includeIndex: number;
    includeDepth: number;
}

export class Graph {
    private tuIncludes = new Map<string, IncludeEntry[]>();
    private headerUsers = new Map<string, Set<string>>();
    private tuMtime = new Map<string, number>();
    private fileIncludeCache = new Map<string, IncludeEntry[]>();
    private pathCache = new Map<string, string | null>();
    private lruSeq = 0;
    private changeListeners = new Set<() => void>();

    constructor(
        private maxPreambleLines = 1500,
        private maxPreambleBytes = 65536,
        private projectScanLimit = 2000,
        private indirectIncludeDepth = DEFAULT_INDIRECT_INCLUDE_DEPTH,
    ) {}

    setLimits(maxLines: number, maxBytes: number, scanLimit: number, indirectIncludeDepth = this.indirectIncludeDepth): void {
        this.maxPreambleLines = maxLines;
        this.maxPreambleBytes = maxBytes;
        this.projectScanLimit = scanLimit;
        this.indirectIncludeDepth = Math.max(0, Math.floor(indirectIncludeDepth));
    }

    onDidChange(listener: () => void): { dispose: () => void } {
        this.changeListeners.add(listener);
        return { dispose: () => this.changeListeners.delete(listener) };
    }

    private emitChange(): void {
        for (const listener of this.changeListeners) listener();
    }

    private parseText(text: string): IncludeEntry[] {
        const out: IncludeEntry[] = [];
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const m = INCLUDE_RE.exec(lines[i]);
            if (m) out.push({ name: m[2], kind: m[1] as '"' | '<', line: i, raw: lines[i] });
        }
        return out;
    }

    private cloneIncludes(incs: IncludeEntry[]): IncludeEntry[] {
        return incs.map((e) => ({ name: e.name, kind: e.kind, line: e.line, raw: e.raw }));
    }

    private unindexTu(tuPath: string): void {
        const old = this.tuIncludes.get(tuPath);
        if (!old) return;
        for (const e of old) {
            const bn = path.basename(e.name);
            const users = this.headerUsers.get(bn);
            if (!users) continue;
            users.delete(tuPath);
            if (users.size === 0) this.headerUsers.delete(bn);
        }
    }

    private setTuIncludes(tuPath: string, incs: IncludeEntry[], observedOrder: number): void {
        this.unindexTu(tuPath);
        this.fileIncludeCache.delete(tuPath);
        this.tuIncludes.set(tuPath, incs);
        this.tuMtime.set(tuPath, observedOrder);
        for (const e of incs) {
            const bn = path.basename(e.name);
            let users = this.headerUsers.get(bn);
            if (!users) { users = new Set(); this.headerUsers.set(bn, users); }
            users.add(tuPath);
        }
        if (observedOrder > this.lruSeq) this.lruSeq = observedOrder;
    }

    observeTu(tuPath: string, sourceText: string): void {
        const incs = this.parseText(sourceText);
        this.setTuIncludes(tuPath, incs, ++this.lruSeq);
        this.emitChange();
    }

    observeTuFromDisk(tuPath: string): boolean {
        try {
            const txt = fs.readFileSync(tuPath, 'utf8');
            this.observeTu(tuPath, txt);
            return true;
        } catch {
            return false;
        }
    }

    invalidate(tuPath: string): void {
        const hadPersistedEntry = isTuPath(tuPath) && this.tuIncludes.has(tuPath);
        this.unindexTu(tuPath);
        this.tuIncludes.delete(tuPath);
        this.tuMtime.delete(tuPath);
        this.fileIncludeCache.delete(tuPath);
        if (isHeaderPath(tuPath)) this.clearPathCacheFor(tuPath);
        if (hadPersistedEntry) this.emitChange();
    }

    snapshot(): GraphSnapshot {
        const tus = Array.from(this.tuIncludes.entries())
            .filter(([tuPath]) => isTuPath(tuPath))
            .map(([tuPath, includes]) => ({
                tuPath,
                includes,
                observedOrder: this.tuMtime.get(tuPath) ?? 0,
            }))
            .sort((a, b) => b.observedOrder - a.observedOrder)
            .slice(0, this.projectScanLimit);
        const entries: CachedTuEntry[] = [];
        for (const tu of tus) {
            try {
                const st = fs.statSync(tu.tuPath);
                if (!st.isFile()) continue;
                entries.push({
                    path: tu.tuPath,
                    includes: this.cloneIncludes(tu.includes),
                    mtimeMs: st.mtimeMs,
                    size: st.size,
                    observedOrder: tu.observedOrder,
                });
            } catch {/* ignore stale files */}
        }
        return { version: 1, createdAt: Date.now(), lruSeq: this.lruSeq, tus: entries };
    }

    restoreSnapshot(snapshot: unknown): GraphRestoreResult {
        if (!this.isGraphSnapshot(snapshot)) {
            return { loaded: 0, dropped: 0, unsupported: snapshot !== undefined };
        }
        let loaded = 0;
        let dropped = 0;
        for (const entry of snapshot.tus) {
            try {
                const st = fs.statSync(entry.path);
                if (!st.isFile() || st.mtimeMs !== entry.mtimeMs || st.size !== entry.size) {
                    dropped++;
                    continue;
                }
            } catch {
                dropped++;
                continue;
            }
            this.setTuIncludes(entry.path, this.cloneIncludes(entry.includes), entry.observedOrder);
            loaded++;
        }
        if (snapshot.lruSeq > this.lruSeq) this.lruSeq = snapshot.lruSeq;
        return { loaded, dropped, unsupported: false };
    }

    private isGraphSnapshot(value: unknown): value is GraphSnapshot {
        if (!value || typeof value !== 'object') return false;
        const snap = value as Partial<GraphSnapshot>;
        if (snap.version !== 1 || !Array.isArray(snap.tus)) return false;
        if (typeof snap.createdAt !== 'number' || typeof snap.lruSeq !== 'number') return false;
        return snap.tus.every((entry) => this.isCachedTuEntry(entry));
    }

    private isCachedTuEntry(value: unknown): value is CachedTuEntry {
        if (!value || typeof value !== 'object') return false;
        const entry = value as Partial<CachedTuEntry>;
        return typeof entry.path === 'string'
            && typeof entry.mtimeMs === 'number'
            && typeof entry.size === 'number'
            && typeof entry.observedOrder === 'number'
            && Array.isArray(entry.includes)
            && entry.includes.every((inc) => this.isIncludeEntry(inc));
    }

    private isIncludeEntry(value: unknown): value is IncludeEntry {
        if (!value || typeof value !== 'object') return false;
        const entry = value as Partial<IncludeEntry>;
        return typeof entry.name === 'string'
            && (entry.kind === '"' || entry.kind === '<')
            && typeof entry.line === 'number'
            && typeof entry.raw === 'string';
    }

    private companionTu(headerPath: string): string | undefined {
        const dir = path.dirname(headerPath);
        const stem = path.basename(headerPath, path.extname(headerPath));
        for (const ext of ['cpp', 'cc', 'cxx', 'c', 'C', 'mm']) {
            const candidate = path.join(dir, `${stem}.${ext}`);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch {/* ignore */}
        }
        return undefined;
    }

    private observedCandidateTus(headerPath: string): string[] {
        const bn = path.basename(headerPath);
        const candidates = this.headerUsers.get(bn);
        if (!candidates) return [];
        return Array.from(candidates).filter(tu => this.tuIncludes.has(tu));
    }

    private includeIndex(tuPath: string, headerBasename: string): number {
        const tuInc = this.tuIncludes.get(tuPath);
        if (!tuInc) return Infinity;
        for (let i = 0; i < tuInc.length; i++) {
            if (path.basename(tuInc[i].name) === headerBasename) return i;
        }
        return tuInc.length;
    }

    private samePath(a: string, b: string): boolean {
        return path.normalize(a) === path.normalize(b);
    }

    private candidateFromTu(
        tuPath: string,
        headerPath: string,
        companion: boolean,
    ): IncluderCandidate | undefined {
        const headerBasename = path.basename(headerPath);
        const root = this.projectRootForTu(tuPath);
        const built = this.buildPrefix(tuPath, headerBasename, root);
        if (!built || built.lines.length === 0) return undefined;
        return {
            tuPath,
            prefixLines: built.lines,
            direct: built.direct,
            includeIndex: this.includeIndex(tuPath, headerBasename),
            observedOrder: this.tuMtime.get(tuPath) ?? 0,
            companion,
        };
    }

    private sortCandidates(candidates: IncluderCandidate[]): IncluderCandidate[] {
        return candidates.sort((a, b) => {
            if (a.includeIndex !== b.includeIndex) return a.includeIndex - b.includeIndex;
            if (a.observedOrder !== b.observedOrder) return b.observedOrder - a.observedOrder;
            return a.tuPath.localeCompare(b.tuPath);
        });
    }

    private companionCandidate(headerPath: string): IncluderCandidate | undefined {
        const comp = this.companionTu(headerPath);
        if (!comp) return undefined;
        if (!this.tuIncludes.has(comp) && !this.observeTuFromDisk(comp)) return undefined;
        return this.candidateFromTu(comp, headerPath, true);
    }

    private observedCandidates(headerPath: string): IncluderCandidate[] {
        const out: IncluderCandidate[] = [];
        for (const tu of this.observedCandidateTus(headerPath)) {
            const candidate = this.candidateFromTu(tu, headerPath, false);
            if (candidate) out.push(candidate);
        }
        return this.sortCandidates(out);
    }

    private pathCacheKey(basename: string, root: string): string {
        return `${root}\0${basename}`;
    }

    private clearPathCacheFor(filepath: string): void {
        const basename = path.basename(filepath);
        for (const key of Array.from(this.pathCache.keys())) {
            if (key.endsWith(`\0${basename}`)) this.pathCache.delete(key);
        }
    }

    // Walk root recursively for a file matching `basename`. Cached per-basename
    // (positive or null), since the cycle-check below may query the same name
    // many times across one buildPrefix.
    private findHeaderPath(basename: string, root: string): string | undefined {
        const cacheKey = this.pathCacheKey(basename, root);
        const cached = this.pathCache.get(cacheKey);
        if (cached !== undefined) return cached ?? undefined;
        const stack: string[] = [root];
        while (stack.length > 0) {
            const dir = stack.pop()!;
            let ents: fs.Dirent[];
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { continue; }
            for (const e of ents) {
                if (e.isFile() && e.name === basename) {
                    const p = path.join(dir, e.name);
                    this.pathCache.set(cacheKey, p);
                    return p;
                }
                if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
                    stack.push(path.join(dir, e.name));
                }
            }
        }
        this.pathCache.set(cacheKey, null);
        return undefined;
    }

    private fileIncludes(filepath: string): IncludeEntry[] | undefined {
        const cached = this.tuIncludes.get(filepath) ?? this.fileIncludeCache.get(filepath);
        if (cached) return cached;
        let text: string;
        try { text = fs.readFileSync(filepath, 'utf8'); }
        catch { return undefined; }
        const incs = this.parseText(text);
        this.fileIncludeCache.set(filepath, incs);
        return incs;
    }

    private resolveIncludePath(fromPath: string, entry: IncludeEntry, root: string): string | undefined {
        if (entry.kind === '"') {
            const local = path.resolve(path.dirname(fromPath), entry.name);
            try {
                if (fs.statSync(local).isFile()) return local;
            } catch {/* ignore */}
        }
        if (!isHeaderPath(entry.name)) return undefined;
        return this.findHeaderPath(path.basename(entry.name), root);
    }

    private includeEntryMatchesHeader(
        fromPath: string, entry: IncludeEntry, headerPath: string, root: string,
    ): boolean {
        const resolved = this.resolveIncludePath(fromPath, entry, root);
        if (resolved) return this.samePath(resolved, headerPath);
        return path.basename(entry.name) === path.basename(headerPath);
    }

    // True if a header named `startBn` (recursively, up to `depth`) #include's
    // `targetBn`. Used to drop preamble entries whose body would re-include the
    // target header (cyclic chains that produce redefinition errors).
    private transitivelyIncludes(
        startBn: string, targetBn: string, root: string, depth: number, seen: Set<string>,
    ): boolean {
        if (depth <= 0) return false;
        const p = this.findHeaderPath(startBn, root);
        if (!p || seen.has(p)) return false;
        seen.add(p);
        const incs = this.fileIncludes(p);
        if (!incs) return false;
        for (const e of incs) if (path.basename(e.name) === targetBn) return true;
        for (const e of incs) {
            if (this.transitivelyIncludes(path.basename(e.name), targetBn, root, depth - 1, seen)) return true;
        }
        return false;
    }

    private buildPrefix(
        tuPath: string, headerBasename: string, root: string,
    ): { lines: string[]; direct: boolean } | undefined {
        const tuInc = this.tuIncludes.get(tuPath);
        if (!tuInc) return undefined;
        let cut = -1;
        for (let i = 0; i < tuInc.length; i++) {
            if (path.basename(tuInc[i].name) === headerBasename) { cut = i; break; }
        }
        const stop = cut >= 0 ? cut : tuInc.length;
        const state: PrefixState = { lines: [], bytes: 0 };
        this.appendFilteredPrefix(tuInc, stop, headerBasename, root, state);
        return { lines: state.lines, direct: cut >= 0 };
    }

    private appendFilteredPrefix(
        includes: IncludeEntry[], stop: number, headerBasename: string, root: string, state: PrefixState,
    ): void {
        for (let i = 0; i < stop; i++) {
            const e = includes[i];
            const prefixBn = path.basename(e.name);
            if (prefixBn === headerBasename
                || this.transitivelyIncludes(prefixBn, headerBasename, root, CYCLE_CHECK_DEPTH, new Set())) {
                continue;
            }
            const raw = e.raw;
            const nextBytes = state.bytes + raw.length + 1;
            if (state.lines.length >= this.maxPreambleLines || nextBytes > this.maxPreambleBytes) break;
            state.bytes = nextBytes;
            state.lines.push(raw);
        }
    }

    private clonePrefixState(state: PrefixState): PrefixState {
        return { lines: [...state.lines], bytes: state.bytes };
    }

    private findIndirectMatchInFile(
        currentPath: string,
        includes: IncludeEntry[],
        headerPath: string,
        root: string,
        depthRemaining: number,
        prefix: PrefixState,
        seen: Set<string>,
        rootIndex: number | undefined,
        currentDepth: number,
    ): IndirectMatch | undefined {
        const headerBasename = path.basename(headerPath);
        for (let i = 0; i < includes.length; i++) {
            const entry = includes[i];
            const nextPrefix = this.clonePrefixState(prefix);
            this.appendFilteredPrefix(includes, i, headerBasename, root, nextPrefix);
            const includeIndex = rootIndex ?? i;
            const matchesTarget = this.includeEntryMatchesHeader(currentPath, entry, headerPath, root);
            if (matchesTarget) {
                if (rootIndex !== undefined) {
                    return {
                        prefixLines: nextPrefix.lines,
                        includeIndex,
                        includeDepth: currentDepth + 1,
                    };
                }
                continue;
            }
            if (depthRemaining <= 1) continue;
            const resolved = this.resolveIncludePath(currentPath, entry, root);
            if (!resolved || !isHeaderPath(resolved) || seen.has(resolved)) continue;
            const childIncludes = this.fileIncludes(resolved);
            if (!childIncludes) continue;
            seen.add(resolved);
            const found = this.findIndirectMatchInFile(
                resolved,
                childIncludes,
                headerPath,
                root,
                depthRemaining - 1,
                nextPrefix,
                seen,
                includeIndex,
                currentDepth + 1,
            );
            seen.delete(resolved);
            if (found) return found;
        }
        return undefined;
    }

    private indirectCandidateFromTu(tuPath: string, headerPath: string): IncluderCandidate | undefined {
        if (this.indirectIncludeDepth < 2) return undefined;
        const tuInc = this.tuIncludes.get(tuPath);
        if (!tuInc || !isTuPath(tuPath)) return undefined;
        const root = this.projectRootForTu(tuPath);
        const found = this.findIndirectMatchInFile(
            tuPath,
            tuInc,
            headerPath,
            root,
            this.indirectIncludeDepth,
            { lines: [], bytes: 0 },
            new Set([tuPath]),
            undefined,
            0,
        );
        if (!found || found.prefixLines.length === 0) return undefined;
        return {
            tuPath,
            prefixLines: found.prefixLines,
            direct: false,
            includeIndex: found.includeIndex,
            observedOrder: this.tuMtime.get(tuPath) ?? 0,
            companion: false,
            includeDepth: found.includeDepth,
        };
    }

    private indirectCandidates(headerPath: string): IncluderCandidate[] {
        const out: IncluderCandidate[] = [];
        for (const tu of this.tuIncludes.keys()) {
            const candidate = this.indirectCandidateFromTu(tu, headerPath);
            if (candidate) out.push(candidate);
        }
        return this.sortCandidates(out);
    }

    // A header with many own #includes is likely making a deliberate effort to
    // be self-contained, and our preamble can only introduce conflicts in that
    // case. Headers with very few includes (DamageManager.h with just common.h
    // and a forward-decl) genuinely rely on the includer's transitive context.
    private headerIsSelfContained(filepath: string): boolean {
        let text: string;
        try { text = fs.readFileSync(filepath, 'utf8'); }
        catch { return true; }
        let count = 0;
        for (const line of text.split(/\r?\n/)) {
            if (INCLUDE_RE.test(line)) {
                count++;
                if (count >= SELF_CONTAINED_INCLUDE_THRESHOLD) return true;
            }
        }
        return false;
    }

    isSelfContainedHeader(filepath: string): boolean {
        return this.headerIsSelfContained(filepath);
    }

    // Walk up from `tu`'s directory looking for .git or compile_commands.json,
    // capped at 5 levels. Used to scope findHeaderPath to a sensible root.
    private projectRootForTu(tu: string): string {
        let root = path.dirname(tu);
        for (let i = 0; i < 5; i++) {
            const up = path.dirname(root);
            if (up === root) break;
            try {
                if (fs.existsSync(path.join(root, '.git'))
                    || fs.existsSync(path.join(root, 'compile_commands.json'))) break;
            } catch {/* ignore */}
            root = up;
        }
        return root;
    }

    findIncluder(headerPath: string, options: FindIncluderOptions = {}): IncluderPick | undefined {
        if (!options.force && this.headerIsSelfContained(headerPath)) return undefined;
        if (options.preferredTu) {
            const preferred = this.listIncluders(headerPath, { force: true })
                .find(c => c.tuPath === options.preferredTu);
            if (preferred) return preferred;
        }
        const observed = this.observedCandidates(headerPath);
        if (observed.length > 0) return observed[0];
        const comp = this.companionCandidate(headerPath);
        if (comp) return comp;
        return this.indirectCandidates(headerPath)[0];
    }

    findRecentIncluder(headerPath: string, options: FindIncluderOptions = {}): IncluderPick | undefined {
        if (!options.force && this.headerIsSelfContained(headerPath)) return undefined;
        const observed = this.observedCandidates(headerPath).sort((a, b) => {
            if (a.observedOrder !== b.observedOrder) return b.observedOrder - a.observedOrder;
            if (a.includeIndex !== b.includeIndex) return a.includeIndex - b.includeIndex;
            return a.tuPath.localeCompare(b.tuPath);
        });
        return observed[0];
    }

    listIncluders(headerPath: string, options: FindIncluderOptions = {}): IncluderCandidate[] {
        if (!options.force && this.headerIsSelfContained(headerPath)) return [];
        const out = this.observedCandidates(headerPath);
        const comp = this.companionCandidate(headerPath);
        if (comp && !out.some(c => c.tuPath === comp.tuPath)) out.push(comp);
        if (out.length === 0 || out.every(c => c.companion)) {
            for (const c of this.indirectCandidates(headerPath)) {
                if (!out.some(existing => existing.tuPath === c.tuPath)) out.push(c);
            }
        }
        return this.sortCandidates(out);
    }

    scanProject(root: string): number {
        if (!root) return 0;
        let scanned = 0;
        const stack: string[] = [root];
        while (stack.length > 0 && scanned < this.projectScanLimit) {
            const dir = stack.pop()!;
            let ents: fs.Dirent[];
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { continue; }
            for (const e of ents) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(p);
                } else if (e.isFile() && isTuPath(p)) {
                    if (!this.tuIncludes.has(p)) {
                        if (this.observeTuFromDisk(p)) scanned++;
                        if (scanned >= this.projectScanLimit) break;
                    }
                }
            }
        }
        return scanned;
    }

    dump(): string {
        const lines = [`TUs observed: ${this.tuIncludes.size}`];
        const sorted = Array.from(this.tuIncludes.keys()).sort(
            (a, b) => (this.tuMtime.get(b) ?? 0) - (this.tuMtime.get(a) ?? 0),
        );
        for (const tu of sorted) {
            lines.push(`  [${this.tuMtime.get(tu)}]  ${tu}  (${this.tuIncludes.get(tu)!.length} includes)`);
        }
        lines.push(`Header basenames indexed: ${this.headerUsers.size}`);
        lines.push(`Path cache entries: ${this.pathCache.size}`);
        return lines.join('\n');
    }
}
