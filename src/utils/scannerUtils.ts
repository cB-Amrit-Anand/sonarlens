import { exec } from 'child_process';
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
    ceTaskUrl?: string;
    dashboardUrl?: string;
    taskId?: string;
}

export async function runSonarScanner(
    workspaceRoot: string,
    branchName: string,
    onProgress: (line: string) => void
): Promise<ScannerResult> {
    // Remove stale report-task.txt so we always read a fresh one
    const reportTaskPath = path.join(workspaceRoot, '.scannerwork', 'report-task.txt');
    if (fs.existsSync(reportTaskPath)) {
        fs.unlinkSync(reportTaskPath);
    }

    return new Promise((resolve) => {
        const cmd = `sonar-scanner -Dsonar.branch.name="${branchName}"`;
        const outputLines: string[] = [];

        const child = exec(cmd, { cwd: workspaceRoot });

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
            const output = outputLines.join('\n');
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
    maxWaitMs = 300000
): Promise<{ status: string; analysisId?: string }> {
    const headers: Record<string, string> = {};
    const auth = tokenType === 'bearer'
        ? undefined
        : { username: token, password: '' };
    if (tokenType === 'bearer') {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const res = await axios.get(ceTaskUrl, { headers, auth, timeout: 15000 });
            const task = res.data?.task;
            const status: string = task?.status ?? 'UNKNOWN';
            onProgress(status);
            if (status === 'SUCCESS') {
                return { status, analysisId: task?.analysisId };
            }
            if (status === 'FAILED' || status === 'CANCELLED') {
                return { status };
            }
        } catch {
            // retry on transient errors
        }
    }
    return { status: 'TIMEOUT' };
}
