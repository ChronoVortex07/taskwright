import * as fs from 'fs';
import { BacklogParser } from './BacklogParser';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import { applyClaim, clearClaim, claimTimestamp, Claim } from './claims';
import { atomicWriteFileSync } from './atomicWrite';

/** Options for placing a claim. */
export interface ClaimTaskOptions {
  /** Branch or worktree the claimant is working in. */
  worktree?: string;
  /** Injectable clock for deterministic timestamps (tests). */
  now?: Date;
}

/**
 * File-backed bridge between the pure {@link applyClaim}/{@link clearClaim}
 * helpers and task files on disk.
 *
 * Claims are Taskwright-only fields, so — unlike the rest of a task, which is
 * written through the `backlog` CLI / {@link BacklogWriter} full-rewrite path —
 * they are edited **surgically**: only the `claimed_by` / `worktree` /
 * `claimed_at` lines change, leaving Backlog.md's canonical frontmatter to
 * round-trip byte-for-byte. Line endings are preserved.
 */
export class ClaimService {
  /**
   * Claim a task for `claimedBy`. Replaces any existing claim. Returns the
   * claim that was written.
   */
  async claimTask(
    taskId: string,
    claimedBy: string,
    parser: BacklogParser,
    options: ClaimTaskOptions = {}
  ): Promise<Claim> {
    const filePath = await this.resolveFilePath(taskId, parser);
    const claim: Claim = {
      claimedBy,
      worktree: options.worktree,
      claimedAt: claimTimestamp(options.now ?? new Date()),
    };
    this.rewrite(filePath, (content) => applyClaim(content, claim), parser);
    return claim;
  }

  /** Release any claim on a task. Idempotent. */
  async releaseTask(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, clearClaim, parser);
  }

  private async resolveFilePath(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task.filePath;
  }

  private rewrite(
    filePath: string,
    transform: (content: string) => string,
    parser: BacklogParser
  ): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const hasCRLF = detectCRLF(raw);
    const updated = transform(normalizeToLF(raw));
    atomicWriteFileSync(filePath, restoreLineEndings(updated, hasCRLF));
    parser.invalidateTaskCache(filePath);
  }
}
