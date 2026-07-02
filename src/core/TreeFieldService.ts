import * as fs from 'fs';
import { BacklogParser } from './BacklogParser';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import { removeField, upsertScalarField } from './frontmatterEdit';

/**
 * File-backed read/write of the Taskwright-only tech-tree fields `category` and
 * `caused_by`. Like claims and the superpowers `plan` link, these are written
 * **surgically** through frontmatterEdit so Backlog.md's canonical frontmatter
 * round-trips byte-for-byte. Line endings are preserved (CRLF-safe).
 */
export class TreeFieldService {
  /** Set (or replace) the task's lane category. Returns the stored (trimmed) value. */
  async setCategory(taskId: string, category: string, parser: BacklogParser): Promise<string> {
    const value = category.trim();
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => upsertScalarField(content, 'category', value), parser);
    return value;
  }

  /** Remove the lane category. Idempotent. */
  async clearCategory(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'category'), parser);
  }

  /** Set (or replace) the bug's `caused_by` reference. Returns the stored (trimmed) value. */
  async setCausedBy(taskId: string, causedBy: string, parser: BacklogParser): Promise<string> {
    const value = causedBy.trim();
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => upsertScalarField(content, 'caused_by', value), parser);
    return value;
  }

  /** Remove the `caused_by` reference. Idempotent. */
  async clearCausedBy(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'caused_by'), parser);
  }

  /** Surgically remove the `type` field (clears a bug back to a plain task). Idempotent. */
  async clearType(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'type'), parser);
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
    fs.writeFileSync(filePath, restoreLineEndings(updated, hasCRLF), 'utf-8');
    parser.invalidateTaskCache(filePath);
  }
}
