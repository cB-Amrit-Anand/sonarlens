import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function isGitRepo(cwd: string): Promise<boolean> {
    try {
        await execAsync('git rev-parse --is-inside-work-tree', { cwd });
        return true;
    } catch {
        return false;
    }
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
    try {
        const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
        const branch = stdout.trim();
        return branch === 'HEAD' ? undefined : branch;
    } catch {
        return undefined;
    }
}

export async function stageFile(filePath: string, cwd: string): Promise<void> {
    await execAsync(`git add "${filePath}"`, { cwd });
}

export async function commitFix(
    filePath: string,
    issueKey: string,
    cwd: string
): Promise<{ success: boolean; message: string }> {
    try {
        await execAsync(`git add "${filePath}"`, { cwd });
        const msg = `Fix Sonar issue: ${issueKey}`;
        await execAsync(`git commit -m "${msg}"`, { cwd });
        return { success: true, message: `Committed: ${msg}` };
    } catch (err: any) {
        return { success: false, message: err.message || 'Git commit failed' };
    }
}
