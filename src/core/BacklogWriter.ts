import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { Milestone, Task, TaskStatus } from './types';
import { BacklogParser } from './BacklogParser';
import { atomicWriteFileSync } from './atomicWrite';
import { quoteValue } from './frontmatterEdit';

/**
 * Taskwright-only surgical fields that must serialize as a SINGLE line.
 * claims.ts / frontmatterEdit.ts edit these line-wise; js-yaml (lineWidth 80)
 * would fold a long value into a `>-` block scalar whose indented continuation
 * a line-wise removal could orphan onto the next field (TASK-89).
 */
const SINGLE_LINE_FIELD_RE = /^(claimed_by|worktree|claimed_at|plan): ([>|][+-]?)$/;

/**
 * Collapse folded/literal block scalars of Taskwright surgical fields back to
 * one `key: value` line inside the serialized document's frontmatter. Folded
 * lines are re-joined with spaces (YAML folding semantics); other fields are
 * left byte-for-byte as the serializer emitted them.
 */
function collapseFoldedSurgicalFields(serialized: string): string {
  const lines = serialized.split('\n');
  if (lines[0]?.trim() !== '---') return serialized;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return serialized;
  const out: string[] = [lines[0]];
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(SINGLE_LINE_FIELD_RE);
    if (!match) {
      out.push(lines[i]);
      continue;
    }
    const parts: string[] = [];
    let j = i + 1;
    while (j < end && /^[ \t]+\S/.test(lines[j])) {
      parts.push(lines[j].trim());
      j++;
    }
    out.push(`${match[1]}: ${quoteValue(parts.join(' '))}`);
    i = j - 1;
  }
  out.push(...lines.slice(end));
  return out.join('\n');
}

/**
 * Compute an MD5 hash of file content for conflict detection
 */
export function computeContentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Detect whether content uses CRLF line endings.
 * Returns true if the content contains \r\n (CRLF).
 */
export function detectCRLF(content: string): boolean {
  return content.includes('\r\n');
}

/**
 * Normalize line endings to LF for internal processing.
 */
export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Restore CRLF line endings if the original content used them.
 */
export function restoreLineEndings(content: string, useCRLF: boolean): string {
  if (!useCRLF) return content;
  return content.replace(/\n/g, '\r\n');
}

/**
 * Produce a `created_date` / `updated_date` value in the upstream canonical
 * format (`YYYY-MM-DD HH:MM`, UTC). Matches Backlog.md CLI so round-trips
 * don't churn timestamps between tools.
 */
export function nowTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Does this id belong to the board's task namespace (i.e. carry the configured prefix)?
 *
 * This is the ONLY legacy-draft test in the codebase. It deliberately does not look for the
 * literal string 'DRAFT-': a board with a custom `task_prefix` must classify its own drafts as
 * stable, not legacy. Both `promoteDraft` and the draft-id migration (TASK-118) use this one
 * predicate — if they disagreed, a draft could be re-id'd by one and left in place by the other.
 */
export function idHasPrefix(id: string, taskPrefix: string): boolean {
  return new RegExp(`^${taskPrefix}-\\d+`, 'i').test(id.trim());
}

/**
 * Is this file path inside `archive/drafts/`?
 *
 * The parser flattens both archive subfolders to `folder: 'archive'`, so the path is the only
 * record of which side a task was archived from — and since TASK-115 the id cannot be asked (a
 * draft is a `TASK-N` too). Restore reads this, never the id.
 */
export function isArchivedDraftPath(filePath: string): boolean {
  return filePath.split(path.sep).join('/').includes('/archive/drafts/');
}

/** Is this file path inside either archive subfolder (`archive/tasks/` or `archive/drafts/`)? */
export function isArchivedPath(filePath: string): boolean {
  const posix = filePath.split(path.sep).join('/');
  return posix.includes('/archive/tasks/') || posix.includes('/archive/drafts/');
}

/**
 * Error thrown when a file has been modified externally
 */
export class FileConflictError extends Error {
  code = 'CONFLICT' as const;
  currentContent: string;

  constructor(message: string, currentContent: string) {
    super(message);
    this.name = 'FileConflictError';
    this.currentContent = currentContent;
  }
}

/**
 * Options for creating a new task
 */
export interface CreateTaskOptions {
  title: string;
  description?: string;
  status?: TaskStatus;
  /** Config-driven: any of the board's configured priorities (validated by the MCP layer). */
  priority?: string;
  labels?: string[];
  milestone?: string;
  assignee?: string[];
}

/**
 * Raw frontmatter structure for YAML serialization
 */
interface FrontmatterData {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
  milestone?: string;
  labels?: string[];
  assignee?: string[];
  reporter?: string;
  dependencies?: string[];
  references?: string[];
  documentation?: string[];
  type?: string;
  parent_task_id?: string;
  subtasks?: string[];
  created_date?: string;
  updated_date?: string;
  ordinal?: number;
  [key: string]: unknown;
}

/**
 * Writes changes back to Backlog.md task files
 */
export class BacklogWriter {
  /**
   * Every folder a task id can live in. A task id must be unique across ALL of them:
   * scanning only `tasks/` is why a restore from `archive/` could land on a live task's id,
   * and — once drafts mint from this same counter — why a draft could collide with a task.
   */
  private static readonly ID_SCAN_DIRS: readonly string[] = [
    'tasks',
    'drafts',
    'completed',
    path.join('archive', 'tasks'),
    path.join('archive', 'drafts'),
  ];

  /**
   * Create a new milestone file in backlog/milestones.
   * Mirrors upstream ID allocation semantics by scanning both active and archived milestone files.
   */
  async createMilestone(
    backlogPath: string,
    title: string,
    description?: string,
    parser?: BacklogParser
  ): Promise<Milestone> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error('Milestone title is required');
    }

    const existingMilestones = parser ? await parser.getMilestones() : [];
    const requestedKeys = this.buildMilestoneIdentifierKeys(normalizedTitle);
    const duplicate = existingMilestones.find((milestone) => {
      const milestoneKeys = new Set<string>([
        ...this.buildMilestoneIdentifierKeys(milestone.id),
        ...this.buildMilestoneIdentifierKeys(milestone.name),
      ]);
      for (const key of requestedKeys) {
        if (milestoneKeys.has(key)) {
          return true;
        }
      }
      return false;
    });
    if (duplicate) {
      throw new Error('A milestone with this title or ID already exists');
    }

    const milestonesDir = path.join(backlogPath, 'milestones');
    const archivedMilestonesDir = path.join(backlogPath, 'archive', 'milestones');
    if (!fs.existsSync(milestonesDir)) {
      fs.mkdirSync(milestonesDir, { recursive: true });
    }
    const nextIdNumber = this.getNextMilestoneId(milestonesDir, archivedMilestonesDir);
    const id = `m-${nextIdNumber}`;
    const safeTitle = this.sanitizeMilestoneTitle(normalizedTitle);
    const filename = `${id} - ${safeTitle}.md`;
    const filePath = path.join(milestonesDir, filename);
    const milestoneDescription = description?.trim() || `Milestone: ${normalizedTitle}`;

    const frontmatter: FrontmatterData = { id, title: normalizedTitle };
    const body = `\n## Description\n\n${milestoneDescription}\n`;
    const content = this.reconstructFile(frontmatter, body);
    atomicWriteFileSync(filePath, content);

    return { id, name: normalizedTitle, description: milestoneDescription };
  }

  /**
   * Delete a milestone file from disk.
   */
  async deleteMilestone(milestoneId: string, parser: BacklogParser): Promise<void> {
    const milestones = await parser.getMilestones();
    const milestone = milestones.find((m) => m.id.toLowerCase() === milestoneId.toLowerCase());
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const milestonesDir = path.join(parser.getBacklogPath(), 'milestones');
    const files = fs.existsSync(milestonesDir) ? fs.readdirSync(milestonesDir) : [];
    const file = files.find((f) => f.toLowerCase().startsWith(milestone.id.toLowerCase()));
    if (!file) {
      throw new Error(`Milestone file for ${milestoneId} not found`);
    }

    fs.unlinkSync(path.join(milestonesDir, file));
    parser.invalidateMilestoneCache();
  }

  /**
   * Archive a milestone file to archive/milestones/.
   */
  async archiveMilestone(milestoneId: string, parser: BacklogParser): Promise<void> {
    const milestones = await parser.getMilestones();
    const milestone = milestones.find((m) => m.id.toLowerCase() === milestoneId.toLowerCase());
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const backlogPath = parser.getBacklogPath();
    const milestonesDir = path.join(backlogPath, 'milestones');
    const archiveDir = path.join(backlogPath, 'archive', 'milestones');

    const files = fs.existsSync(milestonesDir) ? fs.readdirSync(milestonesDir) : [];
    const file = files.find((f) => f.toLowerCase().startsWith(milestone.id.toLowerCase()));
    if (!file) {
      throw new Error(`Milestone file for ${milestoneId} not found`);
    }

    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    fs.renameSync(path.join(milestonesDir, file), path.join(archiveDir, file));
    parser.invalidateMilestoneCache();
  }

  /**
   * Rename a milestone: updates the milestone file and all tasks referencing it.
   */
  async renameMilestone(
    milestoneId: string,
    newName: string,
    parser: BacklogParser
  ): Promise<void> {
    const milestones = await parser.getMilestones();
    const milestone = milestones.find((m) => m.id.toLowerCase() === milestoneId.toLowerCase());
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const backlogPath = parser.getBacklogPath();
    const milestonesDir = path.join(backlogPath, 'milestones');

    const files = fs.existsSync(milestonesDir) ? fs.readdirSync(milestonesDir) : [];
    const file = files.find((f) => f.toLowerCase().startsWith(milestone.id.toLowerCase()));
    if (!file) {
      throw new Error(`Milestone file for ${milestoneId} not found`);
    }

    const filePath = path.join(milestonesDir, file);
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);

    const oldName = milestone.name;
    frontmatter.title = newName.trim();
    const updatedContent = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);

    // Rename the milestone file
    const safeTitle = this.sanitizeMilestoneTitle(newName.trim());
    const newFileName = `${milestone.id} - ${safeTitle}.md`;
    const newFilePath = path.join(milestonesDir, newFileName);
    atomicWriteFileSync(newFilePath, updatedContent);
    if (newFilePath !== filePath) {
      fs.unlinkSync(filePath);
    }

    // Update all tasks that reference the old milestone name or ID
    const tasks = await parser.getTasks();
    for (const task of tasks) {
      if (
        task.milestone &&
        (task.milestone === oldName || task.milestone.toLowerCase() === milestone.id.toLowerCase())
      ) {
        await this.updateTask(task.id, { milestone: milestone.id }, parser);
      }
    }

    parser.invalidateMilestoneCache();
  }

  /**
   * Update a milestone's description.
   */
  async updateMilestone(
    milestoneId: string,
    updates: { title?: string; description?: string },
    parser: BacklogParser
  ): Promise<void> {
    const milestones = await parser.getMilestones();
    const milestone = milestones.find((m) => m.id.toLowerCase() === milestoneId.toLowerCase());
    if (!milestone) {
      throw new Error(`Milestone ${milestoneId} not found`);
    }

    const milestonesDir = path.join(parser.getBacklogPath(), 'milestones');
    const files = fs.existsSync(milestonesDir) ? fs.readdirSync(milestonesDir) : [];
    const file = files.find((f) => f.toLowerCase().startsWith(milestone.id.toLowerCase()));
    if (!file) {
      throw new Error(`Milestone file for ${milestoneId} not found`);
    }

    const filePath = path.join(milestonesDir, file);
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);

    if (updates.title) {
      frontmatter.title = updates.title.trim();
    }

    let updatedBody = body;
    if (updates.description !== undefined) {
      // Replace description section content
      const descRegex = /^## Description\n\n[\s\S]*$/m;
      if (descRegex.test(updatedBody)) {
        updatedBody = updatedBody.replace(
          /^(## Description\n\n)[\s\S]*$/m,
          `$1${updates.description}\n`
        );
      } else {
        updatedBody = `\n## Description\n\n${updates.description}\n`;
      }
    }

    const updatedContent = restoreLineEndings(
      this.reconstructFile(frontmatter, updatedBody),
      hasCRLF
    );
    atomicWriteFileSync(filePath, updatedContent);
    parser.invalidateMilestoneCache();
  }

  /**
   * Move a completed task to the completed/ folder
   */
  async completeTask(taskId: string, parser: BacklogParser): Promise<string> {
    const destinationPath = await this.moveTaskToFolder(taskId, 'completed', parser);
    await this.sanitizeArchivedTaskLinks(taskId, parser);
    return destinationPath;
  }

  /**
   * Archive a task (cancelled/duplicate). Routes by SOURCE FOLDER: a draft goes to
   * archive/drafts/, a task to archive/tasks/ — so restore can put it back where it came from
   * without ever reading the id. (archive/drafts/ has been scaffolded by initBacklog since the
   * beginning and nothing had ever written to it.)
   */
  async archiveTask(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const destFolder = task.folder === 'drafts' ? 'archive/drafts' : 'archive/tasks';
    const destinationPath = await this.moveTaskToFolder(taskId, destFolder, parser);
    await this.sanitizeArchivedTaskLinks(taskId, parser);
    return destinationPath;
  }

  /**
   * Restore an archived task to the folder it was archived FROM: archive/drafts/ → drafts/,
   * archive/tasks/ → tasks/.
   *
   * This replaces the last id-prefix branch in the codebase (`startsWith('DRAFT-')`), which could
   * not survive a draft being named TASK-112 (TASK-115). The folder is — and always was — the
   * draftness marker.
   */
  async restoreArchivedTask(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    // The parser reports both archive subfolders as folder 'archive', so inspect the path.
    const destFolder = isArchivedDraftPath(task.filePath) ? 'drafts' : 'tasks';
    return this.moveTaskToFolder(taskId, destFolder, parser);
  }

  /**
   * The next free task number, WITHOUT claiming it. The draft-id migration (TASK-118) plans a
   * whole batch of renames off one scan, so it needs to peek the counter rather than allocate.
   *
   * Unlike `createTask`/`createDraft` this takes no lock: the caller assigns ids sequentially
   * from here and writes them itself. It is therefore only safe when nothing else is minting
   * ids concurrently — which is the migration's contract (it runs under the board lock).
   */
  peekNextTaskId(backlogPath: string, prefix: string = 'task'): number {
    return this.getNextTaskId(backlogPath, prefix);
  }

  /**
   * Rename a task file and rewrite its frontmatter `id` IN PLACE, without moving it between
   * folders. The draft-id migration uses this to re-id a legacy `DRAFT-N` draft while it STAYS a
   * draft — a re-id is not a promotion, and only the human decides what gets promoted.
   *
   * Every other frontmatter field is preserved verbatim (status included — a Done draft stays
   * Done), and CRLF/LF is round-tripped, so the file remains byte-compatible with Backlog.md.
   */
  async reidTaskFile(
    fromPath: string,
    toPath: string,
    newId: string,
    parser: BacklogParser
  ): Promise<void> {
    if (path.resolve(fromPath) !== path.resolve(toPath)) {
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.renameSync(fromPath, toPath);
      parser.invalidateTaskCache(fromPath);
    }

    const rawContent = fs.readFileSync(toPath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);
    frontmatter.id = newId;
    frontmatter.updated_date = nowTimestamp();
    const updatedContent = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);
    atomicWriteFileSync(toPath, updatedContent);
    parser.invalidateTaskCache(toPath);
  }

  /**
   * Permanently delete a task file from disk
   */
  async deleteTask(taskId: string, parser: BacklogParser): Promise<void> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    fs.unlinkSync(task.filePath);
    parser.invalidateTaskCache(task.filePath);
  }

  /**
   * Promote a draft to a regular task.
   *
   * For a STABLE-ID draft (the normal case, since TASK-115) this is a PURE MOVE: drafts/ →
   * tasks/, id and status untouched. Nothing needs remapping because no id changed — that is
   * the whole point of minting task ids at draft creation, and it means a reference written
   * against a draft (structurally, or in prose) stays valid forever.
   *
   * LEGACY FALLBACK: a draft whose id does not carry the configured `task_prefix` (an old
   * DRAFT-N file, or one written by the upstream Backlog.md CLI) is re-id'd to a fresh TASK-M,
   * exactly as before. Callers that need inbound references rewritten for that case should go
   * through `promoteDrafts`, which runs `remapIds` when the id changes.
   */
  async promoteDraft(
    taskId: string,
    parser: BacklogParser,
    crossBranchIds?: string[]
  ): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const backlogPath = path.dirname(path.dirname(task.filePath));
    const destDir = path.join(backlogPath, 'tasks');

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const config = await parser.getConfig();
    const taskPrefix = config.task_prefix || 'TASK';
    const zeroPadding = config.zero_padded_ids || 0;
    const lowerPrefix = taskPrefix.toLowerCase();

    // The id only changes for a LEGACY draft — one outside the board's task namespace.
    const isLegacy = !idHasPrefix(task.id, taskPrefix);

    let newTaskId: string;
    let paddedId: string;
    if (isLegacy) {
      const nextId = this.getNextTaskId(backlogPath, taskPrefix, crossBranchIds);
      paddedId = zeroPadding > 0 ? String(nextId).padStart(zeroPadding, '0') : String(nextId);
      newTaskId = `${taskPrefix}-${paddedId}`.toUpperCase();
    } else {
      // Pure move: keep the id (and its existing zero padding) exactly as minted.
      newTaskId = task.id;
      paddedId = task.id.slice(task.id.lastIndexOf('-') + 1);
    }

    // Build new filename from task title
    const sanitizedTitle = (task.title || 'Untitled')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const newFileName = `${lowerPrefix}-${paddedId} - ${sanitizedTitle}.md`;
    const destPath = path.join(destDir, newFileName);

    // Move draft file to tasks/
    fs.renameSync(task.filePath, destPath);
    parser.invalidateTaskCache(task.filePath);

    // Update frontmatter: id (unchanged unless legacy), status, and updated_date
    const rawContent = fs.readFileSync(destPath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);
    frontmatter.id = newTaskId;
    // P6/D2d: preserve the draft's real status on promote — a Done draft promotes to a Done
    // task (drafts are orthogonal to status). Only a legacy/blank synthetic 'Draft' (which has
    // no real status to preserve) is reset to the board default.
    const rawStatus = String(frontmatter.status ?? '').trim();
    if (!rawStatus || rawStatus.toLowerCase() === 'draft') {
      frontmatter.status = config.default_status || 'To Do';
    }
    frontmatter.updated_date = nowTimestamp();
    const updatedContent = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);
    atomicWriteFileSync(destPath, updatedContent);
    parser.invalidateTaskCache(destPath);

    return newTaskId;
  }

  /**
   * Demote a task to a draft: a PURE MOVE from tasks/ to drafts/. The id and the status are
   * both preserved — the drafts/ folder is the provisional marker (P6/D2e), and the id is
   * stable for life (TASK-115). Nothing needs remapping because no id changed.
   *
   * (Before stable ids this re-id'd TASK-11 → DRAFT-9 and remapped nothing at all, so every
   * inbound `dependencies: [TASK-11]` dangled instantly. That bug is gone.)
   */
  async demoteTask(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const backlogPath = path.dirname(path.dirname(task.filePath));
    const destDir = path.join(backlogPath, 'drafts');

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const config = await parser.getConfig();
    const lowerPrefix = (config.task_prefix || 'TASK').toLowerCase();
    // Keep the id's numeric part verbatim, zero padding included.
    const numericPart = task.id.slice(task.id.lastIndexOf('-') + 1);

    // Build new filename from task title
    const sanitizedTitle = (task.title || 'Untitled')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const newFileName = `${lowerPrefix}-${numericPart} - ${sanitizedTitle}.md`;
    const destPath = path.join(destDir, newFileName);

    // Move task file to drafts/
    fs.renameSync(task.filePath, destPath);
    parser.invalidateTaskCache(task.filePath);

    // id and status are both preserved — only the timestamp moves.
    const rawContent = fs.readFileSync(destPath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);
    frontmatter.updated_date = nowTimestamp();
    const updatedContent = restoreLineEndings(this.reconstructFile(frontmatter, body), hasCRLF);
    atomicWriteFileSync(destPath, updatedContent);
    parser.invalidateTaskCache(destPath);

    return task.id;
  }

  /**
   * Move a task file to a destination folder
   */
  private async moveTaskToFolder(
    taskId: string,
    destFolder: string,
    parser: BacklogParser
  ): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Calculate destination path - go up from file to backlog root
    // Files in archive/tasks/ and archive/drafts/ are 3 levels deep, others are 2 levels deep
    const backlogPath = isArchivedPath(task.filePath)
      ? path.dirname(path.dirname(path.dirname(task.filePath))) // backlog/archive/<sub>/file -> backlog/
      : path.dirname(path.dirname(task.filePath)); // backlog/tasks/file -> backlog/
    const destDir = path.join(backlogPath, destFolder);
    const fileName = path.basename(task.filePath);
    const destPath = path.join(destDir, fileName);

    // Ensure destination directory exists
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Move the file
    fs.renameSync(task.filePath, destPath);
    parser.invalidateTaskCache(task.filePath);
    parser.invalidateTaskCache(destPath);

    return destPath;
  }

  /**
   * After archiving a task, remove its ID from dependencies and exact-ID references
   * in active tasks to mirror upstream cleanup semantics.
   */
  private async sanitizeArchivedTaskLinks(taskId: string, parser: BacklogParser): Promise<void> {
    const activeTasks = await parser.getTasks();

    for (const activeTask of activeTasks) {
      const existingDependencies = activeTask.dependencies ?? [];
      const existingReferences = activeTask.references ?? [];

      const nextDependencies = existingDependencies.filter(
        (dependencyId) => !this.areTaskIdsEqual(dependencyId, taskId)
      );
      const nextReferences = existingReferences.filter(
        (reference) => !this.areTaskIdsEqual(reference, taskId)
      );

      const dependenciesChanged = existingDependencies.length !== nextDependencies.length;
      const referencesChanged = existingReferences.length !== nextReferences.length;

      if (!dependenciesChanged && !referencesChanged) {
        continue;
      }

      await this.updateTask(
        activeTask.id,
        {
          dependencies: nextDependencies,
          references: nextReferences,
        },
        parser
      );
    }
  }

  private areTaskIdsEqual(left: string, right: string): boolean {
    return left.trim().toUpperCase() === right.trim().toUpperCase();
  }

  /**
   * Update a task's status in its file
   */
  async updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    parser: BacklogParser
  ): Promise<void> {
    await this.updateTask(taskId, { status: newStatus }, parser);
  }

  /**
   * Update a task with partial changes
   * @param taskId - The ID of the task to update
   * @param updates - Partial task fields to update
   * @param parser - BacklogParser instance
   * @param expectedHash - Optional hash of the file content when it was loaded.
   *                       If provided, the update will fail with FileConflictError
   *                       if the file has been modified externally.
   */
  async updateTask(
    taskId: string,
    updates: Partial<Task>,
    parser: BacklogParser,
    expectedHash?: string
  ): Promise<void> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const rawContent = fs.readFileSync(task.filePath, 'utf-8');

    // Conflict detection: if expectedHash is provided, verify file hasn't changed
    if (expectedHash) {
      const currentHash = computeContentHash(rawContent);
      if (currentHash !== expectedHash) {
        throw new FileConflictError('File has been modified externally', rawContent);
      }
    }

    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);

    const { frontmatter, body } = this.extractFrontmatter(content);

    // Apply updates to frontmatter
    if (updates.status !== undefined) {
      frontmatter.status = updates.status;
    }
    if (updates.priority !== undefined) {
      frontmatter.priority = updates.priority;
    }
    if (updates.title !== undefined) {
      frontmatter.title = updates.title;
    }
    if (updates.labels !== undefined) {
      frontmatter.labels = updates.labels;
    }
    if (updates.milestone !== undefined) {
      frontmatter.milestone = updates.milestone;
    }
    if (updates.assignee !== undefined) {
      frontmatter.assignee = updates.assignee;
    }
    if (updates.dependencies !== undefined) {
      frontmatter.dependencies = updates.dependencies;
    }
    if (updates.references !== undefined) {
      frontmatter.references = updates.references;
    }
    if (updates.documentation !== undefined) {
      frontmatter.documentation = updates.documentation;
    }
    // parent_task_id / subtasks round-trip through updateTask so the id-remap core (idRemap.ts)
    // can repoint hierarchy references; both are already in FRONTMATTER_FIELD_ORDER and are
    // omitted when empty.
    if (updates.parentTaskId !== undefined) {
      frontmatter.parent_task_id = updates.parentTaskId;
    }
    if (updates.subtasks !== undefined) {
      frontmatter.subtasks = updates.subtasks;
    }
    if (updates.type !== undefined) {
      frontmatter.type = updates.type;
    }
    if (updates.reporter !== undefined) {
      frontmatter.reporter = updates.reporter;
    }
    if (updates.ordinal !== undefined) {
      frontmatter.ordinal = updates.ordinal;
    }

    // Update the updated_date
    frontmatter.updated_date = nowTimestamp();

    // Handle body updates (description, AC, DoD are stored in body, not frontmatter)
    let updatedBody = body;
    if (updates.description !== undefined) {
      updatedBody = this.updateDescriptionInBody(updatedBody, updates.description);
    }
    if ((updates as Record<string, unknown>).acceptanceCriteria !== undefined) {
      updatedBody = this.updateChecklistInBody(
        updatedBody,
        'acceptanceCriteria',
        String((updates as Record<string, unknown>).acceptanceCriteria)
      );
    }
    if ((updates as Record<string, unknown>).definitionOfDone !== undefined) {
      updatedBody = this.updateChecklistInBody(
        updatedBody,
        'definitionOfDone',
        String((updates as Record<string, unknown>).definitionOfDone)
      );
    }
    if (updates.implementationPlan !== undefined) {
      updatedBody = this.updateStructuredSectionInBody(
        updatedBody,
        'implementationPlan',
        updates.implementationPlan
      );
    }
    if (updates.implementationNotes !== undefined) {
      updatedBody = this.updateStructuredSectionInBody(
        updatedBody,
        'implementationNotes',
        updates.implementationNotes
      );
    }
    if (updates.finalSummary !== undefined) {
      updatedBody = this.updateStructuredSectionInBody(
        updatedBody,
        'finalSummary',
        updates.finalSummary
      );
    }

    // Reconstruct the file, preserving original line endings
    const updatedContent = restoreLineEndings(
      this.reconstructFile(frontmatter, updatedBody),
      hasCRLF
    );
    atomicWriteFileSync(task.filePath, updatedContent);
    parser.invalidateTaskCache(task.filePath);
  }

  /**
   * Create a new task file
   * @param backlogPath - Path to the backlog directory
   * @param options - Task creation options
   * @param parser - Optional parser to read config for task_prefix
   */
  async createTask(
    backlogPath: string,
    options: CreateTaskOptions,
    parser?: BacklogParser,
    crossBranchIds?: string[]
  ): Promise<{ id: string; filePath: string }> {
    const tasksDir = path.join(backlogPath, 'tasks');

    // Ensure tasks directory exists
    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }

    // Get config for prefix, padding, and defaults
    const config = parser ? await parser.getConfig() : {};
    const taskPrefix = config.task_prefix || 'TASK';
    const zeroPadding = config.zero_padded_ids || 0;
    const lowerPrefix = taskPrefix.toLowerCase();

    // Scan the WHOLE board for the next likely id (considering cross-branch IDs to avoid
    // collisions), then claim it atomically under the shared lock namespace: two concurrent
    // creates can both scan before either has written (DRAFT-25) — allocateAndWrite retries
    // the next candidate instead of colliding.
    const scannedId = this.getNextTaskId(backlogPath, taskPrefix, crossBranchIds);

    return this.allocateAndWrite(
      backlogPath,
      scannedId,
      (id) => `.${lowerPrefix}-${id}.lock`,
      (id) => {
        const paddedId = zeroPadding > 0 ? String(id).padStart(zeroPadding, '0') : String(id);
        const taskId = `${taskPrefix}-${paddedId}`.toUpperCase();

        // Sanitize title for filename
        const sanitizedTitle = options.title
          .replace(/[^a-zA-Z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .substring(0, 50);
        const fileName = `${lowerPrefix}-${paddedId} - ${sanitizedTitle}.md`;
        const filePath = path.join(tasksDir, fileName);

        // Build frontmatter with config defaults
        const frontmatter: FrontmatterData = {
          id: taskId,
          title: options.title,
          status: options.status || config.default_status || 'To Do',
          priority: options.priority,
          labels: options.labels || [],
          milestone: options.milestone,
          assignee: options.assignee || (config.default_assignee ? [config.default_assignee] : []),
          reporter: config.default_reporter,
          dependencies: [],
          created_date: nowTimestamp(),
          updated_date: nowTimestamp(),
        };

        // Remove undefined values
        Object.keys(frontmatter).forEach((key) => {
          if (frontmatter[key] === undefined) {
            delete frontmatter[key];
          }
        });

        // Build body
        let body = '\n## Description\n\n';
        if (options.description) {
          body += `<!-- SECTION:DESCRIPTION:BEGIN -->\n${options.description}\n<!-- SECTION:DESCRIPTION:END -->\n`;
        } else {
          body += '<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n';
        }
        body += '\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n';

        const content = this.reconstructFile(frontmatter, body);
        return { filePath, content, result: { id: taskId, filePath } };
      }
    );
  }

  /**
   * Create a new draft file in the drafts/ directory.
   *
   * The draft carries a REAL task id (TASK-N) from birth (TASK-115), minted from the same
   * shared counter as `createTask` — so promoting it never changes its id, and a reference
   * written against it (in a spec, a handoff, another task's `dependencies`) stays valid
   * forever. The drafts/ FOLDER is the provisional marker, which it already was everywhere in
   * the codebase; the id says nothing about draftness and no `draft:` field is written.
   *
   * `opts` lets callers seed the title and description; both default to the empty/"Untitled"
   * form so existing callers are unaffected. `opts.status` sets the draft's real status
   * (P6/D2b — drafts are status-carrying); it defaults to `config.default_status ?? 'To Do'`
   * (resolved via `parser`) when unspecified.
   */
  async createDraft(
    backlogPath: string,
    parser?: BacklogParser,
    opts?: { title?: string; description?: string; status?: string },
    crossBranchIds?: string[]
  ): Promise<{ id: string; filePath: string }> {
    const draftsDir = path.join(backlogPath, 'drafts');
    if (!fs.existsSync(draftsDir)) {
      fs.mkdirSync(draftsDir, { recursive: true });
    }

    const title = opts?.title?.trim() || 'Untitled';
    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);

    // P6/D2b: a draft carries a real status (the drafts/ folder is the provisional marker,
    // not a synthetic 'Draft'). Default to the board default when unspecified so authoring a
    // draft without a status, then promoting, is byte-identical to the pre-P6 flow.
    const config = parser ? await parser.getConfig() : undefined;
    const taskPrefix = config?.task_prefix || 'TASK';
    const zeroPadding = config?.zero_padded_ids || 0;
    const lowerPrefix = taskPrefix.toLowerCase();
    const status = opts?.status?.trim() || config?.default_status || 'To Do';

    // Scan the WHOLE board for the next id (drafts mint from the TASK counter now), then claim
    // it atomically in the board's SHARED lock namespace: two concurrent creates can both scan
    // before either has written (DRAFT-25) — allocateAndWrite retries the next candidate.
    //
    // The lock NAME below is identical to createTask's (`.${lowerPrefix}-${id}.lock`), and it
    // lives in createTask's directory (backlog/.locks/). Both halves are load-bearing: sharing
    // the counter while keeping a private `.draft-N.lock` name would leave the two writers
    // non-contending and re-arm the TASK-48 clobber — each would win its own lock and both
    // would write id N.
    const scannedId = this.getNextTaskId(backlogPath, taskPrefix, crossBranchIds);

    return this.allocateAndWrite(
      backlogPath,
      scannedId,
      (id) => `.${lowerPrefix}-${id}.lock`,
      (id) => {
        const paddedId = zeroPadding > 0 ? String(id).padStart(zeroPadding, '0') : String(id);
        const draftId = `${taskPrefix}-${paddedId}`.toUpperCase();
        const fileName = `${lowerPrefix}-${paddedId} - ${sanitizedTitle}.md`;
        const filePath = path.join(draftsDir, fileName);

        const today = nowTimestamp();
        const frontmatter: FrontmatterData = {
          id: draftId,
          title,
          status,
          labels: [],
          assignee: [],
          dependencies: [],
          created_date: today,
          updated_date: today,
        };

        const descBlock = opts?.description
          ? `<!-- SECTION:DESCRIPTION:BEGIN -->\n${opts.description}\n<!-- SECTION:DESCRIPTION:END -->`
          : '<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->';
        const body = `\n## Description\n\n${descBlock}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n`;

        const content = this.reconstructFile(frontmatter, body);
        return { filePath, content, result: { id: draftId, filePath } };
      }
    );
  }

  /**
   * Atomically claim the next free numeric id under `dir` (starting from `startId`,
   * already scanned/adjusted by the caller) and write the real file for it — closing the
   * DRAFT-25 race where two concurrent creates both scan a stale max before either has
   * written and land on the same id under different (title-derived) filenames.
   *
   * Two guards, both keyed only by the numeric id (never the title-derived filename), make
   * the claim atomic at the filesystem level rather than relying on statement ordering:
   * `fs.mkdirSync` (no `recursive`) throws `EEXIST` if the lock dir already exists — this is
   * what actually prevents two different titles from landing on the same id — and the real
   * file is written with `wx`, guarding the (unlikely) case where that exact filename is
   * already taken. Either EEXIST bumps the candidate and retries; `buildFile` is re-invoked
   * per candidate so the id is baked into its frontmatter/filename.
   */
  private allocateAndWrite<T>(
    backlogPath: string,
    startId: number,
    lockDirName: (id: number) => string,
    buildFile: (id: number) => { filePath: string; content: string; result: T }
  ): T {
    // ONE shared lock namespace for the whole board. The lock dir used to live inside the
    // TARGET directory (tasks/.task-N.lock vs drafts/.draft-N.lock) — two namespaces that
    // could not see each other. Harmless while tasks and drafts had separate counters; a live
    // clobber race (the TASK-48 bug, re-armed) the moment they share one.
    //
    // `.locks/` is transient state at the backlog ROOT: BacklogParser only ever enumerates the
    // named board subfolders (tasks/drafts/completed/archive/*), and boardRef's BOARD_SUBDIRS
    // allow-list is what the sync ref snapshots and autoSync stages — so it is never parsed as
    // content and never committed.
    const locksDir = path.join(backlogPath, '.locks');
    if (!fs.existsSync(locksDir)) {
      fs.mkdirSync(locksDir, { recursive: true });
    }

    let candidate = startId;
    for (let attempts = 0; attempts < 10_000; attempts++) {
      const lockDir = path.join(locksDir, lockDirName(candidate));
      try {
        fs.mkdirSync(lockDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          candidate++;
          continue;
        }
        throw err;
      }

      const { filePath, content, result } = buildFile(candidate);
      try {
        fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          candidate++;
          continue;
        }
        throw err;
      }

      try {
        fs.rmdirSync(lockDir);
      } catch {
        // best-effort cleanup; a leftover lock dir only retires that one id number
      }
      return result;
    }
    throw new Error(`Could not allocate a unique id under ${backlogPath} after 10000 attempts`);
  }

  /**
   * Create a subtask under a parent task.
   * Uses dot-notation IDs (e.g., TASK-2.1, TASK-2.2).
   * Scans existing tasks to find the next sub-number, handling gaps.
   */
  async createSubtask(
    parentTaskId: string,
    backlogPath: string,
    parser?: BacklogParser,
    opts?: { title?: string; description?: string }
  ): Promise<{ id: string; filePath: string }> {
    const tasksDir = path.join(backlogPath, 'tasks');

    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }

    // Extract the numeric part from parent ID (e.g., "TASK-2" -> "2", "TASK-10" -> "10")
    const parentNumMatch = parentTaskId.match(/(\d+)$/);
    if (!parentNumMatch) {
      throw new Error(`Cannot extract numeric ID from parent: ${parentTaskId}`);
    }
    const parentNum = parentNumMatch[1];

    // Get task prefix from parent ID (e.g., "TASK-2" -> "TASK")
    const prefixMatch = parentTaskId.match(/^(.+)-\d+$/);
    const taskPrefix = prefixMatch ? prefixMatch[1] : 'TASK';
    const lowerPrefix = taskPrefix.toLowerCase();

    // Scan existing files for subtask numbering (prefix-N.M pattern)
    const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
    let maxSubId = 0;
    const subPattern = new RegExp(`^${lowerPrefix}-${parentNum}\\.(\\d+)`, 'i');
    for (const file of files) {
      const match = file.match(subPattern);
      if (match) {
        const subId = parseInt(match[1], 10);
        if (subId > maxSubId) maxSubId = subId;
      }
    }
    const nextSubId = maxSubId + 1;

    const taskId = `${taskPrefix}-${parentNum}.${nextSubId}`.toUpperCase();
    const title = opts?.title?.trim() || 'Untitled';
    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const fileName = `${lowerPrefix}-${parentNum}.${nextSubId} - ${sanitizedTitle}.md`;
    const filePath = path.join(tasksDir, fileName);

    // Get config defaults
    const config = parser ? await parser.getConfig() : {};

    const today = nowTimestamp();
    const frontmatter: FrontmatterData = {
      id: taskId,
      title,
      status: config.default_status || 'To Do',
      labels: [],
      assignee: config.default_assignee ? [config.default_assignee] : [],
      reporter: config.default_reporter,
      dependencies: [],
      parent_task_id: parentTaskId,
      created_date: today,
      updated_date: today,
    };

    // Remove undefined values
    Object.keys(frontmatter).forEach((key) => {
      if (frontmatter[key] === undefined) {
        delete frontmatter[key];
      }
    });

    const descBlock = opts?.description
      ? `<!-- SECTION:DESCRIPTION:BEGIN -->\n${opts.description}\n<!-- SECTION:DESCRIPTION:END -->`
      : '<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->';
    const body = `\n## Description\n\n${descBlock}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n`;

    const content = this.reconstructFile(frontmatter, body);
    atomicWriteFileSync(filePath, content);

    return { id: taskId, filePath };
  }

  /**
   * Get the next available task ID number, scanning EVERY folder a task id can occupy
   * (tasks, drafts, completed, archive) plus any cross-branch ids.
   *
   * Takes the BACKLOG ROOT, not a single directory — a single-directory scan is exactly the
   * bug this closes: `tasks/` alone left an archived task's id free to be re-minted, so
   * restoring it collided with a live task. Drafts are scanned for the same reason, since a
   * draft can carry a task id.
   *
   * The filename pattern is anchored on the configured `prefix`, so a legacy `draft-99 - X.md`
   * sitting in `drafts/` contributes nothing to the max and cannot collide.
   */
  private getNextTaskId(
    backlogPath: string,
    prefix: string = 'task',
    crossBranchIds?: string[]
  ): number {
    let maxId = 0;

    const pattern = new RegExp(`^${prefix}-(\\d+)`, 'i');
    for (const sub of BacklogWriter.ID_SCAN_DIRS) {
      const dir = path.join(backlogPath, sub);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      for (const file of files) {
        const match = file.match(pattern);
        if (match) {
          const id = parseInt(match[1], 10);
          if (id > maxId) {
            maxId = id;
          }
        }
      }
    }

    // Also check cross-branch task IDs to avoid collisions
    if (crossBranchIds) {
      const idPattern = new RegExp(`^${prefix}-(\\d+)$`, 'i');
      for (const taskId of crossBranchIds) {
        const match = taskId.match(idPattern);
        if (match) {
          const id = parseInt(match[1], 10);
          if (id > maxId) {
            maxId = id;
          }
        }
      }
    }

    return maxId + 1;
  }

  private getNextMilestoneId(milestonesDir: string, archivedMilestonesDir: string): number {
    const ids = [
      ...this.extractMilestoneIdsFromDirectory(milestonesDir),
      ...this.extractMilestoneIdsFromDirectory(archivedMilestonesDir),
    ];
    if (ids.length === 0) {
      return 0;
    }
    return Math.max(...ids) + 1;
  }

  private extractMilestoneIdsFromDirectory(dirPath: string): number[] {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const files = fs
      .readdirSync(dirPath)
      .filter(
        (file) => file.endsWith('.md') && /^m-\d+/i.test(file) && file.toLowerCase() !== 'readme.md'
      );

    const ids: number[] = [];
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let candidateId = '';

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter } = this.extractFrontmatter(content);
        candidateId = String(frontmatter.id || '')
          .trim()
          .toLowerCase();
      } catch {
        // candidateId remains '' from initialization
      }

      if (!candidateId) {
        const fallback = file.match(/^(m-\d+)/i)?.[1];
        candidateId = String(fallback || '').toLowerCase();
      }

      const match = candidateId.match(/^m-(\d+)$/i);
      if (!match?.[1]) {
        continue;
      }
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        ids.push(parsed);
      }
    }

    return ids;
  }

  private buildMilestoneIdentifierKeys(value: string): Set<string> {
    const normalized = value.trim().toLowerCase();
    const keys = new Set<string>();
    if (!normalized) {
      return keys;
    }

    keys.add(normalized);

    if (/^\d+$/.test(normalized)) {
      const numeric = String(Number.parseInt(normalized, 10));
      keys.add(numeric);
      keys.add(`m-${numeric}`);
      return keys;
    }

    const idMatch = normalized.match(/^m-(\d+)$/);
    if (idMatch?.[1]) {
      const numeric = String(Number.parseInt(idMatch[1], 10));
      keys.add(numeric);
      keys.add(`m-${numeric}`);
    }

    return keys;
  }

  private sanitizeMilestoneTitle(title: string): string {
    const sanitized = title
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 50);
    return sanitized || 'milestone';
  }

  /**
   * Update description content in the markdown body
   */
  private updateDescriptionInBody(body: string, newDescription: string): string {
    const beginMarker = '<!-- SECTION:DESCRIPTION:BEGIN -->';
    const endMarker = '<!-- SECTION:DESCRIPTION:END -->';

    const beginIndex = body.indexOf(beginMarker);
    const endIndex = body.indexOf(endMarker);

    if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
      // Replace content between markers
      const before = body.substring(0, beginIndex + beginMarker.length);
      const after = body.substring(endIndex);
      return `${before}\n${newDescription}\n${after}`;
    }

    // No markers found - look for ## Description section and add markers
    const descriptionHeaderRegex = /^## Description\s*$/m;
    const match = body.match(descriptionHeaderRegex);

    if (match && match.index !== undefined) {
      // Find the next section header or end of file
      const afterHeader = body.substring(match.index + match[0].length);
      const nextSectionMatch = afterHeader.match(/^## /m);
      const nextSectionIndex = nextSectionMatch?.index ?? afterHeader.length;

      const before = body.substring(0, match.index + match[0].length);
      const after = body.substring(match.index + match[0].length + nextSectionIndex);

      return `${before}\n\n${beginMarker}\n${newDescription}\n${endMarker}\n${after}`;
    }

    // No description section - add one after frontmatter
    return `\n## Description\n\n${beginMarker}\n${newDescription}\n${endMarker}\n${body}`;
  }

  /**
   * Update checklist content (AC or DoD) in the markdown body
   */
  private updateChecklistInBody(
    body: string,
    listType: 'acceptanceCriteria' | 'definitionOfDone',
    newContent: string
  ): string {
    const isAC = listType === 'acceptanceCriteria';
    const beginMarker = isAC ? '<!-- AC:BEGIN -->' : '<!-- DOD:BEGIN -->';
    const endMarker = isAC ? '<!-- AC:END -->' : '<!-- DOD:END -->';
    const sectionHeader = isAC ? '## Acceptance Criteria' : '## Definition of Done';

    const beginIndex = body.indexOf(beginMarker);
    const endIndex = body.indexOf(endMarker);

    if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
      // Replace content between markers
      const before = body.substring(0, beginIndex + beginMarker.length);
      const after = body.substring(endIndex);
      return `${before}\n${newContent}\n${after}`;
    }

    // No markers found — look for section header and add markers
    const headerRegex = new RegExp(
      `^${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm'
    );
    const match = body.match(headerRegex);

    if (match && match.index !== undefined) {
      const afterHeader = body.substring(match.index + match[0].length);
      const nextSectionMatch = afterHeader.match(/^## /m);
      const nextSectionIndex = nextSectionMatch?.index ?? afterHeader.length;

      const before = body.substring(0, match.index + match[0].length);
      const after = body.substring(match.index + match[0].length + nextSectionIndex);

      return `${before}\n${beginMarker}\n${newContent}\n${endMarker}\n${after}`;
    }

    // No section header — append new section
    return `${body}\n${sectionHeader}\n${beginMarker}\n${newContent}\n${endMarker}\n`;
  }

  private static readonly STRUCTURED_SECTIONS: Record<
    string,
    { title: string; markerId: string; headerVariants: RegExp }
  > = {
    implementationPlan: {
      title: 'Implementation Plan',
      markerId: 'PLAN',
      headerVariants: /^## (?:Implementation )?Plan\s*$/m,
    },
    implementationNotes: {
      title: 'Implementation Notes',
      markerId: 'NOTES',
      headerVariants: /^## (?:Implementation )?Notes\s*$/m,
    },
    finalSummary: {
      title: 'Final Summary',
      markerId: 'FINAL_SUMMARY',
      headerVariants: /^## (?:Final )?Summary\s*$/m,
    },
  };

  /**
   * Update a structured section (Implementation Plan, Notes, Final Summary) in the markdown body.
   * Uses the same 3-tier fallback as updateDescriptionInBody:
   *  1. Markers exist → replace between them
   *  2. Header exists but no markers → add markers around existing content
   *  3. Nothing exists → append new section
   */
  private updateStructuredSectionInBody(
    body: string,
    sectionKey: string,
    newContent: string
  ): string {
    const config = BacklogWriter.STRUCTURED_SECTIONS[sectionKey];
    if (!config) return body;

    const beginMarker = `<!-- SECTION:${config.markerId}:BEGIN -->`;
    const endMarker = `<!-- SECTION:${config.markerId}:END -->`;

    const beginIndex = body.indexOf(beginMarker);
    const endIndex = body.indexOf(endMarker);

    if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
      // Tier 1: Replace content between markers
      const before = body.substring(0, beginIndex + beginMarker.length);
      const after = body.substring(endIndex);
      return `${before}\n${newContent}\n${after}`;
    }

    // Tier 2: Header exists but no markers
    const match = body.match(config.headerVariants);
    if (match && match.index !== undefined) {
      const afterHeader = body.substring(match.index + match[0].length);
      const nextSectionMatch = afterHeader.match(/^## /m);
      const nextSectionIndex = nextSectionMatch?.index ?? afterHeader.length;

      const before = body.substring(0, match.index + match[0].length);
      const after = body.substring(match.index + match[0].length + nextSectionIndex);

      return `${before}\n\n${beginMarker}\n${newContent}\n${endMarker}\n${after}`;
    }

    // Tier 3: Nothing exists — append new section
    return `${body}\n## ${config.title}\n\n${beginMarker}\n${newContent}\n${endMarker}\n`;
  }

  /**
   * Toggle a checklist item
   */
  async toggleChecklistItem(
    taskId: string,
    listType: 'acceptanceCriteria' | 'definitionOfDone',
    itemId: number,
    parser: BacklogParser
  ): Promise<void> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const rawContent = fs.readFileSync(task.filePath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    let content = normalizeToLF(rawContent);

    // Find and toggle the specific checklist item by its #id.
    // This is in the markdown body, not YAML, so regex is appropriate here.
    const regex = new RegExp(`^(- \\[)([ xX])(\\]\\s*#${itemId}\\s+.*)$`, 'gm');
    const toggle = (_match: string, prefix: string, check: string, suffix: string) =>
      `${prefix}${check === ' ' ? 'x' : ' '}${suffix}`;

    // Scope the replace to the targeted section so that, e.g., toggling Acceptance
    // Criteria #1 never flips Definition of Done #1 (both lists number from #1).
    const range = this.findChecklistSectionRange(content, listType);
    if (range) {
      const before = content.slice(0, range.start);
      const section = content.slice(range.start, range.end);
      const after = content.slice(range.end);
      content = before + section.replace(regex, toggle) + after;
    } else {
      content = content.replace(regex, toggle);
    }

    atomicWriteFileSync(task.filePath, restoreLineEndings(content, hasCRLF));
    parser.invalidateTaskCache(task.filePath);
  }

  /**
   * Locate the body range that holds a given checklist's items, so a toggle can be
   * scoped to that section. Mirrors updateChecklistInBody's boundary logic:
   *  1. Between the AC/DOD BEGIN/END markers when present
   *  2. Otherwise from the section header to the next "## " heading (legacy files)
   *  3. Returns null when neither is found (caller falls back to whole-document)
   */
  private findChecklistSectionRange(
    content: string,
    listType: 'acceptanceCriteria' | 'definitionOfDone'
  ): { start: number; end: number } | null {
    const isAC = listType === 'acceptanceCriteria';
    const beginMarker = isAC ? '<!-- AC:BEGIN -->' : '<!-- DOD:BEGIN -->';
    const endMarker = isAC ? '<!-- AC:END -->' : '<!-- DOD:END -->';
    const sectionHeader = isAC ? '## Acceptance Criteria' : '## Definition of Done';

    const beginIndex = content.indexOf(beginMarker);
    const endIndex = content.indexOf(endMarker);
    if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
      return { start: beginIndex + beginMarker.length, end: endIndex };
    }

    const headerRegex = new RegExp(
      `^${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm'
    );
    const match = content.match(headerRegex);
    if (match && match.index !== undefined) {
      const start = match.index + match[0].length;
      const afterHeader = content.substring(start);
      const nextSectionMatch = afterHeader.match(/^## /m);
      const end = start + (nextSectionMatch?.index ?? afterHeader.length);
      return { start, end };
    }

    return null;
  }

  /**
   * Extract YAML frontmatter and body from file content
   */
  private extractFrontmatter(content: string): { frontmatter: FrontmatterData; body: string } {
    const lines = content.split('\n');

    if (lines[0]?.trim() !== '---') {
      // No frontmatter, return empty object and full content as body
      return { frontmatter: {}, body: content };
    }

    // Find closing ---
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        endIndex = i;
        break;
      }
    }

    if (endIndex === -1) {
      // Malformed frontmatter
      return { frontmatter: {}, body: content };
    }

    const frontmatterYaml = lines.slice(1, endIndex).join('\n');
    const body = lines.slice(endIndex + 1).join('\n');

    try {
      // Use JSON_SCHEMA to prevent date strings from being parsed as Date objects
      const frontmatter =
        (yaml.load(frontmatterYaml, { schema: yaml.JSON_SCHEMA }) as FrontmatterData) || {};
      return { frontmatter, body };
    } catch {
      return { frontmatter: {}, body: content };
    }
  }

  /**
   * Canonical field order covering tasks, decisions, and documents.
   * `date` sits before `status` so decisions (`id, title, date, status`) match
   * upstream exactly. `type` precedes `created_date` so documents
   * (`id, title, type, created_date, updated_date, tags`) also match.
   * Tasks have none of `type`/`date`/`tags`, so those slots are harmlessly
   * skipped and task order stays upstream-identical.
   */
  private static readonly FRONTMATTER_FIELD_ORDER: readonly string[] = [
    'id',
    'title',
    'type',
    'date',
    'status',
    'assignee',
    'reporter',
    'created_date',
    'updated_date',
    'labels',
    'milestone',
    'dependencies',
    'references',
    'documentation',
    'parent_task_id',
    'subtasks',
    'priority',
    'ordinal',
    'onStatusChange',
    'tags',
  ];

  /** Fields whose empty-array/empty-string value should be omitted entirely. */
  private static readonly FRONTMATTER_OMIT_IF_EMPTY: ReadonlySet<string> = new Set([
    'reporter',
    'updated_date',
    'milestone',
    'references',
    'documentation',
    'parent_task_id',
    'subtasks',
    'priority',
    'ordinal',
    'onStatusChange',
    'tags',
  ]);

  /**
   * Reconstruct file from frontmatter and body using gray-matter to match
   * upstream Backlog.md byte-for-byte: single-quoted strings (only when needed),
   * block-style arrays, and consistently quoted dates.
   *
   * Upstream only inserts a blank line between frontmatter and body in
   * `serializeTask`; `serializeDecision` and `serializeDocument` emit the
   * gray-matter default (single newline). Callers pass `blankLineAfterFrontmatter: false`
   * for decisions/documents to match that divergence.
   */
  private reconstructFile(
    frontmatter: FrontmatterData,
    body: string,
    opts: { blankLineAfterFrontmatter?: boolean } = {}
  ): string {
    const { blankLineAfterFrontmatter = true } = opts;
    const ordered = this.orderFrontmatter(frontmatter);
    // Strip leading newlines — upstream trims rawContent on parse so
    // matter.stringify controls exactly one newline before the body. Without
    // this, any pre-existing blank line would compound with the post-process
    // regex to produce a double blank line.
    const trimmedBody = body.replace(/^\n+/, '');
    // Keep Taskwright surgical fields single-line — js-yaml folds long values
    // into `>-` block scalars, which the surgical line-wise editors would
    // corrupt on removal (TASK-89).
    const serialized = collapseFoldedSurgicalFields(matter.stringify(trimmedBody, ordered));
    if (!blankLineAfterFrontmatter) return serialized;
    return serialized.replace(/^(---\n(?:.*\n)*?---)\n(?!$)/, '$1\n\n');
  }

  /**
   * Rebuild the frontmatter object in canonical field order and drop optional
   * empty values so the serializer emits fields in the same order as upstream.
   */
  private orderFrontmatter(frontmatter: FrontmatterData): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const order = BacklogWriter.FRONTMATTER_FIELD_ORDER;
    const omitIfEmpty = BacklogWriter.FRONTMATTER_OMIT_IF_EMPTY;

    const shouldSkip = (key: string, value: unknown): boolean => {
      if (value === undefined || value === null) return true;
      if (!omitIfEmpty.has(key)) return false;
      if (typeof value === 'string' && value.trim() === '') return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    };

    for (const key of order) {
      if (!(key in frontmatter)) continue;
      const value = frontmatter[key];
      if (shouldSkip(key, value)) continue;
      result[key] = value;
    }
    for (const key of Object.keys(frontmatter)) {
      if (order.includes(key)) continue;
      const value = frontmatter[key];
      if (shouldSkip(key, value)) continue;
      result[key] = value;
    }
    return result;
  }

  /**
   * Get the next available document ID number
   */
  private getNextDocId(docsDir: string): number {
    if (!fs.existsSync(docsDir)) return 1;
    const files = this.getMarkdownFilesRecursive(docsDir);
    let maxId = 0;
    for (const file of files) {
      const match = path.basename(file).match(/^doc-(\d+)/i);
      if (match) {
        const id = parseInt(match[1], 10);
        if (id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  }

  /**
   * Get the next available decision ID number
   */
  private getNextDecisionId(decisionsDir: string): number {
    if (!fs.existsSync(decisionsDir)) return 1;
    const files = fs.readdirSync(decisionsDir).filter((f) => f.endsWith('.md'));
    let maxId = 0;
    for (const file of files) {
      const match = file.match(/^decision-(\d+)/i);
      if (match) {
        const id = parseInt(match[1], 10);
        if (id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  }

  private getMarkdownFilesRecursive(dirPath: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.getMarkdownFilesRecursive(fullPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  /**
   * Create a new document in backlog/docs/
   */
  async createDocument(
    backlogPath: string,
    title: string,
    options?: { type?: string; tags?: string[]; content?: string }
  ): Promise<{ id: string; filePath: string }> {
    const docsDir = path.join(backlogPath, 'docs');
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    const nextId = this.getNextDocId(docsDir);
    const paddedId = String(nextId).padStart(3, '0');
    const docId = `doc-${paddedId}`;

    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const fileName = `${docId} - ${sanitizedTitle}.md`;
    const filePath = path.join(docsDir, fileName);

    const today = nowTimestamp();
    const frontmatter: FrontmatterData = {
      id: docId.toUpperCase(),
      title,
      type: options?.type || 'other',
      created_date: today,
      updated_date: today,
    };
    if (options?.tags && options.tags.length > 0) {
      frontmatter['tags'] = options.tags;
    }

    const body = `\n${options?.content || ''}\n`;
    const content = this.reconstructFile(frontmatter, body, { blankLineAfterFrontmatter: false });
    atomicWriteFileSync(filePath, content);

    return { id: docId.toUpperCase(), filePath };
  }

  /**
   * Update an existing document
   */
  async updateDocument(
    docId: string,
    updates: { title?: string; content?: string; type?: string; tags?: string[] },
    parser: BacklogParser
  ): Promise<void> {
    const doc = await parser.getDocument(docId);
    if (!doc) {
      throw new Error(`Document ${docId} not found`);
    }

    const rawContent = fs.readFileSync(doc.filePath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);

    if (updates.title !== undefined) frontmatter.title = updates.title;
    if (updates.type !== undefined) frontmatter.type = updates.type;
    if (updates.tags !== undefined) frontmatter['tags'] = updates.tags;
    frontmatter.updated_date = nowTimestamp();

    const updatedBody = updates.content !== undefined ? `\n${updates.content}\n` : body;
    const updatedContent = restoreLineEndings(
      this.reconstructFile(frontmatter, updatedBody, { blankLineAfterFrontmatter: false }),
      hasCRLF
    );
    atomicWriteFileSync(doc.filePath, updatedContent);
  }

  /**
   * Delete a document
   */
  async deleteDocument(docId: string, parser: BacklogParser): Promise<void> {
    const doc = await parser.getDocument(docId);
    if (!doc) {
      throw new Error(`Document ${docId} not found`);
    }
    fs.unlinkSync(doc.filePath);
  }

  /**
   * Create a new decision in backlog/decisions/
   */
  async createDecision(
    backlogPath: string,
    title: string,
    options?: {
      status?: string;
      context?: string;
      decision?: string;
      consequences?: string;
      alternatives?: string;
    }
  ): Promise<{ id: string; filePath: string }> {
    const decisionsDir = path.join(backlogPath, 'decisions');
    if (!fs.existsSync(decisionsDir)) {
      fs.mkdirSync(decisionsDir, { recursive: true });
    }

    const nextId = this.getNextDecisionId(decisionsDir);
    const paddedId = String(nextId).padStart(3, '0');
    const decisionId = `decision-${paddedId}`;

    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const fileName = `${decisionId} - ${sanitizedTitle}.md`;
    const filePath = path.join(decisionsDir, fileName);

    const today = nowTimestamp();
    const frontmatter: FrontmatterData = {
      id: decisionId.toUpperCase(),
      title,
      ['date']: today,
      status: options?.status || 'proposed',
    };

    let body = '';
    body += `\n## Context\n\n${options?.context || ''}\n`;
    body += `\n## Decision\n\n${options?.decision || ''}\n`;
    body += `\n## Consequences\n\n${options?.consequences || ''}\n`;
    body += `\n## Alternatives\n\n${options?.alternatives || ''}\n`;

    const content = this.reconstructFile(frontmatter, body, { blankLineAfterFrontmatter: false });
    atomicWriteFileSync(filePath, content);

    return { id: decisionId.toUpperCase(), filePath };
  }

  /**
   * Update an existing decision
   */
  async updateDecision(
    decisionId: string,
    updates: {
      title?: string;
      status?: string;
      context?: string;
      decision?: string;
      consequences?: string;
      alternatives?: string;
    },
    parser: BacklogParser
  ): Promise<void> {
    const dec = await parser.getDecision(decisionId);
    if (!dec) {
      throw new Error(`Decision ${decisionId} not found`);
    }

    const rawContent = fs.readFileSync(dec.filePath, 'utf-8');
    const hasCRLF = detectCRLF(rawContent);
    const content = normalizeToLF(rawContent);
    const { frontmatter, body } = this.extractFrontmatter(content);

    if (updates.title !== undefined) frontmatter.title = updates.title;
    if (updates.status !== undefined) frontmatter.status = updates.status;

    // Update sections in body
    let updatedBody = body;
    const sections: Record<string, string | undefined> = {
      Context: updates.context,
      Decision: updates.decision,
      Consequences: updates.consequences,
      Alternatives: updates.alternatives,
    };

    for (const [sectionName, sectionContent] of Object.entries(sections)) {
      if (sectionContent === undefined) continue;
      const sectionRegex = new RegExp(`(## ${sectionName}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'g');
      if (sectionRegex.test(updatedBody)) {
        updatedBody = updatedBody.replace(
          new RegExp(`(## ${sectionName}\\n\\n)[\\s\\S]*?(?=\\n## |$)`),
          `$1${sectionContent}\n`
        );
      } else {
        updatedBody += `\n## ${sectionName}\n\n${sectionContent}\n`;
      }
    }

    const updatedContent = restoreLineEndings(
      this.reconstructFile(frontmatter, updatedBody, { blankLineAfterFrontmatter: false }),
      hasCRLF
    );
    atomicWriteFileSync(dec.filePath, updatedContent);
  }

  /**
   * Delete a decision
   */
  async deleteDecision(decisionId: string, parser: BacklogParser): Promise<void> {
    const dec = await parser.getDecision(decisionId);
    if (!dec) {
      throw new Error(`Decision ${decisionId} not found`);
    }
    fs.unlinkSync(dec.filePath);
  }
}
