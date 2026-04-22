import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SonarQubeApi, SonarConfig, SonarIssue } from '../api/sonarqubeApi';
import { AiFixProvider } from '../ai/aiFixProvider';
import {
    resolveFilePath,
    readFileContent,
    extractCodeSnippet,
    applyLineFix,
    writeFile,
    openDiffView,
    getWorkspaceRoot,
    readSonarProperties
} from '../utils/fileUtils';
import { commitFix, isGitRepo } from '../utils/gitUtils';

interface SaveConfigPayload extends SonarConfig { aiApiKey: string; }

export class SonarQubeWebviewProvider {
    private panel: vscode.WebviewPanel | undefined;
    private context: vscode.ExtensionContext;
    private sonarApi: SonarQubeApi | undefined;
    private aiProvider: AiFixProvider | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async openPanel() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'sonarqubeAiFixer',
            'SonarQube AI Fixer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'webview')
                ]
            }
        );

        this.panel.webview.html = this.getWebviewContent();
        this.panel.onDidDispose(() => { this.panel = undefined; }, null, this.context.subscriptions);
        this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this), null, this.context.subscriptions);

        // Load stored secrets
        const storedToken  = await this.context.secrets.get('sonarToken')  || '';
        const storedAiKey  = await this.context.secrets.get('openaiApiKey') || '';

        const workspaceRoot = getWorkspaceRoot();
        const propsConfig   = workspaceRoot ? readSonarProperties(workspaceRoot) : null;
        const validProps    = !!(propsConfig?.uri && propsConfig?.projectKey);

        if (validProps) {
            this.post({ type: 'loadConfig', data: { ...propsConfig, token: storedToken, aiApiKey: storedAiKey, fromFile: true } });
        } else {
            const savedConfig = this.context.globalState.get<Omit<SonarConfig, 'token'>>('sonarConfigMeta');
            if (savedConfig) {
                this.post({ type: 'loadConfig', data: { ...savedConfig, token: storedToken, aiApiKey: storedAiKey } });
            }
            this.post({ type: 'noPropertiesFile' });
        }

        // Auto-initialise whenever sonar credentials are present (AI key is optional)
        if (validProps && storedToken) {
            this.sonarApi  = new SonarQubeApi({ uri: propsConfig!.uri!.replace(/\/$/, ''), projectKey: propsConfig!.projectKey!, token: storedToken });
            this.aiProvider = storedAiKey ? new AiFixProvider(storedAiKey) : undefined;
        }
    }

    // ---------------------------------------------------------------------------
    // Message routing
    // ---------------------------------------------------------------------------

    private async handleMessage(message: { type: string; [key: string]: any }) {
        switch (message.type) {
            case 'saveConfig':     return this.handleSaveConfig(message.data as SaveConfigPayload);
            case 'testConnection': return this.handleTestConnection();
            case 'fetchPRs':       return this.handleFetchPRs();
            case 'fetchIssues':    return this.handleFetchIssues(message.prKey, message.page ?? 1);
            case 'fixIssue':       return this.handleFixIssue(message.issue as SonarIssue);
            case 'fixSelected':    return this.handleFixSelected(message.issues as SonarIssue[]);
            case 'fixAllLow':      return this.handleFixAllLow(message.prKey);
            case 'markResolved':   return this.handleMarkResolved(message.issueKey);
            case 'export':         return this.handleExport(message.format, message.content, message.filename);
        }
    }

    // ---------------------------------------------------------------------------
    // Handlers
    // ---------------------------------------------------------------------------

    private async handleSaveConfig(cfg: SaveConfigPayload) {
        const sonarConfig: SonarConfig = {
            uri: cfg.uri.replace(/\/$/, ''),
            projectKey: cfg.projectKey,
            token: cfg.token
        };

        this.sonarApi  = new SonarQubeApi(sonarConfig);
        this.aiProvider = cfg.aiApiKey ? new AiFixProvider(cfg.aiApiKey) : undefined;

        await this.context.secrets.store('sonarToken', cfg.token);
        if (cfg.aiApiKey) {
            await this.context.secrets.store('openaiApiKey', cfg.aiApiKey);
        }
        await this.context.globalState.update('sonarConfigMeta', {
            uri: sonarConfig.uri,
            projectKey: sonarConfig.projectKey
        });

        this.post({ type: 'configSaved' });
        this.toast('Configuration saved!', 'success');
    }

    private async handleTestConnection() {
        if (!this.sonarApi) {
            return this.toast('Save configuration first', 'error');
        }
        this.post({ type: 'loading', key: 'test', value: true });
        try {
            const ok = await this.sonarApi.ping();
            this.toast(ok ? 'Connection successful!' : 'Connected (ping not supported — try fetching PRs)', 'success');
        } catch (err: any) {
            this.toast(`Connection failed: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'test', value: false });
        }
    }

    private async handleFetchPRs() {
        if (!this.sonarApi) {
            return this.toast('Save configuration first', 'error');
        }
        this.post({ type: 'loading', key: 'prs', value: true });
        try {
            const prs = await this.sonarApi.getPullRequests();
            this.post({ type: 'prsLoaded', data: prs });
        } catch (err: any) {
            this.toast(`Failed to fetch PRs: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'prs', value: false });
        }
    }

    private async handleFetchIssues(prKey: string, page: number) {
        if (!this.sonarApi) {
            return this.toast('Save configuration first', 'error');
        }
        this.post({ type: 'loading', key: 'issues', value: true });
        try {
            const result = await this.sonarApi.getIssues(prKey, page);
            this.post({ type: 'issuesLoaded', data: result });
        } catch (err: any) {
            this.toast(`Failed to fetch issues: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'issues', value: false });
        }
    }

    private async handleFixIssue(issue: SonarIssue) {
        if (!this.aiProvider) {
            return this.toast('No OpenAI API key configured — add it in the Config tab', 'error');
        }

        this.post({ type: 'fixStarted', issueKey: issue.key });

        try {
            // 1. Resolve file
            const filePath = resolveFilePath(issue.component);
            if (!filePath) {
                throw new Error(`Could not find file for component: ${issue.component}`);
            }

            // 2. Read & extract snippet
            const originalContent = readFileContent(filePath);
            const startLine = issue.textRange?.startLine ?? issue.line ?? 1;
            const endLine   = issue.textRange?.endLine   ?? issue.line ?? startLine;

            const { snippet, actualStart, actualEnd } = extractCodeSnippet(
                originalContent, startLine, endLine
            );

            this.toast('Generating AI fix…', 'info');

            // 3. Ask AI
            const { fixedCode } = await this.aiProvider.fixIssue(
                issue, snippet, originalContent, actualStart, actualEnd
            );

            // 4. Build new file content — use actualStart/actualEnd because the AI
            //    received and returned the expanded context snippet, not just startLine–endLine
            const newContent = applyLineFix(originalContent, fixedCode, actualStart, actualEnd);

            // 5. Write to disk so diff view shows the real file
            await writeFile(filePath, newContent);

            // 6. Open diff view (keeps original virtual doc alive)
            const diffProvider = await openDiffView(filePath, originalContent, issue.message);

            // 7. Ask user
            const choice = await vscode.window.showInformationMessage(
                `AI fix ready for: ${issue.message.substring(0, 70)}`,
                { modal: false },
                'Accept',
                'Accept & Commit',
                'Reject'
            );

            diffProvider.dispose();

            if (choice === 'Reject' || choice === undefined) {
                await writeFile(filePath, originalContent);
                this.toast('Fix rejected — original file restored', 'warning');
                this.post({ type: 'fixRejected', issueKey: issue.key });
                return;
            }

            this.post({ type: 'fixApplied', issueKey: issue.key });

            if (choice === 'Accept & Commit') {
                const root = getWorkspaceRoot();
                if (root && await isGitRepo(root)) {
                    const result = await commitFix(filePath, issue.key, root);
                    this.toast(result.message, result.success ? 'success' : 'error');
                } else {
                    this.toast('Not a git repo — fix saved but not committed', 'warning');
                }
            } else {
                this.toast('Fix applied and saved!', 'success');
            }

        } catch (err: any) {
            this.post({ type: 'fixError', issueKey: issue.key, message: err.message });
            this.toast(`Fix failed: ${err.message}`, 'error');
        }
    }

    private async handleFixAllLow(prKey: string) {
        if (!this.sonarApi || !this.aiProvider) {
            return this.toast('Configure SonarQube and AI key first', 'error');
        }

        this.toast('Collecting low-severity issues…', 'info');

        try {
            const lowIssues: SonarIssue[] = [];
            let page = 1;

            while (true) {
                const result = await this.sonarApi.getIssues(prKey, page);
                const batch = result.issues.filter(i => i.severity === 'INFO' || i.severity === 'MINOR');
                lowIssues.push(...batch);
                if (page * result.ps >= result.total) { break; }
                page++;
            }

            if (lowIssues.length === 0) {
                return this.toast('No INFO/MINOR issues found', 'info');
            }

            const confirm = await vscode.window.showInformationMessage(
                `Fix all ${lowIssues.length} low-severity issues with AI?`,
                'Yes, fix all',
                'Cancel'
            );
            if (confirm !== 'Yes, fix all') { return; }

            this.toast(`Fixing ${lowIssues.length} issues…`, 'info');
            let fixed = 0;
            for (const issue of lowIssues) {
                try {
                    await this.handleFixIssue(issue);
                    fixed++;
                } catch {
                    // Continue with remaining issues
                }
            }
            this.toast(`Done — fixed ${fixed}/${lowIssues.length} issues`, 'success');

        } catch (err: any) {
            this.toast(`Fix All failed: ${err.message}`, 'error');
        }
    }

    private async handleMarkResolved(issueKey: string) {
        if (!this.sonarApi) {
            return this.toast('SonarQube not configured', 'error');
        }
        try {
            await this.sonarApi.markIssueResolved(issueKey);
            this.post({ type: 'issueResolved', issueKey });
            this.toast('Marked as resolved in SonarQube', 'success');
        } catch (err: any) {
            const is403 = err.response?.status === 403 || err.message?.includes('403');
            this.toast(
                is403
                    ? 'Permission denied — your token needs "Administer Issues" permission in SonarQube'
                    : `Could not mark resolved: ${err.message}`,
                'error'
            );
        }
    }

    private async handleFixSelected(issues: SonarIssue[]) {
        if (!this.aiProvider) {
            return this.toast('No OpenAI API key configured — add it in the Config tab', 'error');
        }
        const confirm = await vscode.window.showInformationMessage(
            `Fix ${issues.length} selected issue${issues.length > 1 ? 's' : ''} with AI?`,
            'Yes, fix all', 'Cancel'
        );
        if (confirm !== 'Yes, fix all') { return; }

        let fixed = 0;
        for (const issue of issues) {
            try { await this.handleFixIssue(issue); fixed++; } catch { /* continue */ }
        }
        this.toast(`Done — fixed ${fixed}/${issues.length} issues`, 'success');
    }

    private async handleExport(format: string, content: string, filename: string) {
        const root = getWorkspaceRoot();
        const defaultUri = vscode.Uri.joinPath(
            vscode.Uri.file(root || ''),
            filename
        );
        let filters: Record<string, string[]>;
        if (format === 'json')     { filters = { 'JSON Files': ['json'] }; }
        else if (format === 'csv') { filters = { 'CSV Files':  ['csv']  }; }
        else                       { filters = { 'Text Files': ['txt']  }; }

        const uri = await vscode.window.showSaveDialog({ defaultUri, filters });
        if (!uri) { return; }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        this.toast(`Exported to ${path.basename(uri.fsPath)}`, 'success');
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private post(message: Record<string, unknown>) {
        this.panel?.webview.postMessage(message);
    }

    private toast(message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info') {
        this.post({ type: 'toast', message, variant });
    }

    private getWebviewContent(): string {
        const base = path.join(this.context.extensionPath, 'webview');
        let html    = fs.readFileSync(path.join(base, 'index.html'), 'utf-8');
        const css   = fs.readFileSync(path.join(base, 'styles.css'), 'utf-8');
        const js    = fs.readFileSync(path.join(base, 'script.js'), 'utf-8');

        html = html
            .replace('{{STYLES}}', `<style>\n${css}\n</style>`)
            .replace('{{SCRIPT}}', `<script>\n${js}\n</script>`);

        return html;
    }
}
