import { substitutePlaceholders } from './templateRender';

/**
 * Intake / triage = "Categorize with Claude". The user captures a raw dump of
 * bugs and improvements; this renders a paste-ready prompt that tells a Claude
 * Code session to turn the dump into labeled, prioritized Backlog.md tasks via
 * the Taskwright MCP. Subscription-safe like dispatch — Taskwright produces a
 * prompt, it never runs the categorization itself.
 */
export interface IntakeContext {
  dump: string;
  labels: string;
  statuses: string;
  priorities: string;
}

/** Board vocabulary used to constrain the categorization. */
export interface IntakeVocabulary {
  labels: string[];
  statuses: string[];
  priorities: string[];
}

export const DEFAULT_INTAKE_TEMPLATE = `You are triaging a raw dump of bugs and improvements into a Backlog.md task board.

For each distinct issue in the dump below, create one task with the Taskwright MCP \`create_task\` tool. Before creating, review existing tasks and skip anything already tracked. For each new task:

- Write a clear, imperative title and a concise description.
- Set a priority — one of: {{priorities}}.
- Apply labels chosen from: {{labels}} (add a new label only when none fit).
- Keep unrelated concerns as separate tasks; never merge distinct issues.

New tasks start at the board's default status. Valid statuses are: {{statuses}}.

--- RAW DUMP ---
{{dump}}
--- END DUMP ---

When done, briefly list the task IDs you created so they can be reviewed on the board.`;

function joinOr(values: string[], fallback: string): string {
  return values.length ? values.join(', ') : fallback;
}

/** Flatten captured dump + board vocabulary into render-ready strings. */
export function intakeContext(dump: string, vocab: IntakeVocabulary): IntakeContext {
  return {
    dump: dump.trim(),
    labels: joinOr(vocab.labels, '(none defined — create labels as needed)'),
    statuses: joinOr(vocab.statuses, 'To Do, In Progress, Done'),
    priorities: joinOr(vocab.priorities, 'high, medium, low'),
  };
}

/** Substitute `{{key}}` placeholders with their intake-context values. */
export function renderIntakePrompt(template: string, ctx: IntakeContext): string {
  return substitutePlaceholders(template, ctx as unknown as Record<string, string>);
}
