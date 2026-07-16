import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import { SonarQubeApi, SonarConfig, SonarIssue, SonarRule, SonarQualityProfile } from '../api/sonarqubeApi';
import { AiFixProvider } from '../ai/aiFixProvider';
import {
    resolveFilePath, readFileContent, extractCodeSnippet,
    applyLineFix, writeFile, openDiffView, getWorkspaceRoot, readSonarProperties
} from '../utils/fileUtils';
import * as crypto from 'crypto';
import { commitFix, isGitRepo, getCurrentBranch, getChangedFiles } from '../utils/gitUtils';
import { runSonarScanner, pollCeTask, stopSonarScanner } from '../utils/scannerUtils';
import {
    DEFAULT_LOCAL_PORT, DOCKER_NOT_INSTALLED_MSG, DOCKER_NOT_RUNNING_MSG, ProfileBackup,
    localUrlFor, dockerState, containerState, startLocalSonar, waitForLocalSonarUp,
    ensureLocalAuth, restoreQualityProfiles, ensureLocalProject, resetLocalSonar
} from '../utils/localSonarUtils';

interface SaveConfigPayload extends SonarConfig { aiApiKey: string; tokenType: 'basic' | 'bearer'; }

interface StoredRulesCache {
    syncedAt: string;
    profiles: SonarQualityProfile[];
    rules: SonarRule[];
}

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
        const tokenBoundUri = this.context.globalState.get<string>('sonarTokenBoundUri');

        // The saved token was issued for a specific SonarQube URI. If the
        // active URI (from sonar-project.properties or the last saved
        // settings) no longer matches, the token is almost certainly wrong
        // for this server — don't autofill it, and prompt for a fresh one.
        const activeUri = (validProps ? propsConfig!.uri : this.context.globalState.get<{ uri: string }>('sonarConfigMeta')?.uri)
            ?.replace(/\/+$/, '');
        const tokenMatchesUri = !!storedToken && !!tokenBoundUri && tokenBoundUri === activeUri;
        const usableToken = tokenMatchesUri ? storedToken : '';
        const uriChanged = !!storedToken && !tokenMatchesUri && !!activeUri;

        const savedConfig = this.context.globalState.get<Omit<SonarConfig, 'token'>>('sonarConfigMeta');
        const validSavedConfig = !!(savedConfig?.uri && savedConfig?.projectKey);

        if (validProps) {
            this.post({ type: 'loadConfig', data: { ...propsConfig, token: usableToken, aiApiKey: storedAiKey, tokenType: storedTokenType, fromFile: true } });
        } else {
            if (savedConfig) {
                this.post({ type: 'loadConfig', data: { ...savedConfig, token: usableToken, aiApiKey: storedAiKey, tokenType: storedTokenType } });
            }
            this.post({ type: 'noPropertiesFile' });
        }

        if (uriChanged) {
            this.post({ type: 'tokenNeedsRefresh', uri: activeUri });
        }

        // Config can come from sonar-project.properties OR from settings
        // saved manually (globalState) — either is a complete configuration,
        // not just the properties-file path.
        const effectiveUri        = validProps ? propsConfig!.uri! : savedConfig?.uri;
        const effectiveProjectKey = validProps ? propsConfig!.projectKey! : savedConfig?.projectKey;
        const hasConfig = validProps || validSavedConfig;

        if (hasConfig && usableToken && effectiveUri && effectiveProjectKey) {
            this.sonarApi = new SonarQubeApi({
                uri: effectiveUri.replace(/\/$/, ''),
                projectKey: effectiveProjectKey,
                token: usableToken,
                tokenType: storedTokenType
            });
            this.aiProvider = storedAiKey ? new AiFixProvider(storedAiKey) : undefined;
        }

        this.post({ type: 'configStatus', configured: !!(hasConfig && usableToken) });

        // Restore cached rules status and current branch for the scan tab
        const cache = this.context.globalState.get<StoredRulesCache>('sonarRulesCache');
        if (cache) {
            this.post({ type: 'rulesLoaded', syncedAt: cache.syncedAt, ruleCount: cache.rules.length, profiles: cache.profiles, rules: cache.rules });
        }
        const root2 = getWorkspaceRoot();
        if (root2) {
            getCurrentBranch(root2).then(branch => {
                if (branch) { this.post({ type: 'currentBranch', branch }); }
            }).catch(() => {});
        }
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
            case 'preflightSyncRules': return this.handlePreflightSyncRules();
            case 'syncRules':      return this.handleSyncRules();
            case 'scanBranch':     return this.handleScanBranch(
                message.scope === 'changed' ? 'changed' : 'full',
                message.target === 'server' ? 'server' : 'local'
            );
            case 'stopScan':       return this.handleStopScan();
            case 'confirmLocalSetup': return this.handleConfirmLocalSetup(message.port, message.password, message.scope);
            case 'resetLocalServer': return this.handleResetLocalServer();
            case 'loadScanState':  return this.handleLoadScanState();
        }
    }

    protected handleOpenInPanel(): void {
        vscode.commands.executeCommand('sonarqube-ai-fixer.openPanel');
    }

    protected handleOpenUrl(url: string): void {
        if (url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
    }

    protected async handleSaveConfig(cfg: SaveConfigPayload): Promise<void> {
        const newUri = cfg.uri.replace(/\/+$/, '');
        const tokenBoundUri = this.context.globalState.get<string>('sonarTokenBoundUri');
        const storedToken = await this.context.secrets.get('sonarToken') || '';

        // Token is unchanged from what's already saved (webview echoes the
        // stored token back), but it was issued for a different URI — the
        // user changed the URI without providing a new token. Refuse to
        // save with a token that doesn't belong to this server.
        if (cfg.token && cfg.token === storedToken && tokenBoundUri && tokenBoundUri !== newUri) {
            this.post({ type: 'tokenNeedsRefresh', uri: newUri });
            return this.toast('SonarQube URI changed — generate and enter a new token for this server before saving', 'warning');
        }

        const sonarConfig: SonarConfig = {
            uri: newUri,
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
        await this.context.globalState.update('sonarTokenBoundUri', newUri);

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

    protected async handleLoadScanState(): Promise<void> {
        const cache = this.context.globalState.get<StoredRulesCache>('sonarRulesCache');
        if (cache) {
            this.post({ type: 'rulesLoaded', syncedAt: cache.syncedAt, ruleCount: cache.rules.length, profiles: cache.profiles, rules: cache.rules });
        }
        const root = getWorkspaceRoot();
        if (root) {
            const branch = await getCurrentBranch(root);
            if (branch) { this.post({ type: 'currentBranch', branch }); }
        }
    }

    protected async handlePreflightSyncRules(): Promise<void> {
        if (!this.sonarApi) { return this.toast('Save configuration first', 'error'); }
        this.post({ type: 'loading', key: 'preflight', value: true });
        try {
            const profiles = await this.sonarApi.getQualityProfiles();
            if (profiles.length === 0) {
                this.post({ type: 'syncPreflightError' });
                return this.toast('No quality profiles found for this project', 'warning');
            }
            // Fetch rule counts per profile in parallel
            const counts = await Promise.all(
                profiles.map(p => this.sonarApi!.getRuleCount(p.key))
            );
            const totalRules = counts.reduce((a, b) => a + b, 0);
            // Estimate: ~500 rules/request, ~1s per request + overhead
            const estimatedSeconds = Math.max(5, Math.ceil(totalRules / 500) * profiles.length * 2);
            const estimatedDisplay = estimatedSeconds < 60
                ? `~${estimatedSeconds}s`
                : `~${Math.ceil(estimatedSeconds / 60)}m`;

            this.post({
                type: 'syncPreflight',
                profiles: profiles.map((p, i) => ({ ...p, ruleCount: counts[i] })),
                totalRules,
                estimatedTime: estimatedDisplay
            });
        } catch (err: any) {
            this.post({ type: 'syncPreflightError' });
            this.toast(`Failed to fetch profile info: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'preflight', value: false });
        }
    }

    protected async handleSyncRules(): Promise<void> {
        if (!this.sonarApi) { return this.toast('Save configuration first', 'error'); }
        this.post({ type: 'loading', key: 'syncRules', value: true });
        try {
            const profiles = await this.sonarApi.getQualityProfiles();
            if (profiles.length === 0) {
                return this.toast('No quality profiles found for this project', 'warning');
            }

            const allRules: SonarRule[] = [];
            for (const profile of profiles) {
                let page = 1;
                while (true) {
                    const { rules, total } = await this.sonarApi.getRules(profile.key, page, 500);
                    allRules.push(...rules);
                    if (page * 500 >= total) { break; }
                    page++;
                }
            }

            const cache: StoredRulesCache = {
                syncedAt: new Date().toISOString(),
                profiles,
                rules: allRules
            };
            await this.context.globalState.update('sonarRulesCache', cache);

            // Also download each profile's backup XML — used to replicate the
            // org rule set inside the local Docker SonarQube for local scans.
            const backups: ProfileBackup[] = [];
            for (const profile of profiles) {
                try {
                    const xml = await this.sonarApi.getQualityProfileBackup(profile.language, profile.name);
                    backups.push({ language: profile.language, name: profile.name, xml });
                } catch { /* non-fatal — local scan falls back to default rules for this language */ }
            }
            this.writeProfileBackups(backups);
            // Force re-import into the local container on next local scan
            await this.context.globalState.update('localProfilesHash', undefined);

            this.post({
                type: 'rulesLoaded',
                syncedAt: cache.syncedAt,
                ruleCount: allRules.length,
                profiles,
                rules: allRules
            });
            this.toast(`Synced ${allRules.length} rules from ${profiles.length} quality profile(s)`, 'success');
        } catch (err: any) {
            this.toast(`Failed to sync rules: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'syncRules', value: false });
        }
    }

    private scanCancelRequested = false;
    private scanCompletedOk = false;
    /** Set only by the setup-confirmation flow, consumed once by the very next runLocalScan() */
    private localSetupApprovedOnce = false;

    protected handleStopScan(): void {
        this.scanCancelRequested = true;
        stopSonarScanner();
        this.post({ type: 'scanProgress', message: 'Stop requested — terminating scan…' });
    }

    /* ── Profile backup persistence (globalStorage file — XMLs are too big for globalState) ── */

    private profileBackupsPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'profile-backups.json');
    }

    protected writeProfileBackups(backups: ProfileBackup[]): void {
        try {
            fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
            fs.writeFileSync(this.profileBackupsPath(), JSON.stringify(backups));
        } catch { /* non-fatal */ }
    }

    protected readProfileBackups(): ProfileBackup[] | null {
        try {
            const raw = fs.readFileSync(this.profileBackupsPath(), 'utf-8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
        } catch {
            return null;
        }
    }

    protected async handleScanBranch(scope: 'full' | 'changed' = 'full', target: 'local' | 'server' = 'local'): Promise<void> {
        this.scanCancelRequested = false;

        const root = getWorkspaceRoot();
        if (!root) { return this.toast('No workspace folder open', 'error'); }

        const branch = await getCurrentBranch(root) || 'local';

        // Expected duration = how long the same kind of scan took last time
        const durationKey = `scanDuration:${target}:${scope}`;
        const expectedMs = this.context.globalState.get<number>(durationKey);
        const startedAt = Date.now();
        this.scanCompletedOk = false;

        this.post({ type: 'scanStarted', branch, expectedMs });
        this.post({ type: 'loading', key: 'scan', value: true });

        const progress = (message: string) => this.post({ type: 'scanProgress', message });

        try {
            // Changed-only scope: resolve the file list up front (shared by both targets)
            let inclusions: string[] | undefined;
            if (scope === 'changed') {
                inclusions = await getChangedFiles(root);
                if (inclusions.length === 0) {
                    this.post({ type: 'scanStopped' });
                    this.toast('No changed files since last push — nothing to scan', 'info');
                    return;
                }
                progress(`Changed-files scan: ${inclusions.length} file(s) since last push`);
                progress(`Files: ${inclusions.slice(0, 15).join(', ')}${inclusions.length > 15 ? ` … +${inclusions.length - 15} more` : ''}`);
            }

            if (target === 'local') {
                await this.runLocalScan(root, branch, inclusions, progress, scope);
            } else {
                await this.runServerScan(root, branch, inclusions, progress);
            }
            if (this.scanCompletedOk) {
                await this.context.globalState.update(durationKey, Date.now() - startedAt);
            }
        } catch (err: any) {
            // Surface the API's actual error text, not just the HTTP status
            const apiErrors = err.response?.data?.errors?.map((e: any) => e.msg).join('; ');
            const message = apiErrors ? `${err.message} — ${apiErrors}` : err.message;
            this.post({ type: 'scanError', message });
            this.toast(`Scan failed: ${message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'scan', value: false });
        }
    }

    protected async handleResetLocalServer(): Promise<void> {
        this.post({ type: 'loading', key: 'scan', value: true });
        try {
            await resetLocalSonar();
            // Stored credentials belong to the database volume that was just
            // deleted — clear them so the next scan bootstraps fresh ones
            // instead of trying (and failing) to authenticate with the old pair.
            await this.context.secrets.delete('localSonarAdminPass');
            await this.context.secrets.delete('localSonarToken');
            await this.context.secrets.delete('localSonarDesiredPass');
            await this.context.globalState.update('localProfilesHash', undefined);
            this.toast('Local server reset — next scan will set it up fresh', 'success');
        } catch (err: any) {
            this.toast(`Reset failed: ${err.message}`, 'error');
        } finally {
            this.post({ type: 'loading', key: 'scan', value: false });
        }
    }

    protected async handleConfirmLocalSetup(port: number, password: string, scope: 'full' | 'changed'): Promise<void> {
        const chosenPort = Number(port) > 0 && Number(port) < 65536 ? Number(port) : DEFAULT_LOCAL_PORT;
        await this.context.globalState.update('localSonarPort', chosenPort);
        // One-shot approval: only skips the dialog for the container creation
        // this scan is about to perform. If the container is ever removed
        // again, runLocalScan() sees it missing and asks again.
        this.localSetupApprovedOnce = true;
        if (password && password.trim().length >= 8) {
            await this.context.secrets.store('localSonarDesiredPass', password.trim());
        }
        return this.handleScanBranch(scope === 'changed' ? 'changed' : 'full', 'local');
    }

    /** Option A — fully local: private SonarQube in Docker, nothing leaves the machine */
    private async runLocalScan(
        root: string,
        branch: string,
        inclusions: string[] | undefined,
        progress: (msg: string) => void,
        scope: 'full' | 'changed'
    ): Promise<void> {
        progress('Target: LOCAL SonarQube (Docker) — code and issues stay on this machine');

        // 1. Docker installed and running?
        const docker = await dockerState();
        if (docker === 'not-installed') {
            this.post({ type: 'scanError', message: DOCKER_NOT_INSTALLED_MSG });
            this.toast('Docker is not installed', 'error');
            return;
        }
        if (docker === 'not-running') {
            this.post({ type: 'scanError', message: DOCKER_NOT_RUNNING_MSG });
            this.toast('Docker is not running — start Docker and scan again', 'warning');
            return;
        }

        // 2. Container installed? If not, ask the user every time before
        // creating anything — a missing container means fresh admin
        // credentials, a fresh token, and a new image/volume, regardless of
        // whether an older container was approved in the past.
        const port = this.context.globalState.get<number>('localSonarPort') || DEFAULT_LOCAL_PORT;
        const container = await containerState();
        if (container === 'missing' && !this.localSetupApprovedOnce) {
            this.post({
                type: 'localSetupRequired',
                scope,
                defaults: {
                    host: '127.0.0.1',
                    port: DEFAULT_LOCAL_PORT,
                    username: 'admin',
                    password: crypto.randomBytes(9).toString('base64url'),
                    image: 'sonarqube:community (~700MB download, ~2GB RAM while running)'
                }
            });
            this.post({ type: 'scanStopped' });
            return;
        }

        this.localSetupApprovedOnce = false;

        const localUrl = localUrlFor(port);
        progress(`Local server: ${localUrl}`);

        await startLocalSonar(port, progress);
        await waitForLocalSonarUp(port, progress);
        if (this.scanCancelRequested) { this.post({ type: 'scanStopped' }); return; }

        const desiredPass = await this.context.secrets.get('localSonarDesiredPass') || undefined;
        const { token: localToken, adminAuth } = await ensureLocalAuth(this.context, port, progress, desiredPass);

        // Import org quality profiles once per sync (hash guards re-import)
        const backups = this.readProfileBackups();
        if (backups) {
            const backupsHash = crypto.createHash('sha1').update(JSON.stringify(backups.map(b => [b.language, b.name, b.xml.length]))).digest('hex');
            if (this.context.globalState.get<string>('localProfilesHash') !== backupsHash) {
                progress('Importing org quality profiles into local SonarQube…');
                const skipped = await restoreQualityProfiles(port, backups, adminAuth, progress);
                if (skipped.length > 0) {
                    progress(`Skipped profiles (language not supported locally): ${skipped.join(', ')}`);
                }
                await this.context.globalState.update('localProfilesHash', backupsHash);
            }
        } else {
            progress('No org profile backups found — using local default rules. Re-run "Sync Rules" to import org profiles.');
        }

        const props = readSonarProperties(root);
        const configMeta = this.context.globalState.get<{ uri: string; projectKey: string }>('sonarConfigMeta');
        const projectKey = props?.projectKey || configMeta?.projectKey;
        if (!projectKey) {
            this.post({ type: 'scanError', message: 'No sonar.projectKey found — add it to sonar-project.properties.' });
            return;
        }
        await ensureLocalProject(port, projectKey, path.basename(root), adminAuth);
        if (this.scanCancelRequested) { this.post({ type: 'scanStopped' }); return; }

        progress(`Running sonar-scanner locally on branch: ${branch}`);
        // No sonar.branch.name — local Community server doesn't support branch
        // analysis; the checked-out working copy IS the branch being scanned.
        const scanResult = await runSonarScanner(
            root,
            { hostUrl: localUrl, token: localToken, projectKey, inclusions },
            (line) => {
                if (line.includes('ERROR') || line.includes('WARN') || line.includes('INFO')) {
                    progress(line.trim());
                }
            }
        );

        if (scanResult.cancelled || this.scanCancelRequested) {
            this.post({ type: 'scanStopped' });
            this.toast('Scan stopped', 'info');
            return;
        }
        if (!scanResult.success) {
            this.post({ type: 'scanError', message: scanResult.output });
            this.toast('sonar-scanner failed — check the scan log', 'error');
            return;
        }
        if (!scanResult.ceTaskUrl) {
            this.post({ type: 'scanError', message: 'sonar-scanner completed but report-task.txt not found.' });
            return;
        }

        progress('Analysis done — local server processing…');
        const ceResult = await pollCeTask(
            scanResult.ceTaskUrl, localToken, 'bearer',
            (status) => progress(`Local analysis status: ${status}`),
            () => this.scanCancelRequested
        );

        if (ceResult.status === 'CANCELLED') {
            this.post({ type: 'scanStopped' });
            this.toast('Scan stopped', 'info');
            return;
        }
        if (ceResult.status !== 'SUCCESS') {
            const reason = ceResult.errorMessage ? ` — ${ceResult.errorMessage}` : '';
            const hint = ceResult.status === 'TIMEOUT'
                ? `Local analysis is taking longer than 15 minutes${reason}. It may still finish in the background — check ${localUrl}/dashboard?id=${encodeURIComponent(projectKey)} in a few minutes, or run: docker logs sonarlens-local`
                : `Local analysis ${ceResult.status}${reason} — check: docker logs sonarlens-local`;
            this.post({ type: 'scanError', message: hint });
            return;
        }

        progress('Fetching issues from local server…');
        const localApi = new SonarQubeApi({ uri: localUrl, projectKey, token: localToken, tokenType: 'bearer' });
        const allIssues: SonarIssue[] = [];
        let page = 1;
        while (true) {
            const result = await localApi.getProjectIssues(page, 500);
            allIssues.push(...result.issues);
            // The issues API cannot page past 10 000 results
            if (page * result.ps >= Math.min(result.total, 10000)) {
                if (result.total > 10000) {
                    progress(`Note: ${result.total} issues total — showing the first 10000`);
                }
                break;
            }
            page++;
        }

        this.scanCompletedOk = true;
        this.post({
            type: 'scanComplete',
            branch,
            issues: allIssues,
            total: allIssues.length,
            dashboardUrl: `${localUrl}/dashboard?id=${encodeURIComponent(projectKey)}`,
            local: true
        });
        this.toast(`Local scan complete — ${allIssues.length} issue(s) on branch ${branch}`, allIssues.length === 0 ? 'success' : 'warning');
    }

    /** Option C — central server: analysis report uploads to the configured SonarQube */
    private async runServerScan(
        root: string,
        branch: string,
        inclusions: string[] | undefined,
        progress: (msg: string) => void
    ): Promise<void> {
        if (!this.sonarApi) {
            this.post({ type: 'scanError', message: 'Save configuration first — server scan needs the central SonarQube settings.' });
            return;
        }

        const configMeta  = this.context.globalState.get<{ uri: string; projectKey: string }>('sonarConfigMeta');
        const hostUrl     = configMeta?.uri || this.sonarApi.uri;
        const storedToken = await this.context.secrets.get('sonarToken') || '';
        const tokenType   = this.context.globalState.get<'basic' | 'bearer'>('sonarTokenType') || 'basic';

        progress(`Target server: ${hostUrl}`);
        progress(`Running sonar-scanner on branch: ${branch}`);

        const scanResult = await runSonarScanner(
            root,
            { hostUrl, token: storedToken, branchName: branch, inclusions },
            (line) => {
                if (line.includes('ERROR') || line.includes('WARN') || line.includes('INFO')) {
                    progress(line.trim());
                }
            }
        );

        if (scanResult.cancelled || this.scanCancelRequested) {
            this.post({ type: 'scanStopped' });
            this.toast('Scan stopped', 'info');
            return;
        }
        if (!scanResult.success) {
            this.post({ type: 'scanError', message: scanResult.output });
            this.toast('sonar-scanner failed — check the scan log', 'error');
            return;
        }
        if (!scanResult.ceTaskUrl) {
            this.post({ type: 'scanError', message: 'sonar-scanner completed but report-task.txt not found. Check sonar-project.properties.' });
            return;
        }

        progress('Analysis uploaded — waiting for server processing…');
        const ceResult = await pollCeTask(
            scanResult.ceTaskUrl,
            storedToken,
            tokenType,
            (status) => progress(`Server analysis status: ${status}`),
            () => this.scanCancelRequested
        );

        if (ceResult.status === 'CANCELLED') {
            this.post({ type: 'scanStopped' });
            this.toast('Scan stopped', 'info');
            return;
        }
        if (ceResult.status !== 'SUCCESS') {
            const reason = ceResult.errorMessage ? ` — ${ceResult.errorMessage}` : '';
            const hint = ceResult.status === 'TIMEOUT'
                ? `Server analysis is taking longer than 15 minutes${reason}. It may still finish in the background — check ${hostUrl}/project/issues?id=${encodeURIComponent(this.sonarApi.projectKey)} in a few minutes, or ask your SonarQube admin to check the Background Tasks page.`
                : `Server analysis ${ceResult.status}${reason} — check the Background Tasks page on your SonarQube server for details`;
            this.post({ type: 'scanError', message: hint });
            this.toast(`Analysis ${ceResult.status}`, 'error');
            return;
        }

        progress('Fetching issues from server…');
        const allIssues: SonarIssue[] = [];
        let page = 1;
        while (true) {
            const result = await this.sonarApi.getBranchIssues(branch, page, 500);
            allIssues.push(...result.issues);
            // The issues API cannot page past 10 000 results
            if (page * result.ps >= Math.min(result.total, 10000)) {
                if (result.total > 10000) {
                    progress(`Note: ${result.total} issues total — showing the first 10000`);
                }
                break;
            }
            page++;
        }

        this.scanCompletedOk = true;
        this.post({
            type: 'scanComplete',
            branch,
            issues: allIssues,
            total: allIssues.length,
            dashboardUrl: scanResult.dashboardUrl
        });
        this.toast(`Scan complete — ${allIssues.length} issue(s) found on branch ${branch}`, allIssues.length === 0 ? 'success' : 'warning');
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
