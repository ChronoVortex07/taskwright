/**
 * Parse the progress ledger of a superpowers-style implementation plan. Plans
 * (`docs/superpowers/plans/*.md`) track work as markdown checkbox steps
 * (`- [ ]` / `- [x]`); counting them gives a per-task completion signal to
 * surface on the board without coupling to any superpowers internals.
 */
export interface PlanStep {
  text: string;
  checked: boolean;
}

export interface PlanProgress {
  total: number;
  done: number;
  /** Completion percentage, rounded to a whole number (0 when no steps). */
  percent: number;
  steps: PlanStep[];
}

// A checkbox list item: optional indent, `-`/`*` bullet, `[ ]`/`[x]` box, text.
const CHECKBOX_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;

/** Parse checkbox steps from plan markdown into a completion summary. */
export function parsePlanProgress(markdown: string): PlanProgress {
  const steps: PlanStep[] = [];
  for (const line of markdown.split('\n')) {
    const match = CHECKBOX_RE.exec(line);
    if (!match) continue;
    const checked = match[1].toLowerCase() === 'x';
    const text = match[2]
      .trim()
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .trim();
    steps.push({ text, checked });
  }
  const total = steps.length;
  const done = steps.filter((s) => s.checked).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, percent, steps };
}
