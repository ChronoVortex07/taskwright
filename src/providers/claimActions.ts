import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import { ClaimService } from '../core/ClaimService';
import { GitBranchService } from '../core/GitBranchService';
import { resolveClaimIdentity } from '../core/claimIdentity';
import { Claim } from '../core/claims';

/**
 * Provider-layer glue for advisory claiming. Resolves the claimant identity
 * (config → OS user) and best-effort current branch, then delegates the actual
 * surgical file edit to {@link ClaimService}. Kept out of `src/core` because it
 * reaches into VS Code config and git; the pieces it composes are unit-tested.
 */
const claimService = new ClaimService();

/** The identity a UI/command-initiated claim is attributed to. */
export function getClaimIdentity(): string {
  const configured = vscode.workspace.getConfiguration('backlog').get<string>('claimIdentity', '');
  return resolveClaimIdentity(configured, os.userInfo().username);
}

/**
 * Best-effort current git branch, recorded as the claim's `worktree`. Returns
 * undefined outside a git repo or on any git error — claiming must not depend
 * on git being present.
 */
async function currentBranch(parser: BacklogParser): Promise<string | undefined> {
  try {
    const repoRoot = path.dirname(parser.getBacklogPath());
    const git = new GitBranchService(repoRoot);
    if (!(await git.isGitRepository())) return undefined;
    const branch = await git.getCurrentBranch();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/** Claim a task for the current user, recording the active branch as worktree. */
export async function claimTaskForCurrentUser(
  taskId: string,
  parser: BacklogParser
): Promise<Claim> {
  const worktree = await currentBranch(parser);
  return claimService.claimTask(taskId, getClaimIdentity(), parser, { worktree });
}

/** Release any claim on a task. */
export async function releaseTaskClaim(taskId: string, parser: BacklogParser): Promise<void> {
  await claimService.releaseTask(taskId, parser);
}
