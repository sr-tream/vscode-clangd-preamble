import * as fs from 'fs';
import * as path from 'path';

const INCLUDE_RE = /^\s*#\s*include\s*([\"<])([^\">]+)[\">]/;

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

export class Graph {
    private tuIncludes = new Map<string, IncludeEntry[]>();
    private headerUsers = new Map<string, Set<string>>();
    private tuMtime = new Map<string, number>();
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

    private pickIncluderTu(headerPath: string): string | undefined {
        const bn = path.basename(headerPath);
        const candidates = this.headerUsers.get(bn);
        if (candidates && candidates.size > 0) {
            let best: string | undefined; let bestMt = -1;
            for (const tu of candidates) {
                const mt = this.tuMtime.get(tu) ?? 0;
                if (mt > bestMt) { best = tu; bestMt = mt; }
            }
            if (best) return best;
        }
        const comp = this.companionTu(headerPath);
        if (comp && this.observeTuFromDisk(comp)) return comp;
        return undefined;
    }

    private buildPrefix(tuPath: string, headerBasename: string): { lines: string[]; direct: boolean } | undefined {
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
            const raw = tuInc[i].raw;
            bytes += raw.length + 1;
            if (lines.length >= this.maxPreambleLines || bytes > this.maxPreambleBytes) break;
            lines.push(raw);
        }
        return { lines, direct: cut >= 0 };
    }

    findIncluder(headerPath: string): IncluderPick | undefined {
        const tu = this.pickIncluderTu(headerPath);
        if (!tu) return undefined;
        const built = this.buildPrefix(tu, path.basename(headerPath));
        if (!built || built.lines.length === 0) return undefined;
        return { tuPath: tu, prefixLines: built.lines, direct: built.direct };
    }

    scanProject(root: string): number {
        if (!root) return 0;
        let scanned = 0;
        const stack: string[] = [root];
        const skipDirs = new Set(['node_modules', '.git', 'build', 'out', '.cache', '.pixi', '.venv', 'cmake-build-debug', 'cmake-build-release']);
        while (stack.length > 0 && scanned < this.projectScanLimit) {
            const dir = stack.pop()!;
            let ents: fs.Dirent[];
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { continue; }
            for (const e of ents) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (!skipDirs.has(e.name) && !e.name.startsWith('.')) stack.push(p);
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
        return lines.join('\n');
    }
}
