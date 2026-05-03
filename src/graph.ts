import * as fs from 'fs';
import * as path from 'path';

const INCLUDE_RE = /^\s*#\s*include\s*([\"<])([^\">]+)[\">]/;

const CYCLE_CHECK_DEPTH = 1;
const SELF_CONTAINED_INCLUDE_THRESHOLD = 3;

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
}

export class Graph {
    private tuIncludes = new Map<string, IncludeEntry[]>();
    private headerUsers = new Map<string, Set<string>>();
    private tuMtime = new Map<string, number>();
    private pathCache = new Map<string, string | null>();
    private lruSeq = 0;

    constructor(
        private maxPreambleLines = 1500,
        private maxPreambleBytes = 65536,
        private projectScanLimit = 2000,
    ) {}

    setLimits(maxLines: number, maxBytes: number, scanLimit: number): void {
        this.maxPreambleLines = maxLines;
        this.maxPreambleBytes = maxBytes;
        this.projectScanLimit = scanLimit;
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

    observeTu(tuPath: string, sourceText: string): void {
        const incs = this.parseText(sourceText);
        this.tuIncludes.set(tuPath, incs);
        this.tuMtime.set(tuPath, ++this.lruSeq);
        for (const e of incs) {
            const bn = path.basename(e.name);
            let users = this.headerUsers.get(bn);
            if (!users) { users = new Set(); this.headerUsers.set(bn, users); }
            users.add(tuPath);
        }
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
        this.tuIncludes.delete(tuPath);
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

    // Pick the TU with the SHORTEST prefix-before-this-header. A polluting
    // includer (e.g. CEF wrapper that puts common.h after several framework
    // headers) would inject macros that conflict with the header's own
    // includes — pick the most "neutral" TU instead. Tie-break: most recent
    // observation.
    private pickIncluderTu(headerPath: string): string | undefined {
        const bn = path.basename(headerPath);
        const candidates = this.headerUsers.get(bn);
        if (candidates && candidates.size > 0) {
            let best: string | undefined;
            let bestPos = Infinity;
            let bestMt = -1;
            for (const tu of candidates) {
                const tuInc = this.tuIncludes.get(tu);
                if (!tuInc) continue;
                let pos = tuInc.length;
                for (let i = 0; i < tuInc.length; i++) {
                    if (path.basename(tuInc[i].name) === bn) { pos = i; break; }
                }
                const mt = this.tuMtime.get(tu) ?? 0;
                if (pos < bestPos || (pos === bestPos && mt > bestMt)) {
                    best = tu; bestPos = pos; bestMt = mt;
                }
            }
            if (best) return best;
        }
        const comp = this.companionTu(headerPath);
        if (comp && this.observeTuFromDisk(comp)) return comp;
        return undefined;
    }

    // Walk root recursively for a file matching `basename`. Cached per-basename
    // (positive or null), since the cycle-check below may query the same name
    // many times across one buildPrefix.
    private findHeaderPath(basename: string, root: string): string | undefined {
        const cached = this.pathCache.get(basename);
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
                    this.pathCache.set(basename, p);
                    return p;
                }
                if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
                    stack.push(path.join(dir, e.name));
                }
            }
        }
        this.pathCache.set(basename, null);
        return undefined;
    }

    private fileIncludes(filepath: string): IncludeEntry[] | undefined {
        const cached = this.tuIncludes.get(filepath);
        if (cached) return cached;
        let text: string;
        try { text = fs.readFileSync(filepath, 'utf8'); }
        catch { return undefined; }
        const incs = this.parseText(text);
        this.tuIncludes.set(filepath, incs);
        return incs;
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
        const lines: string[] = [];
        let bytes = 0;
        const stop = cut >= 0 ? cut : tuInc.length;
        for (let i = 0; i < stop; i++) {
            const e = tuInc[i];
            const prefixBn = path.basename(e.name);
            if (prefixBn !== headerBasename
                && !this.transitivelyIncludes(prefixBn, headerBasename, root, CYCLE_CHECK_DEPTH, new Set())) {
                const raw = e.raw;
                bytes += raw.length + 1;
                if (lines.length >= this.maxPreambleLines || bytes > this.maxPreambleBytes) break;
                lines.push(raw);
            }
        }
        return { lines, direct: cut >= 0 };
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
        const tu = this.pickIncluderTu(headerPath);
        if (!tu) return undefined;
        const root = this.projectRootForTu(tu);
        const built = this.buildPrefix(tu, path.basename(headerPath), root);
        if (!built || built.lines.length === 0) return undefined;
        return { tuPath: tu, prefixLines: built.lines, direct: built.direct };
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
