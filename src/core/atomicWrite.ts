import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Board Sync v2 (spec §2.1) — every worktree now writes the *same* physical
 * task/document files, so a concurrent reader (another agent's session, a
 * `BacklogParser` directory scan, `git status`) is far more likely to observe
 * one mid-write than under the old per-worktree-copy model. Write-temp-then-
 * rename makes each write appear atomically: readers see either the old
 * content or the new content in full, never a partial write.
 *
 * The temp name is unique per call (pid + random suffix) so two concurrent
 * writers targeting the same destination never clobber each other's in-flight
 * temp file; the final `rename` is still last-writer-wins between them, which
 * is an accepted tradeoff — advisory claims, not this helper, are what guard
 * against two agents editing the same task at once.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}
