import * as fs from 'fs';
import * as path from 'path';
import { parsePlanProgress, PlanProgress } from './planProgress';

/**
 * Read a task's linked plan file from disk and parse its checkbox progress.
 * The plan path is repo-root-relative (as stored in the `plan` frontmatter
 * field); an absolute path is honored as-is. A missing file is not an error —
 * it yields empty progress so callers can show "plan not found".
 */
export interface LoadedPlan {
  /** Absolute path the plan was resolved to. */
  path: string;
  exists: boolean;
  progress: PlanProgress;
}

const EMPTY: PlanProgress = { total: 0, done: 0, percent: 0, steps: [] };

export function loadPlanProgress(root: string, planPath: string): LoadedPlan {
  const resolved = path.isAbsolute(planPath) ? planPath : path.join(root, planPath);
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    return { path: resolved, exists: true, progress: parsePlanProgress(content) };
  } catch {
    return { path: resolved, exists: false, progress: EMPTY };
  }
}
