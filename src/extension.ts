import * as path from 'path';
import * as vscode from 'vscode';
import { Graph } from './graph';
import { StateStore } from './preamble';
import { installHooks, InstallContext, resolvePendingNow, _pendingUris } from './middleware';

const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
const CFG_NS = 'clangd-preamble';

const enum LCState { Stopped = 1, Running = 2, Starting = 3 }
interface StateChangeEvent { oldState: LCState; newState: LCState; }
interface MutableLanguageClient {
    clientOptions: { middleware?: any };
    sendNotification(method: any, params?: any): any;
    sendRequest(method: any, ...args: any[]): Thenable<any>;
    onDidChangeState(listener: (e: StateChangeEvent) => void): vscode.Disposable;
    state: LCState;
}
interface ClangdApiV1 { languageClient: MutableLanguageClient | undefined; }
interface ClangdExtension { getApi(version: 1): ClangdApiV1; }

let logChannel: vscode.OutputChannel | undefined;
function log(message: string): void {
    if (!cfg<boolean>('log', false)) return;
    if (!logChannel) logChannel = vscode.window.createOutputChannel('clangd Preamble');
    logChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
function cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CFG_NS).get<T>(key, fallback);
}

const graph = new Graph();
const store = new StateStore();
const stateChangeEmitter = new vscode.EventEmitter<string>();

function applyConfigToGraph(): void {
    graph.setLimits(
        cfg<number>('maxPreambleLines', 1500),
        cfg<number>('maxPreambleBytes', 65536),
        cfg<number>('projectScanLimit', 2000),
    );
}

const installCtx: InstallContext = {
    graph,
    store,
    isEnabled: () => cfg<boolean>('enabled', true),
    log,
    marker: () => cfg<string>('markerComment', '// __NSC_PREAMBLE_END__'),
    onStateChange: (uri: string) => stateChangeEmitter.fire(uri),
};

let attachedClient: MutableLanguageClient | undefined;
let stateSub: vscode.Disposable | undefined;

const REATTACH_POLL_MS = 200;
const REATTACH_MAX_ATTEMPTS = 50;

async function getExtension(): Promise<vscode.Extension<ClangdExtension> | undefined> {
    const ext = vscode.extensions.getExtension<ClangdExtension>(CLANGD_EXTENSION_ID);
    if (!ext) {
        vscode.window.showErrorMessage(
            `vscode-clangd-preamble: required extension '${CLANGD_EXTENSION_ID}' not found.`,
        );
        return undefined;
    }
    if (!ext.isActive) await ext.activate();
    return ext;
}

function attach(ext: vscode.Extension<ClangdExtension>, attempt = 0): void {
    stateSub?.dispose();
    stateSub = undefined;

    const client = ext.exports.getApi(1).languageClient;
    if (!client || client === attachedClient) {
        if (attempt < REATTACH_MAX_ATTEMPTS) {
            setTimeout(() => attach(ext, attempt + 1), REATTACH_POLL_MS);
        } else {
            log('giving up reattach; use clangd-preamble.reattach to retry');
        }
        return;
    }

    if (installHooks(client, installCtx)) {
        log('hooks installed on running client');
    } else {
        log('hooks already present on this client');
    }
    attachedClient = client;

    stateSub = client.onDidChangeState(({ newState }) => {
        if (newState !== LCState.Stopped) return;
        log('language client stopped; awaiting new instance');
        stateSub?.dispose();
        stateSub = undefined;
        attachedClient = undefined;
        store.clear();
        attach(ext);
    });
}

// ============================================================================
// Status bar
// ============================================================================
class PreambleStatus implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private subs: vscode.Disposable[] = [];

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.item.command = 'clangd-preamble.refresh';

        this.subs.push(
            this.item,
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
            vscode.workspace.onDidCloseTextDocument(() => this.refresh()),
            stateChangeEmitter.event(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(CFG_NS)) this.refresh();
            }),
        );
        this.refresh();
    }

    private refresh(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !installCtx.isEnabled()) { this.item.hide(); return; }
        const uri = editor.document.uri.toString();
        const st = store.get(uri);
        if (st && st.active) {
            const tuName = path.basename(st.includerTu);
            this.item.text = `$(file-symlink-file) Preamble: ${tuName}`;
            const md = new vscode.MarkdownString(
                `**clangd-preamble active**\n\n` +
                `- Includer TU: \`${st.includerTu}\`\n` +
                `- Preamble lines: \`${st.preambleLines}\`\n` +
                `- Direct include: \`${st.includerDirect}\`\n` +
                `- Suppressed diagnostics: \`${st.droppedDiags.length}\`\n\n` +
                `[Refresh](command:clangd-preamble.refresh) · [Disable for this file](command:clangd-preamble.disableBuf)`,
            );
            md.isTrusted = true;
            this.item.tooltip = md;
            this.item.show();
            return;
        }
        if (_pendingUris().includes(uri)) {
            this.item.text = `$(watch) Preamble: pending`;
            const md = new vscode.MarkdownString(
                `**clangd-preamble waiting for includer**\n\n` +
                `No translation unit including this header has been observed yet.\n` +
                `Open the corresponding \`.cpp\` (or run **Scan Project for Includer TUs**) and the preamble will be injected automatically.\n\n` +
                `[Refresh](command:clangd-preamble.refresh) · [Scan Project](command:clangd-preamble.scanProject)`,
            );
            md.isTrusted = true;
            this.item.tooltip = md;
            this.item.show();
            return;
        }
        this.item.hide();
    }

    dispose(): void { this.subs.forEach((s) => s.dispose()); }
}

// ============================================================================
// Commands
// ============================================================================
async function reissueDidOpen(client: MutableLanguageClient, doc: vscode.TextDocument): Promise<void> {
    const uri = doc.uri.toString();
    await client.sendNotification('textDocument/didClose', { textDocument: { uri } });
    await client.sendNotification('textDocument/didOpen', {
        textDocument: {
            uri,
            languageId: doc.languageId,
            version: doc.version,
            text: doc.getText(),
        },
    });
}

function activeHeaderDoc(): vscode.TextDocument | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
        vscode.window.showWarningMessage('clangd-preamble: no active editor');
        return undefined;
    }
    return ed.document;
}

async function cmdRefresh(): Promise<void> {
    const doc = activeHeaderDoc();
    if (!doc || !attachedClient) return;
    const uri = doc.uri.toString();
    const existing = store.get(uri);
    if (existing) graph.invalidate(existing.includerTu);
    await reissueDidOpen(attachedClient, doc);
    const st = store.get(uri);
    if (st) {
        vscode.window.showInformationMessage(
            `clangd-preamble: refreshed (TU=${path.basename(st.includerTu)}, ${st.preambleLines} lines)`,
        );
    } else {
        vscode.window.showWarningMessage('clangd-preamble: no includer found for current file');
    }
}

async function cmdDisableBuf(): Promise<void> {
    const doc = activeHeaderDoc();
    if (!doc || !attachedClient) return;
    const st = store.get(doc.uri.toString());
    if (!st) {
        vscode.window.showWarningMessage('clangd-preamble: no state for current file');
        return;
    }
    st.active = false;
    store.delete(doc.uri.toString());
    stateChangeEmitter.fire(doc.uri.toString());
    await reissueDidOpen(attachedClient, doc);
}

async function cmdEnableBuf(): Promise<void> {
    const doc = activeHeaderDoc();
    if (!doc || !attachedClient) return;
    await reissueDidOpen(attachedClient, doc);
}

function cmdDumpGraph(): void {
    const lines = [graph.dump(), ''];
    const pending = _pendingUris();
    lines.push(`Pending headers (awaiting includer): ${pending.length}`);
    for (const u of pending) lines.push(`  ${u}`);
    showInOutput('Include Graph', lines.join('\n'));
}

function cmdDumpState(): void {
    const doc = activeHeaderDoc();
    if (!doc) return;
    const st = store.get(doc.uri.toString());
    if (!st) {
        showInOutput('Preamble State', `No state for ${doc.uri.toString()}`);
        return;
    }
    const lines = [
        `URI:           ${st.headerUri}`,
        `Active:        ${st.active}`,
        `Includer TU:   ${st.includerTu}`,
        `Direct:        ${st.includerDirect}`,
        `Stale:         ${st.includerStale}`,
        `Preamble lines:${st.preambleLines}`,
        `Dropped diags: ${st.droppedDiags.length}`,
        '---',
        'Preamble text:',
        st.preambleText,
    ];
    showInOutput('Preamble State', lines.join('\n'));
}

function cmdDumpDroppedDiagnostics(): void {
    const doc = activeHeaderDoc();
    if (!doc) return;
    const st = store.get(doc.uri.toString());
    if (!st) {
        showInOutput('Suppressed Preamble Diagnostics', 'No state for current file');
        return;
    }
    const lines = [`Suppressed (preamble-range) diagnostics: ${st.droppedDiags.length}`];
    for (let i = 0; i < st.droppedDiags.length; i++) {
        const d = st.droppedDiags[i];
        const r = d.range;
        lines.push(
            `  [${i + 1}] sev=${d.severity} line=${r.start.line}:${r.start.character} ` +
            `→ ${r.end.line}:${r.end.character}  ${d.message}`,
        );
    }
    showInOutput('Suppressed Preamble Diagnostics', lines.join('\n'));
}

async function cmdScanProject(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        vscode.window.showWarningMessage('clangd-preamble: no workspace folder open');
        return;
    }
    let total = 0;
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'clangd-preamble: scanning…', cancellable: false },
        async (prog) => {
            for (const f of folders) {
                prog.report({ message: f.uri.fsPath });
                total += await new Promise<number>((resolve) =>
                    setImmediate(() => resolve(graph.scanProject(f.uri.fsPath))),
                );
            }
        },
    );
    const resolved = resolvePendingNow(installCtx);
    const tail = resolved > 0 ? ` · resolved ${resolved} pending header(s)` : '';
    vscode.window.showInformationMessage(
        `clangd-preamble: observed ${total} TU(s) across ${folders.length} workspace folder(s)${tail}`,
    );
}

function cmdReattach(ext: vscode.Extension<ClangdExtension>): void {
    attachedClient = undefined;
    attach(ext);
    vscode.window.showInformationMessage(
        attachedClient
            ? 'clangd-preamble middleware reattached.'
            : 'clangd language client is not running.',
    );
}

function showInOutput(title: string, text: string): void {
    if (!logChannel) logChannel = vscode.window.createOutputChannel('clangd Preamble');
    logChannel.appendLine(`\n=== ${title} (${new Date().toISOString()}) ===`);
    logChannel.appendLine(text);
    logChannel.show(true);
}

// ============================================================================
// Activation
// ============================================================================
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    applyConfigToGraph();

    const ext = await getExtension();
    if (!ext) return;

    attach(ext);

    context.subscriptions.push(
        new PreambleStatus(),
        stateChangeEmitter,
        { dispose: () => stateSub?.dispose() },
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(CFG_NS)) applyConfigToGraph();
        }),
        vscode.commands.registerCommand('clangd-preamble.reattach', () => cmdReattach(ext)),
        vscode.commands.registerCommand('clangd-preamble.refresh', cmdRefresh),
        vscode.commands.registerCommand('clangd-preamble.disableBuf', cmdDisableBuf),
        vscode.commands.registerCommand('clangd-preamble.enableBuf', cmdEnableBuf),
        vscode.commands.registerCommand('clangd-preamble.dumpGraph', cmdDumpGraph),
        vscode.commands.registerCommand('clangd-preamble.dumpState', cmdDumpState),
        vscode.commands.registerCommand('clangd-preamble.dumpDroppedDiagnostics', cmdDumpDroppedDiagnostics),
        vscode.commands.registerCommand('clangd-preamble.scanProject', cmdScanProject),
    );
}

export function deactivate(): void {
    stateSub?.dispose();
    logChannel?.dispose();
}
