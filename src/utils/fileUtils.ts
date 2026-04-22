import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Resolve a SonarQube component key (e.g. "my-project:src/app/foo.ts") to an
 * absolute path inside the current workspace.
 */
export function resolveFilePath(component: string): string | undefined {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return undefined; }

    // Strip the projectKey prefix: "projectKey:relative/path"
    const relativePath = component.includes(':')
        ? component.split(':').slice(1).join(':')
        : component;

    const candidate = path.join(workspaceRoot, relativePath);
    if (fs.existsSync(candidate)) {
        return candidate;
    }

    // Fallback: search for the filename in workspace
    const filename = path.basename(relativePath);
    return findFileInWorkspace(workspaceRoot, filename);
}

function findFileInWorkspace(dir: string, filename: string, depth = 0): string | undefined {
    if (depth > 6) { return undefined; }
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') { continue; }
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === filename) { return fullPath; }
            if (entry.isDirectory()) {
                const found = findFileInWorkspace(fullPath, filename, depth + 1);
                if (found) { return found; }
            }
        }
    } catch { /* ignore permission errors */ }
    return undefined;
}

export function readFileContent(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Extract a code snippet around the issue lines, with surrounding context.
 * Returns the snippet and the actual start/end lines used.
 */
export function extractCodeSnippet(
    content: string,
    startLine: number,
    endLine: number,
    contextLines = 3
): { snippet: string; actualStart: number; actualEnd: number } {
    const lines = content.split('\n');
    const actualStart = Math.max(1, startLine - contextLines);
    const actualEnd = Math.min(lines.length, endLine + contextLines);
    const snippet = lines.slice(actualStart - 1, actualEnd).join('\n');
    return { snippet, actualStart, actualEnd };
}

/**
 * Replace lines [startLine, endLine] (1-indexed, inclusive) in originalContent
 * with the provided fixedSnippet and return the resulting file content.
 */
export function applyLineFix(
    originalContent: string,
    fixedSnippet: string,
    startLine: number,
    endLine: number
): string {
    const lines = originalContent.split('\n');
    const fixedLines = fixedSnippet.split('\n');
    return [
        ...lines.slice(0, startLine - 1),
        ...fixedLines,
        ...lines.slice(endLine)
    ].join('\n');
}

export async function writeFile(filePath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

/**
 * Write the new content to disk, open a VS Code diff view, then return a
 * disposable that cleans up the virtual-document provider.
 */
export function readSonarProperties(workspaceRoot: string): { uri?: string; projectKey?: string } | null {
    const propsPath = path.join(workspaceRoot, 'sonar-project.properties');
    if (!fs.existsSync(propsPath)) {
        return null;
    }
    const result: { uri?: string; projectKey?: string } = {};
    for (const line of fs.readFileSync(propsPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        const eq = trimmed.indexOf('=');
        if (eq === -1) { continue; }
        const key = trimmed.substring(0, eq).trim();
        const val = trimmed.substring(eq + 1).trim();
        if (key === 'sonar.sonarQubeUri') { result.uri = val; }
        if (key === 'sonar.projectKey')   { result.projectKey = val; }
    }
    return result;
}

export async function openDiffView(
    filePath: string,
    originalContent: string,
    issueMessage: string
): Promise<vscode.Disposable> {
    const scheme = `sonarfix-orig-${Date.now()}`;
    const fileName = path.basename(filePath);

    const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent: () => originalContent
    });

    const originalUri = vscode.Uri.parse(`${scheme}:${fileName}`);
    const modifiedUri = vscode.Uri.file(filePath);
    const title = `AI Fix ← ${issueMessage.substring(0, 55)}`;

    await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);

    return provider;
}
