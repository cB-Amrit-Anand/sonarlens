import axios, { AxiosInstance } from 'axios';

export interface SonarConfig {
    uri: string;
    projectKey: string;
    token: string;
    tokenType?: 'basic' | 'bearer';
}

export interface PullRequest {
    key: string;
    title: string;
    branch: string;
    base: string;
    status: {
        qualityGateStatus: string;
    };
    analysisDate?: string;
    url?: string;
}

export interface TextRange {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
}

export interface SonarIssue {
    key: string;
    component: string;
    line?: number;
    message: string;
    severity: string;
    status: string;
    rule: string;
    type: string;
    textRange?: TextRange;
    effort?: string;
    debt?: string;
    tags?: string[];
}

export interface IssuesResponse {
    issues: SonarIssue[];
    total: number;
    p: number;
    ps: number;
}

export interface SonarRule {
    key: string;
    name: string;
    severity: string;
    type: string;
    lang: string;
    langName: string;
    status: string;
    htmlDesc?: string;
    tags?: string[];
}

export interface SonarQualityProfile {
    key: string;
    name: string;
    language: string;
    languageName: string;
    isDefault: boolean;
    activeRuleCount: number;
}

export class SonarQubeApi {
    private client: AxiosInstance;
    private config: SonarConfig;

    constructor(config: SonarConfig) {
        this.config = config;
        const axiosConfig: Parameters<typeof axios.create>[0] = {
            baseURL: config.uri,
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        };
        if (config.tokenType === 'bearer') {
            (axiosConfig.headers as Record<string, string>)['Authorization'] = `Bearer ${config.token}`;
        } else {
            axiosConfig.auth = { username: config.token, password: '' };
        }
        this.client = axios.create(axiosConfig);

        this.client.interceptors.response.use(
            res => res,
            err => {
                const url    = err.config?.url ?? '(unknown)';
                const method = (err.config?.method ?? 'GET').toUpperCase();
                const base   = err.config?.baseURL ?? '';

                let detail: string;
                if (err.code === 'ECONNABORTED') {
                    detail = `Request timed out after 30s — ${method} ${base}${url}. Check that your SonarQube URL is reachable and not behind a VPN/firewall.`;
                } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                    detail = `Cannot reach ${base} (${err.code}) — verify the SonarQube URL in sonar-project.properties.`;
                } else if (err.response) {
                    const status = err.response.status;
                    const body   = typeof err.response.data === 'string'
                        ? err.response.data.substring(0, 200)
                        : JSON.stringify(err.response.data ?? '').substring(0, 200);
                    detail = `HTTP ${status} on ${method} ${base}${url} — ${body}`;
                } else {
                    detail = err.message;
                }

                const enhanced = new Error(detail);
                (enhanced as any).response = err.response;
                return Promise.reject(enhanced);
            }
        );
    }

    async getPullRequests(): Promise<PullRequest[]> {
        const response = await this.client.get('/api/project_pull_requests/list', {
            params: { project: this.config.projectKey }
        });
        return response.data.pullRequests || [];
    }

    async getIssues(prKey: string, page: number = 1, ps: number = 50): Promise<IssuesResponse> {
        const response = await this.client.get('/api/issues/search', {
            params: {
                componentKeys: this.config.projectKey,
                pullRequest: prKey,
                p: page,
                ps
            }
        });
        // SonarQube ≤9 puts pagination at top level; v10+ / SonarCloud wraps it in `paging`
        const paging = response.data.paging;
        return {
            issues: response.data.issues || [],
            total: paging?.total   ?? response.data.total ?? 0,
            p:     paging?.pageIndex ?? response.data.p   ?? page,
            ps:    paging?.pageSize  ?? response.data.ps  ?? 100
        };
    }

    async markIssueResolved(issueKey: string): Promise<void> {
        // SonarQube requires form-encoded POST for transitions
        const params = new URLSearchParams();
        params.append('issue', issueKey);
        params.append('transition', 'resolve');

        await this.client.post('/api/issues/do_transition', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
    }

    async getBranches(): Promise<any[]> {
        try {
            const response = await this.client.get('/api/project_branches/list', {
                params: { project: this.config.projectKey }
            });
            return response.data.branches || [];
        } catch {
            return [];
        }
    }

    // Validate connectivity and auth
    async ping(): Promise<boolean> {
        try {
            await this.client.get('/api/system/ping');
            return true;
        } catch {
            return false;
        }
    }

    async getQualityProfiles(): Promise<SonarQualityProfile[]> {
        const response = await this.client.get('/api/qualityprofiles/search', {
            params: { project: this.config.projectKey }
        });
        return response.data.profiles || [];
    }

    async getRuleCount(profileKey: string): Promise<number> {
        const response = await this.client.get('/api/rules/search', {
            params: { qprofile: profileKey, activation: true, p: 1, ps: 1 }
        });
        const paging = response.data.paging;
        return paging?.total ?? response.data.total ?? 0;
    }

    async getRules(profileKey: string, page: number = 1, ps: number = 500): Promise<{ rules: SonarRule[]; total: number }> {
        const response = await this.client.get('/api/rules/search', {
            params: {
                qprofile: profileKey,
                activation: true,
                p: page,
                ps,
                f: 'name,severity,lang,langName,htmlDesc,tags,status'
            }
        });
        const paging = response.data.paging;
        return {
            rules: response.data.rules || [],
            total: paging?.total ?? response.data.total ?? 0
        };
    }

    async getBranchIssues(branchName: string, page: number = 1, ps: number = 50): Promise<IssuesResponse> {
        const response = await this.client.get('/api/issues/search', {
            params: {
                componentKeys: this.config.projectKey,
                branch: branchName,
                resolved: false,
                p: page,
                ps
            }
        });
        const paging = response.data.paging;
        return {
            issues: response.data.issues || [],
            total: paging?.total   ?? response.data.total ?? 0,
            p:     paging?.pageIndex ?? response.data.p   ?? page,
            ps:    paging?.pageSize  ?? response.data.ps  ?? ps
        };
    }
}
