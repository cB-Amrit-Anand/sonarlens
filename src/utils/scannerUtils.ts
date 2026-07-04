import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

const SCANNER_NOT_FOUND_MSG = `sonar-scanner not found on PATH. Install it first:

macOS (Homebrew):
  brew install sonar-scanner

Ubuntu / Debian:
  wget https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-6.2.1.4610-linux-x64.zip
  unzip sonar-scanner-cli-*.zip
  sudo mv sonar-scanner-* /opt/sonar-scanner
  echo 'export PATH=/opt/sonar-scanner/bin:$PATH' >> ~/.bashrc && source ~/.bashrc

Windows (manual):
  1. Download ZIP from https://docs.sonarsource.com/sonarqube/latest/analyzing-source-code/scanners/sonarscanner/
  2. Extract to C:\\sonar-scanner
  3. Add C:\\sonar-scanner\\bin to System PATH

After installing, reload VS Code and try again.`;

function getFriendlyError(output: string): string | null {
    if (output.includes('sonar.organization')) {
        return `Missing sonar.organization in sonar-project.properties.

This project uses SonarCloud which requires an organization key.

Add this to your sonar-project.properties:
  sonar.organization=your-org-key

Find your org key at: https://sonarcloud.io/account/organizations`;
    }
    if (output.includes('sonar.projectKey') && output.includes('mandatory')) {
        return `Missing sonar.projectKey in sonar-project.properties.

Add this to your sonar-project.properties:
  sonar.projectKey=your-project-key`;
    }
    if (output.includes('sonar.host.url') || output.includes('sonar.sonarQubeUri')) {
        return `Missing sonar.host.url in sonar-project.properties.

Add this to your sonar-project.properties:
  sonar.host.url=https://sonarcloud.io    (for SonarCloud)
  sonar.host.url=https://your-server.com  (for SonarQube)`;
    }
    if (output.includes('401') || output.includes('Not authorized') || output.includes('Unauthorized')) {
        return `Authentication failed — token rejected by SonarQube/SonarCloud.

Check:
  1. Token is valid and not expired
  2. Token has "Execute Analysis" permission
  3. sonar.login or sonar.token is set in sonar-project.properties (or SONAR_TOKEN env var)`;
    }
    if (output.includes('EXECUTION FAILURE')) {
        // Extract just the ERROR lines for a compact message
        const errorLines = output.split('\n')
            .filter(l => l.includes('ERROR') || l.includes('EXECUTION FAILURE'))
            .map(l => l.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+/, '').trim())
            .filter(Boolean)
            .join('\n');
        return errorLines || null;
    }
    return null;
}

export interface ScannerResult {
    success: boolean;
    output: string;
    cancelled?: boolean;
    ceTaskUrl?: string;
    dashboardUrl?: string;
    taskId?: string;
}

let currentScan: { child: ChildProcess; cancelled: boolean } | null = null;

export function stopSonarScanner(): boolean {
    if (!currentScan || !currentScan.child.pid) { return false; }
    currentScan.cancelled = true;
    const pid = currentScan.child.pid;
    if (process.platform === 'win32') {
        exec(`taskkill /pid ${pid} /T /F`);
    } else {
        // Scanner is a shell script that spawns a Java process — kill the
        // whole process group so the JVM dies too.
        try { process.kill(-pid, 'SIGTERM'); } catch { currentScan.child.kill('SIGTERM'); }
    }
    return true;
}

export interface ScannerOptions {
    hostUrl?: string;
    token?: string;
    /** Omit for servers without branch analysis (e.g. local Community container) */
    branchName?: string;
    /** Override sonar.projectKey from sonar-project.properties */
    projectKey?: string;
    /** Restrict analysis to these paths (sonar.inclusions) */
    inclusions?: string[];
}

// Directories that should never be scanned — dependency trees and build
// output. Crawling node_modules (especially pnpm symlink layouts) can hang
// the scanner's file indexer indefinitely.
const DEFAULT_EXCLUSIONS = [
    '**/node_modules/**',
    '**/build/**',
    '**/dist/**',
    '**/out/**',
    '**/coverage/**',
    '**/.next/**',
    '**/vendor/**'
].join(',');

/**
 * Everything git ignores should not be scanned. Collapsed directory entries
 * (e.g. "node_modules/") become globs; plain files pass through as-is.
 */
async function gitIgnoredGlobs(workspaceRoot: string): Promise<string[]> {
    try {
        const { stdout } = await execAsync(
            'git ls-files --others --ignored --exclude-standard --directory',
            { cwd: workspaceRoot, maxBuffer: 20 * 1024 * 1024 }
        );
        return stdout.split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .slice(0, 200)
            .map(p => (p.endsWith('/') ? `${p}**` : p));
    } catch {
        return [];
    }
}

/**
 * Restrict sonar.sources to git-tracked (+ new untracked, not ignored)
 * top-level entries. Critical for performance: the scanner's file walker
 * stats EVERY file under sonar.sources before exclusions apply, so letting
 * it default to the project root means it crawls all of node_modules.
 */
async function gitTopLevelSources(workspaceRoot: string): Promise<string[]> {
    try {
        const { stdout: tracked } = await execAsync('git ls-tree --name-only HEAD', {
            cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024
        });
        const entries = new Set(tracked.split('\n').map(l => l.trim()).filter(Boolean));
        try {
            const { stdout: untracked } = await execAsync('git ls-files --others --exclude-standard', {
                cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024
            });
            untracked.split('\n').map(l => l.trim()).filter(Boolean)
                .forEach(f => entries.add(f.split('/')[0]));
        } catch { /* tracked entries alone are fine */ }
        return [...entries].filter(e =>
            e !== '.scannerwork' && !e.includes(',') && fs.existsSync(path.join(workspaceRoot, e))
        );
    } catch {
        return [];
    }
}

function propertiesFileDefines(workspaceRoot: string, propertyKey: string): boolean {
    const propsPath = path.join(workspaceRoot, 'sonar-project.properties');
    if (!fs.existsSync(propsPath)) { return false; }
    return fs.readFileSync(propsPath, 'utf-8').split('\n').some(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('#') && trimmed.startsWith(`${propertyKey}=`);
    });
}

export async function runSonarScanner(
    workspaceRoot: string,
    options: ScannerOptions,
    onProgress: (line: string) => void
): Promise<ScannerResult> {
    // Remove stale report-task.txt so we always read a fresh one
    const reportTaskPath = path.join(workspaceRoot, '.scannerwork', 'report-task.txt');
    if (fs.existsSync(reportTaskPath)) {
        fs.unlinkSync(reportTaskPath);
    }
    // A killed/crashed scan can leave a half-extracted analyzer bundle behind
    // (e.g. the JS/TS bridge), which breaks every following run — clear it.
    const sonarTmp = path.join(workspaceRoot, '.scannerwork', '.sonartmp');
    if (fs.existsSync(sonarTmp)) {
        try { fs.rmSync(sonarTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // Scan only the actual codebase: .git, defaults, and everything the
    // project's .gitignore ignores. An explicit sonar.exclusions in
    // sonar-project.properties wins instead.
    let exclusions: string | null = null;
    if (!propertiesFileDefines(workspaceRoot, 'sonar.exclusions')) {
        const ignored = await gitIgnoredGlobs(workspaceRoot);
        exclusions = [...new Set(['**/.git/**', ...DEFAULT_EXCLUSIONS.split(','), ...ignored])].join(',');
    }

    // Keep the file walker away from node_modules & co entirely
    let sources: string | null = null;
    if (!propertiesFileDefines(workspaceRoot, 'sonar.sources')) {
        const topLevel = await gitTopLevelSources(workspaceRoot);
        if (topLevel.length > 0) { sources = topLevel.join(','); }
    }

    return new Promise((resolve) => {
        let cmd = 'sonar-scanner';
        if (options.branchName) {
            cmd += ` -Dsonar.branch.name="${options.branchName}"`;
        }
        if (options.projectKey) {
            cmd += ` -Dsonar.projectKey="${options.projectKey}"`;
        }
        if (options.hostUrl) {
            cmd += ` -Dsonar.host.url="${options.hostUrl.replace(/\/+$/, '')}"`;
        }
        if (options.inclusions && options.inclusions.length > 0) {
            cmd += ` -Dsonar.inclusions="${options.inclusions.join(',')}"`;
        }
        if (sources) {
            cmd += ` -Dsonar.sources="${sources}"`;
        }
        if (exclusions) {
            cmd += ` -Dsonar.exclusions="${exclusions}"`;
        }
        // SCA dependency analysis crawls node_modules/lockfiles and is known
        // to stall JS repos at "Preprocessed 0 files" — disable for IDE scans.
        // (Both property spellings passed; the server ignores the unknown one.)
        cmd += ' -Dsonar.sca.enabled=false -Dsonar.sca.disabled=true';
        // The extension polls the CE task itself — never let the scanner block
        // on sonar.qualitygate.wait from sonar-project.properties (CI needs it, IDE doesn't).
        cmd += ' -Dsonar.qualitygate.wait=false';

        onProgress(`> ${cmd}`);
        const outputLines: string[] = [];

        // Token goes through the environment (SONAR_TOKEN), not the command
        // line, so it never shows up in the process list or the scan log.
        const env = { ...process.env };
        if (options.token) {
            env.SONAR_TOKEN = options.token;
        }

        // detached puts the scanner in its own process group so Stop can
        // kill the shell script and its JVM child together.
        const child = spawn(cmd, {
            cwd: workspaceRoot,
            env,
            shell: true,
            detached: process.platform !== 'win32'
        });
        currentScan = { child, cancelled: false };

        child.stdout?.on('data', (data: string) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    outputLines.push(line);
                    onProgress(line);
                }
            }
        });

        child.stderr?.on('data', (data: string) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    outputLines.push(line);
                    onProgress(line);
                }
            }
        });

        child.on('close', (code) => {
            const wasCancelled = currentScan?.cancelled === true;
            currentScan = null;
            const output = outputLines.join('\n');
            if (wasCancelled) {
                resolve({ success: false, cancelled: true, output: 'Scan stopped by user' });
                return;
            }
            if (code !== 0) {
                const notFound = output.includes('command not found') || output.includes('not found');
                if (notFound) { resolve({ success: false, output: SCANNER_NOT_FOUND_MSG }); return; }
                const friendly = getFriendlyError(output);
                resolve({ success: false, output: friendly || output });
                return;
            }

            const report = parseReportTask(reportTaskPath);
            resolve({
                success: true,
                output,
                ceTaskUrl: report.ceTaskUrl,
                dashboardUrl: report.dashboardUrl,
                taskId: report.taskId
            });
        });

        child.on('error', (err) => {
            currentScan = null;
            const msg = err.message || '';
            if (msg.includes('command not found') || msg.includes('ENOENT') || msg.includes('not found')) {
                resolve({ success: false, output: SCANNER_NOT_FOUND_MSG });
            } else {
                resolve({ success: false, output: msg });
            }
        });
    });
}

interface ReportTask {
    ceTaskUrl?: string;
    dashboardUrl?: string;
    taskId?: string;
}

function parseReportTask(reportTaskPath: string): ReportTask {
    if (!fs.existsSync(reportTaskPath)) {
        return {};
    }
    const result: ReportTask = {};
    for (const line of fs.readFileSync(reportTaskPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        const eq = trimmed.indexOf('=');
        if (eq === -1) { continue; }
        const key = trimmed.substring(0, eq).trim();
        const val = trimmed.substring(eq + 1).trim();
        if (key === 'ceTaskUrl')    { result.ceTaskUrl    = val; }
        if (key === 'dashboardUrl') { result.dashboardUrl = val; }
        if (key === 'ceTaskId')     { result.taskId       = val; }
    }
    return result;
}

export async function pollCeTask(
    ceTaskUrl: string,
    token: string,
    tokenType: 'basic' | 'bearer',
    onProgress: (status: string) => void,
    shouldCancel?: () => boolean,
    maxWaitMs = 900000
): Promise<{ status: string; analysisId?: string; errorMessage?: string }> {
    const headers: Record<string, string> = {};
    const auth = tokenType === 'bearer'
        ? undefined
        : { username: token, password: '' };
    if (tokenType === 'bearer') {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const start = Date.now();
    let lastStatus = '';
    while (Date.now() - start < maxWaitMs) {
        await new Promise(r => setTimeout(r, 5000));
        if (shouldCancel?.()) { return { status: 'CANCELLED' }; }
        try {
            const res = await axios.get(ceTaskUrl, { headers, auth, timeout: 15000 });
            const task = res.data?.task;
            const status: string = task?.status ?? 'UNKNOWN';
            // The elapsed-time nudge only matters once minutes have passed —
            // otherwise just report on status change, to avoid a wall of
            // identical "IN_PROGRESS" lines for a fast analysis.
            const elapsedS = Math.round((Date.now() - start) / 1000);
            if (status !== lastStatus || elapsedS % 30 === 0) {
                onProgress(elapsedS >= 60 ? `${status} (${Math.round(elapsedS / 60)}m elapsed)` : status);
                lastStatus = status;
            }
            if (status === 'SUCCESS') {
                return { status, analysisId: task?.analysisId };
            }
            if (status === 'FAILED' || status === 'CANCELLED') {
                return { status, errorMessage: task?.errorMessage };
            }
        } catch {
            // retry on transient errors
        }
    }
    return { status: 'TIMEOUT' };
}
