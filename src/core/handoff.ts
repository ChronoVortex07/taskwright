import * as fs from 'fs';
import * as path from 'path';

/**
 * A dispatch handoff file is the durable companion to the clipboard copy: the
 * rendered, paste-ready prompt for a task, written under `.taskwright/handoff/`
 * so it survives clipboard churn and can be re-opened later. Like the rest of
 * `.taskwright/`, it is local/git-ignored.
 */
const HANDOFF_DIR = path.join('.taskwright', 'handoff');

/** Absolute path of a task's handoff file under `root`. */
export function handoffPath(root: string, taskId: string): string {
  return path.join(root, HANDOFF_DIR, `${taskId}.md`);
}

/** Write (overwriting) a task's handoff prompt, creating the directory as needed. */
export function writeHandoff(root: string, taskId: string, prompt: string): string {
  const target = handoffPath(root, taskId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${prompt.replace(/\n+$/, '')}\n`, 'utf-8');
  return target;
}
