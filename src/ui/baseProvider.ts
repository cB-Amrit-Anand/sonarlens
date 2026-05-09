import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import { SonarQubeApi, SonarConfig, SonarIssue } from '../api/sonarqubeApi';
import { AiFixProvider } from '../ai/aiFixProvider';
import {
    resolveFilePath, readFileContent, extractCodeSnippet,
    applyLineFix, writeFile, openDiffView, getWorkspaceRoot, readSonarProperties
} from '../utils/fileUtils';
import { commitFix, isGitRepo } from '../utils/gitUtils';

interface SaveConfigPayload extends SonarConfig { aiApiKey: string; tokenType: 'basic' | 'bearer'; }

export abstract class SonarQubeBaseProvider {
    protected sonarApi?: SonarQubeApi;
    protected aiProvider?: AiFixProvider;

    constructor(protected readonly context: vscode.ExtensionContext) {}

    protected abstract post(message: Record<string, unknown>): void;

    protected toast(message: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info') {
        this.post({ type: 'toast', message, variant });
    }

    protected async initConfig(): Promise<void> {
        const storedToken = await this.context.secrets.get('sonarToken') || '';
        const storedAiKey = await this.context.secrets.get('openaiApiKey') || '';
        const workspaceRoot = getWorkspaceRoot();
        const propsConfig = workspaceRoot ? readSonarProperties(workspaceRoot) : null;
        const validProps = !!(propsConfig?.uri && propsConfig?.projectKey);

        const storedTokenType = this.context.globalState.get<'basic' | 'bearer'>('sonarTokenType') || 'basic';

        if (validProps) {
            this.post({ type: 'loadConfig', data: { ...propsConfig, token: storedToken, aiApiKey: storedAiKey, tokenType: storedTokenType, fromFile: true } });
        } else {
            const savedConfig = this.context.globalState.get<Omit<SonarConfig, 'token'>>('sonarConfigMeta');
            if (savedConfig) {
                this.post({ type: 'loadConfig', data: { ...savedConfig, token: storedToken, aiApiKey: storedAiKey, tokenType: storedTokenType } });
            }
            this.post({ type: 'noPropertiesFile' });
        }

        if (validProps && storedToken) {
            this.sonarApi = new SonarQubeApi({
                uri: propsConfig!.uri!.replace(/\/$/, ''),
                projectKey: propsConfig!.projectKey!,
                token: storedToken,
                tokenType: storedTokenType
            });
            this.aiProvider = storedAiKey ? new AiFixProvider(storedAiKey) : undefined;
        }

        this.post({ type: 'configStatus', configured: !!(validProps && storedToken) });
    }

    protected async handleMessage(message: { type: string; [key: string]: any }): Promise<void> {
        switch (message.type) {
            case 'saveConfig':     return this.handleSaveConfig(message.data as SaveConfigPayload);
            case 'testConnection': return this.handleTestConnection();
            case 'fetchPRs':       return this.handleFetchPRs();
            case 'fetchIssues':    return this.handleFetchIssues(message.prKey, message.page ?? 1, message.pageSize ?? 50);
            case 'fixIssue':       return this.handleFixIssue(message.issue as SonarIssue);
            case 'fixSelected':    return this.handleFixSelected(message.issues as SonarIssue[]);
            case 'fixAllLow':      return this.handleFixAllLow(message.prKey);
            case 'markResolved':   return this.handleMarkResolved(message.issueKey);
            case 'ssoLogin':       return this.handleSsoLogin(message.sonarUri);
            case 'export':         return this.handleExport(message.format, message.content, message.filename);
            case 'openInPanel':    return this.handleOpenInPanel();
            case 'openUrl':        return this.handleOpenUrl(message.url);
        }
    }

    protected handleOpenInPanel(): void {
        vscode.commands.executeCommand('sonarqube-ai-fixer.openPanel');
    }

    protected handleOpenUrl(url: string): void {
        if (url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
    }

    protected async handleSaveConfig(cfg: SaveConfigPayload): Promise<void> {
        const sonarConfig: SonarConfig = {
            uri: cfg.uri.replace(/\/$/, ''),
            projectKey: cfg.projectKey,
            token: cfg.token,
            tokenType: cfg.tokenType || 'basic'
        };

        this.sonarApi = new SonarQubeApi(sonarConfig);
        this.aiProvider = cfg.aiApiKey ? new AiFixProvider(cfg.aiApiKey) : undefined;

        await this.context.secrets.store('sonarToken', cfg.token);
        if (cfg.aiApiKey) {
            await this.context.secrets.store('openaiApiKey', cfg.aiApiKey);
        }
        await this.context.globalState.update('sonarConfigMeta', {
            uri: sonarConfig.uri,
            projectKey: sonarConfig.projectKey
        });
        await this.context.globalState.update('sonarTokenType', sonarConfig.tokenType);

        this.post({ type: 'configSaved' });
        this.toast('Configuration saved!', 'success');
    }

    protected async handleTestConnection(): Promise<void> {
        if (!this.sonarApi) { return this.toast('Save configuration first', 'error'); }
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

    protected async handleFetchPRs(): Promise<void> {
        if (!this.sonarApi) { return this.toast('Save configuration first', 'error'); }
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

    protected async handleFetchIssues(prKey: string, page: number, pageSize = 50): Promise<void> {
        if (!this.sonarApi) { return this.toast('Save configuration first', 'error'); }
        this.post({ type: 'loading', key: 'issues', value: true });
        try {
            const result = await this.sonarApi.getIssues(prKey, page, pageSize);
            this.post({ type: 'issuesLoaded', data: result });
        } catch (err: any) {
            this.toast(`Failed to fetch issues: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'issues', value: false });
        }
    }

    protected async handleFixIssue(issue: SonarIssue): Promise<void> {
        if (!this.aiProvider) {
            return this.toast('No OpenAI API key configured — add it in Settings', 'error');
        }

        this.post({ type: 'fixStarted', issueKey: issue.key });

        try {
            const filePath = resolveFilePath(issue.component);
            if (!filePath) { throw new Error(`Could not find file for component: ${issue.component}`); }

            const originalContent = readFileContent(filePath);
            const startLine = issue.textRange?.startLine ?? issue.line ?? 1;
            const endLine   = issue.textRange?.endLine   ?? issue.line ?? startLine;

            const { snippet, actualStart, actualEnd } = extractCodeSnippet(originalContent, startLine, endLine);

            this.toast('Generating AI fix…', 'info');

            const { fixedCode } = await this.aiProvider.fixIssue(issue, snippet, originalContent, actualStart, actualEnd);
            const newContent = applyLineFix(originalContent, fixedCode, actualStart, actualEnd);

            await writeFile(filePath, newContent);
            const diffProvider = await openDiffView(filePath, originalContent, issue.message);

            const choice = await vscode.window.showInformationMessage(
                `AI fix ready for: ${issue.message.substring(0, 70)}`,
                { modal: false },
                'Accept', 'Accept & Commit', 'Reject'
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

    protected async handleFixAllLow(prKey: string): Promise<void> {
        if (!this.sonarApi || !this.aiProvider) {
            return this.toast('Configure SonarQube and AI key first', 'error');
        }
        this.toast('Collecting low-severity issues…', 'info');
        try {
            const lowIssues: SonarIssue[] = [];
            let page = 1;
            while (true) {
                const result = await this.sonarApi.getIssues(prKey, page);
                lowIssues.push(...result.issues.filter(i => i.severity === 'INFO' || i.severity === 'MINOR'));
                if (page * result.ps >= result.total) { break; }
                page++;
            }
            if (lowIssues.length === 0) { return this.toast('No INFO/MINOR issues found', 'info'); }

            const confirm = await vscode.window.showInformationMessage(
                `Fix all ${lowIssues.length} low-severity issues with AI?`,
                'Yes, fix all', 'Cancel'
            );
            if (confirm !== 'Yes, fix all') { return; }

            this.toast(`Fixing ${lowIssues.length} issues…`, 'info');
            let fixed = 0;
            for (const issue of lowIssues) {
                try { await this.handleFixIssue(issue); fixed++; } catch { /* continue */ }
            }
            this.toast(`Done — fixed ${fixed}/${lowIssues.length} issues`, 'success');
        } catch (err: any) {
            this.toast(`Fix All failed: ${err.message}`, 'error');
        }
    }

    protected async handleSsoLogin(sonarUri: string): Promise<void> {
        if (!sonarUri) {
            return this.toast('Enter the SonarQube URI first, then click Login with SSO', 'error');
        }
        const uri = sonarUri.replace(/\/$/, '');

        let port: number;
        try {
            port = await new Promise<number>((resolve, reject) => {
                const srv = net.createServer();
                srv.listen(0, '127.0.0.1', () => {
                    const addr = srv.address() as net.AddressInfo;
                    srv.close(() => resolve(addr.port));
                });
                srv.on('error', reject);
            });
        } catch (err: any) {
            return this.toast(`SSO: could not open a local callback port — ${err.message}`, 'error');
        }

        this.post({ type: 'ssoWaiting' });

        const server = http.createServer((req, res) => {
            const parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`);
            const token  = parsed.searchParams.get('token');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(token
                ? `<!DOCTYPE html><html><head><style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#1e1e1e;color:#ccc;font-size:15px}</style></head><body><p>&#10003;&nbsp;Token received — you can close this tab and return to VS Code.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`
                : `<!DOCTYPE html><html><body><p>No token in callback — please try again.</p></body></html>`
            );

            server.close();

            if (token) {
                void this.onSsoTokenReceived(token);
            } else {
                this.post({ type: 'ssoError' });
                this.toast('SSO completed but no token was returned — try generating a token manually', 'warning');
            }
        });

        server.on('error', (err: Error) => {
            this.post({ type: 'ssoError' });
            this.toast(`SSO callback server error: ${err.message}`, 'error');
        });

        const timeout = setTimeout(() => {
            server.close();
            this.post({ type: 'ssoTimeout' });
            this.toast('SSO login timed out — please try again', 'warning');
        }, 5 * 60 * 1000);

        server.on('close', () => clearTimeout(timeout));

        server.listen(port, '127.0.0.1', () => {
            const authUrl = `${uri}/sonarlint/auth?ideName=SonarLens&idePort=${port}`;
            void vscode.env.openExternal(vscode.Uri.parse(authUrl));
            this.toast('Browser opened — complete SSO login to auto-import your token', 'info');
        });
    }

    protected async onSsoTokenReceived(token: string): Promise<void> {
        await this.context.secrets.store('sonarToken', token);
        await this.context.globalState.update('sonarTokenType', 'basic');
        this.post({ type: 'ssoSuccess', token });
        this.toast('SSO login successful — token saved!', 'success');
    }

    protected async handleMarkResolved(issueKey: string): Promise<void> {
        if (!this.sonarApi) { return this.toast('SonarQube not configured', 'error'); }
        this.post({ type: 'resolveStarted', issueKey });
        try {
            await this.sonarApi.markIssueResolved(issueKey);
            this.post({ type: 'issueResolved', issueKey });
            this.toast('Marked as resolved in SonarQube', 'success');
        } catch (err: any) {
            this.post({ type: 'resolveError', issueKey });
            const is403 = (err as any).response?.status === 403 || err.message?.includes('403');
            this.toast(
                is403
                    ? 'Permission denied — token needs "Administer Issues" permission in SonarQube'
                    : `Could not mark resolved: ${err.message}`,
                'error'
            );
        }
    }

    protected async handleFixSelected(issues: SonarIssue[]): Promise<void> {
        if (!this.aiProvider) {
            return this.toast('No OpenAI API key configured — add it in Settings', 'error');
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

    protected async handleExport(format: string, content: string, filename: string): Promise<void> {
        const root = getWorkspaceRoot();
        const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(root || ''), filename);
        let filters: Record<string, string[]>;
        if (format === 'json')     { filters = { 'JSON Files': ['json'] }; }
        else if (format === 'csv') { filters = { 'CSV Files':  ['csv']  }; }
        else                       { filters = { 'Text Files': ['txt']  }; }

        const uri = await vscode.window.showSaveDialog({ defaultUri, filters });
        if (!uri) { return; }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        this.toast(`Exported to ${path.basename(uri.fsPath)}`, 'success');
    }

    protected getWebviewContent(): string {
        const base = path.join(this.context.extensionPath, 'webview');
        let html = fs.readFileSync(path.join(base, 'index.html'), 'utf-8');
        const css = fs.readFileSync(path.join(base, 'styles.css'), 'utf-8');
        const js  = fs.readFileSync(path.join(base, 'script.js'),  'utf-8');
        return html
            .replace('{{STYLES}}', `<style>\n${css}\n</style>`)
            .replace('{{SCRIPT}}', `<script>\n${js}\n</script>`);
    }
}
