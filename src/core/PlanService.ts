import * as fs from 'fs';
import { BacklogParser } from './BacklogParser';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import { removeField, upsertScalarField } from './frontmatterEdit';
import { atomicWriteFileSync } from './atomicWrite';

/**
 * File-backed read/write of a task's `plan` link — the superpowers bridge field
 * pointing at the task's implementation plan/spec
 * (`docs/superpowers/plans/*.md`). Like claims, it is a Taskwright-only field
 * written **surgically**, so Backlog.md's canonical frontmatter round-trips
 * byte-for-byte. Line endings are preserved.
 */
export class PlanService {
  /**
   * Attach (or replace) the plan link on a task. The path is normalized to use
   * forward slashes for cross-platform stability. Returns the stored value.
   */
  async attachPlan(taskId: string, planPath: string, parser: BacklogParser): Promise<string> {
    const normalized = planPath.trim().replace(/\\/g, '/');
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => upsertScalarField(content, 'plan', normalized), parser);
    return normalized;
  }

  /** Remove the plan link from a task. Idempotent. */
  async detachPlan(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'plan'), parser);
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
