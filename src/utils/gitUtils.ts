import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

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

/**
 * Files changed since the last push: commits not yet pushed, plus
 * staged/unstaged edits, plus untracked files.
 */
export async function getChangedFiles(cwd: string): Promise<string[]> {
    const files = new Set<string>();
    const collect = async (cmd: string): Promise<boolean> => {
        try {
            const { stdout } = await execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
            stdout.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => files.add(f));
            return true;
        } catch {
            return false;
        }
    };

    // Committed but not pushed — try push target, then upstream, then origin default branch
    (await collect('git diff --name-only @{push}...HEAD')) ||
    (await collect('git diff --name-only @{upstream}...HEAD')) ||
    (await collect('git diff --name-only origin/HEAD...HEAD'));

    await collect('git diff --name-only HEAD');                 // staged + unstaged
    await collect('git ls-files --others --exclude-standard');  // untracked

    // Drop scanner artifacts (often not gitignored), OS junk, and files that
    // no longer exist (deleted in the diff) — none of them are scannable code.
    const junk = /^(\.scannerwork|\.sonartmp)(\/|$)|(^|\/)\.DS_Store$/;
    return [...files].filter(f =>
        !junk.test(f) && fs.existsSync(path.join(cwd, f))
    );
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
