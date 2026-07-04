import { exec } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import axios from 'axios';

const execAsync = promisify(exec);

export const DEFAULT_LOCAL_PORT = 9876;
const CONTAINER = 'sonarlens-local';
const VOLUME = 'sonarlens-data';
const IMAGE = 'sonarqube:community';

export function localUrlFor(port: number): string {
    return `http://127.0.0.1:${port}`;
}

export const DOCKER_NOT_INSTALLED_MSG = `Docker is not installed — local scanning runs a private SonarQube in a container.

macOS:
  brew install --cask docker
  (or install Docker Desktop / OrbStack)

Ubuntu / Debian:
  sudo apt-get install docker.io
  sudo usermod -aG docker $USER   (re-login afterwards)

Windows:
  Install Docker Desktop from https://www.docker.com/products/docker-desktop

After installing, start Docker and try again.`;

export const DOCKER_NOT_RUNNING_MSG = `Docker is installed but not running.

Start Docker (open Docker Desktop / OrbStack, or run: sudo systemctl start docker), wait for it to be ready, then click Scan again.`;

export interface ProfileBackup {
    language: string;
    name: string;
    xml: string;
}

export async function dockerState(): Promise<'not-installed' | 'not-running' | 'ready'> {
    try {
        await execAsync('docker -v', { timeout: 10000 });
    } catch {
        return 'not-installed';
    }
    try {
        await execAsync('docker info', { timeout: 15000 });
        return 'ready';
    } catch {
        return 'not-running';
    }
}

export async function containerState(): Promise<'missing' | 'stopped' | 'running'> {
    try {
        const { stdout } = await execAsync(`docker inspect -f "{{.State.Running}}" ${CONTAINER}`);
        return stdout.trim() === 'true' ? 'running' : 'stopped';
    } catch {
        return 'missing';
    }
}

export async function startLocalSonar(port: number, onProgress: (msg: string) => void): Promise<void> {
    const state = await containerState();
    if (state === 'running') {
        onProgress('Local SonarQube container already running');
        return;
    }
    if (state === 'stopped') {
        onProgress('Starting local SonarQube container…');
        await execAsync(`docker start ${CONTAINER}`);
        return;
    }
    onProgress('Creating local SonarQube container — first run downloads the image (~700MB), please wait…');
    await execAsync(
        `docker run -d --name ${CONTAINER} -p 127.0.0.1:${port}:9000 ` +
        `-e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true -v ${VOLUME}:/opt/sonarqube/data ${IMAGE}`,
        { timeout: 600000 }
    );
}

export async function stopLocalSonar(): Promise<void> {
    await execAsync(`docker stop ${CONTAINER}`, { timeout: 60000 });
}

/** Full teardown: container + its database volume. Next scan starts clean. */
export async function resetLocalSonar(): Promise<void> {
    await execAsync(`docker rm -f ${CONTAINER}`, { timeout: 60000 }).catch(() => {});
    await execAsync(`docker volume rm ${VOLUME}`, { timeout: 60000 }).catch(() => {});
}

export async function waitForLocalSonarUp(
    port: number,
    onProgress: (msg: string) => void,
    timeoutMs = 240000
): Promise<void> {
    const baseUrl = localUrlFor(port);
    const start = Date.now();
    let lastStatus = '';
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await axios.get(`${baseUrl}/api/system/status`, { timeout: 5000 });
            const status: string = res.data?.status ?? 'UNKNOWN';
            if (status === 'UP') {
                onProgress('Local SonarQube is up');
                return;
            }
            if (status !== lastStatus) {
                onProgress(`Local SonarQube starting… (${status})`);
                lastStatus = status;
            }
        } catch {
            if (!lastStatus) {
                onProgress('Waiting for local SonarQube to boot…');
                lastStatus = 'BOOTING';
            }
        }
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`Local SonarQube did not become ready in ${Math.round(timeoutMs / 60000)} minutes. Check: docker logs ${CONTAINER}`);
}

interface AdminAuth { username: string; password: string; }

async function adminWorks(baseUrl: string, password: string): Promise<boolean> {
    try {
        await axios.get(`${baseUrl}/api/user_tokens/search`, {
            auth: { username: 'admin', password },
            timeout: 10000
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensure admin credentials + an analysis token exist for the local server.
 * `desiredPassword` (from the setup dialog) is used when the container still
 * has the factory admin/admin credentials; otherwise a random one is used.
 */
const RESET_HINT = `Reset the local server completely with:
  docker rm -f ${CONTAINER} && docker volume rm ${VOLUME}
(this also deletes any local-only analysis history — the org server is unaffected)`;

export async function ensureLocalAuth(
    context: vscode.ExtensionContext,
    port: number,
    onProgress: (msg: string) => void,
    desiredPassword?: string
): Promise<{ token: string; adminAuth: AdminAuth }> {
    const baseUrl = localUrlFor(port);
    let adminPass = await context.secrets.get('localSonarAdminPass');

    if (!adminPass || !(await adminWorks(baseUrl, adminPass))) {
        if (await adminWorks(baseUrl, 'admin')) {
            // Factory credentials still active — this is a genuinely new
            // volume/database, safe to set the password from the setup dialog.
            const newPass = desiredPassword || crypto.randomBytes(18).toString('base64url');
            await axios.post(`${baseUrl}/api/users/change_password`, null, {
                params: { login: 'admin', previousPassword: 'admin', password: newPass },
                auth: { username: 'admin', password: 'admin' }
            });
            // Confirm the change actually took before trusting it — a
            // silent failure here previously left secrets and the server
            // out of sync with no error surfaced.
            if (!(await adminWorks(baseUrl, newPass))) {
                throw new Error(`Password change did not take effect on the local server. ${RESET_HINT}`);
            }
            adminPass = newPass;
            await context.secrets.store('localSonarAdminPass', adminPass);
            onProgress('Local admin credentials initialized');
        } else {
            // Neither the stored password nor factory admin/admin works.
            // This container's database (the Docker volume) predates the
            // stored secret — e.g. the container was deleted and recreated
            // but the volume, which holds the real password, was not.
            throw new Error(
                `Cannot authenticate with the local SonarQube container — its saved credentials ` +
                `don't match what's stored in VS Code (likely because the container was deleted ` +
                `and recreated without also removing its data volume). ${RESET_HINT}`
            );
        }
    }

    const adminAuth: AdminAuth = { username: 'admin', password: adminPass };

    let token = await context.secrets.get('localSonarToken');
    if (token) {
        try {
            const res = await axios.get(`${baseUrl}/api/user_tokens/search`, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000
            });
            if (res.status === 200) { return { token, adminAuth }; }
        } catch { /* token stale — regenerate below */ }
    }

    try {
        await axios.post(`${baseUrl}/api/user_tokens/revoke`, null, {
            params: { name: 'sonarlens' }, auth: adminAuth
        });
    } catch { /* no existing token — fine */ }

    const gen = await axios.post(`${baseUrl}/api/user_tokens/generate`, null, {
        params: { name: 'sonarlens' }, auth: adminAuth
    });
    token = gen.data.token as string;
    await context.secrets.store('localSonarToken', token);
    onProgress('Local analysis token generated');
    return { token, adminAuth };
}

export async function restoreQualityProfiles(
    port: number,
    backups: ProfileBackup[],
    adminAuth: AdminAuth,
    onProgress: (msg: string) => void
): Promise<string[]> {
    const baseUrl = localUrlFor(port);
    const skipped: string[] = [];

    let availableLangs: Set<string> | null = null;
    try {
        const res = await axios.get(`${baseUrl}/api/languages/list`, { auth: adminAuth });
        availableLangs = new Set((res.data?.languages || []).map((l: any) => l.key));
    } catch { /* can't check — attempt all */ }

    const FormDataCtor: any = (globalThis as any).FormData;
    const BlobCtor: any = (globalThis as any).Blob;

    for (const backup of backups) {
        if (availableLangs && !availableLangs.has(backup.language)) {
            skipped.push(`${backup.name} (${backup.language})`);
            continue;
        }
        try {
            const form = new FormDataCtor();
            form.append('backup', new BlobCtor([backup.xml], { type: 'application/xml' }), 'profile.xml');
            await axios.post(`${baseUrl}/api/qualityprofiles/restore`, form, {
                auth: adminAuth, timeout: 120000
            });
            await axios.post(`${baseUrl}/api/qualityprofiles/set_default`, null, {
                params: { language: backup.language, qualityProfile: backup.name },
                auth: adminAuth
            });
            onProgress(`Imported org profile "${backup.name}" (${backup.language})`);
        } catch {
            skipped.push(`${backup.name} (${backup.language})`);
        }
    }
    return skipped;
}

export async function ensureLocalProject(
    port: number,
    projectKey: string,
    name: string,
    adminAuth: AdminAuth
): Promise<void> {
    try {
        await axios.post(`${localUrlFor(port)}/api/projects/create`, null, {
            params: { project: projectKey, name },
            auth: adminAuth
        });
    } catch (err: any) {
        // 400 = project already exists — idempotent
        if (err.response?.status !== 400) { throw err; }
    }
}
