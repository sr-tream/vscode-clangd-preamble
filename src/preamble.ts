import { IncluderPick } from './graph';

export interface DocState {
    active: boolean;
    headerPath: string;
    headerUri: string;
    preambleText: string;
    preambleLines: number;
    includerTu: string;
    includerDirect: boolean;
    includerStale: boolean;
    droppedDiags: any[];

    semtokResultIdServer?: string | number;
    semtokResultIdUser?: string;
    semtokDataServer?: number[];
    semtokDataUser?: number[];
}

const INCLUDE_RE = /^\s*#\s*include\s*([\"<])([^\">]+)[\">]/;

function headerIncludeSet(headerText: string | undefined): Set<string> {
    const set = new Set<string>();
    if (!headerText) return set;
    for (const line of headerText.split(/\r?\n/)) {
        const m = INCLUDE_RE.exec(line);
        if (m) set.add(m[2]);
    }
    return set;
}

// Drop entries the header already includes, plus duplicates within the prefix
// itself. Without this, clang-tidy's bugprone-duplicate-include flags every
// re-include the synthetic preamble would otherwise create.
function dedupPrefixLines(prefixLines: string[], headerSet: Set<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of prefixLines) {
        const m = INCLUDE_RE.exec(raw);
        if (m) {
            const name = m[2];
            if (!headerSet.has(name) && !seen.has(name)) {
                seen.add(name);
                out.push(raw);
            }
        } else {
            out.push(raw);
        }
    }
    return out;
}

// Wrap the synthetic preamble in `#if __INCLUDE_LEVEL__ == 0 ... #endif`.
// __INCLUDE_LEVEL__ is 0 only when the file is the translation-unit root, so
// the body is active when the user opens the header directly (which is the
// only time we want it) and skipped when the same header is later #include'd
// by some other TU through its normal chain — preventing redefinition / order-
// of-include collisions.
export function buildPreambleText(prefixLines: string[], marker: string): string {
    const body: string[] = ['#if __INCLUDE_LEVEL__ == 0'];
    for (const line of prefixLines) body.push(line);
    body.push(marker);
    body.push('#endif');
    return body.join('\n') + '\n';
}

export function buildState(
    headerPath: string,
    headerUri: string,
    headerText: string | undefined,
    includer: IncluderPick,
    marker: string,
): DocState {
    const deduped = dedupPrefixLines(includer.prefixLines, headerIncludeSet(headerText));
    const preambleText = buildPreambleText(deduped, marker);
    const preambleLines = (preambleText.match(/\n/g) ?? []).length;
    return {
        active: true,
        headerPath,
        headerUri,
        preambleText,
        preambleLines,
        includerTu: includer.tuPath,
        includerDirect: includer.direct,
        includerStale: false,
        droppedDiags: [],
    };
}

export class StateStore {
    private byUri = new Map<string, DocState>();

    get(uri: string): DocState | undefined { return this.byUri.get(uri); }
    set(uri: string, st: DocState): void { this.byUri.set(uri, st); }
    delete(uri: string): boolean { return this.byUri.delete(uri); }
    keys(): IterableIterator<string> { return this.byUri.keys(); }
    values(): IterableIterator<DocState> { return this.byUri.values(); }
    clear(): void { this.byUri.clear(); }
    size(): number { return this.byUri.size; }
}
