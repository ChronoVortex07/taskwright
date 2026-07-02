import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import { ClaimService } from '../core/ClaimService';
import { GitBranchService } from '../core/GitBranchService';
import { resolveClaimIdentity } from '../core/claimIdentity';
import { Claim } from '../core/claims';
import { resolveClaimAction, stalenessMsFromHours } from '../core/claimResolution';
import { getTaskwrightConfig } from '../config';
import { readSyncConfig, syncConfigPath } from '../core/syncConfig';
import { nodeQueueFs } from '../core/mergeQueue';
import { claimTaskSynced, releaseTaskSynced, type SyncTarget } from '../core/boardSyncEngine';
import { loadTreeStateFromParser } from '../core/treeDerived';
import { blockedByMessage } from '../core/treeGate';

/**
 * Provider-layer glue for advisory claiming. Resolves the claimant identity
 * (config → OS user) and best-effort current branch, then delegates the actual
 * surgical file edit to {@link ClaimService}. Kept out of `src/core` because it
 * reaches into VS Code config and git; the pieces it composes are unit-tested.
 */
const claimService = new ClaimService();

/** The identity a UI/command-initiated claim is attributed to. */
export function getClaimIdentity(): string {
  const configured = getTaskwrightConfig<string>('claimIdentity', '');
  return resolveClaimIdentity(configured, os.userInfo().username);
}

/** The configured staleness window for advisory claims, in milliseconds (0 = off). */
export function getClaimStalenessMs(): number {
  const hours = getTaskwrightConfig<number>('claimStalenessHours', 12);
  return stalenessMsFromHours(hours);
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

/**
 * Resolve the synced-board target for this workspace, or undefined when sync is
 * off / unavailable. When defined, claims must route through the CAS engine
 * (not the surgical file edit), or a UI claim would be silently overwritten by
 * the next poll's materialize and never pushed to teammates.
 */
async function resolveSyncTarget(parser: BacklogParser): Promise<SyncTarget | undefined> {
  try {
    const repoRoot = path.dirname(parser.getBacklogPath());
    const git = new GitBranchService(repoRoot);
    const commonDir = await git.getCommonDir();
    if (!commonDir) return undefined;
    const cfg = readSyncConfig(syncConfigPath(commonDir), nodeQueueFs);
    if (cfg.mode === 'off') return undefined;
    return {
      repoRoot,
      ref: cfg.ref,
      remote: cfg.mode === 'github' ? cfg.remote : undefined,
      indexFile: path.join(repoRoot, '.taskwright', 'board.index'),
      backlogDir: 'backlog',
    };
  } catch {
    return undefined;
  }
}

/**
 * Claim a task for the current user, recording the active branch as worktree.
 * If the task already holds a live claim by someone else, the user is asked to
 * confirm before overriding (claims are advisory). A stale claim — older than
 * the configured window — is overridden without friction. Returns the written
 * claim, or undefined if the user declined the override.
 *
 * When board sync is on, the claim routes through the collision-proof engine
 * instead: a live foreign claim causes a surrender (with a notice), never an
 * override, because the atomic push is what guarantees no double-claim.
 */
export async function claimTaskForCurrentUser(
  taskId: string,
  parser: BacklogParser,
  opts: { force?: boolean } = {}
): Promise<Claim | undefined> {
  const identity = getClaimIdentity();

  // Dependency gate (human-overridable). Skipped when force is set.
  if (!opts.force) {
    try {
      const states = await loadTreeStateFromParser(parser);
      const derived = states.get(taskId.trim().toUpperCase());
      if (derived?.locked) {
        const choice = await vscode.window.showWarningMessage(
          blockedByMessage(taskId, derived.blockedBy),
          { modal: true },
          'Force claim'
        );
        if (choice !== 'Force claim') return undefined;
      }
    } catch {
      // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
    }
  }

  const syncTarget = await resolveSyncTarget(parser);
  if (syncTarget) {
    const worktree = await currentBranch(parser);
    const outcome = await claimTaskSynced(syncTarget, taskId, identity, {
      worktree,
      stalenessMs: getClaimStalenessMs() || undefined,
    });
    if (outcome.status === 'claimed') return outcome.claim;
    if (outcome.status === 'surrendered') {
      void vscode.window.showWarningMessage(
        `${taskId} is already claimed by ${outcome.by} — the synced board keeps a single owner.`
      );
      return undefined;
    }
    void vscode.window.showErrorMessage(`Could not claim ${taskId}: ${outcome.reason}`);
    return undefined;
  }

  const existing = await parser.getTask(taskId);
  const action = resolveClaimAction(
    { claimedBy: existing?.claimedBy, claimedAt: existing?.claimedAt },
    identity,
    getClaimStalenessMs()
  );
  if (action === 'conflict') {
    const choice = await vscode.window.showWarningMessage(
      `${taskId} is already claimed by ${existing?.claimedBy}${
        existing?.worktree ? ` on ${existing.worktree}` : ''
      }. Override the claim?`,
      { modal: true },
      'Override'
    );
    if (choice !== 'Override') return undefined;
  }
  const worktree = await currentBranch(parser);
  return claimService.claimTask(taskId, identity, parser, { worktree });
}

/** Release any claim on a task (routes through the sync engine when sync is on). */
export async function releaseTaskClaim(taskId: string, parser: BacklogParser): Promise<void> {
  const syncTarget = await resolveSyncTarget(parser);
  if (syncTarget) {
    await releaseTaskSynced(syncTarget, taskId);
    return;
  }
  await claimService.releaseTask(taskId, parser);
}
