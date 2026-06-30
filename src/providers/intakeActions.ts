import * as path from 'path';
import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import { writeHandoff } from '../core/handoff';
import { DEFAULT_INTAKE_TEMPLATE, intakeContext, renderIntakePrompt } from '../core/intakePrompt';

/**
 * Provider-layer glue for "Categorize with Claude" intake. Captures a raw dump
 * of bugs/improvements from the active editor, renders a paste-ready
 * categorization prompt constrained by the board's vocabulary, and copies it to
 * the clipboard. Subscription-safe — it never runs `claude -p`.
 */
export interface IntakeResult {
  prompt: string;
  handoffFile: string;
}

/** The raw text to categorize: the editor selection, else the whole document. */
function captureDump(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const selected = editor.document.getText(editor.selection);
  const text = (selected.trim() ? selected : editor.document.getText()).trim();
  return text || undefined;
}

export async function categorizeWithClaude(
  parser: BacklogParser
): Promise<IntakeResult | undefined> {
  const dump = captureDump();
  if (!dump) {
    vscode.window.showInformationMessage(
      'Open (or select) your raw bug/improvement notes in an editor, then run "Categorize with Claude".'
    );
    return undefined;
  }

  const [statuses, labels, config] = await Promise.all([
    parser.getStatuses(),
    parser.getUniqueLabels(),
    parser.getConfig(),
  ]);
  const priorities = config.priorities ?? ['high', 'medium', 'low'];

  const template =
    vscode.workspace.getConfiguration('backlog').get<string>('intakeTemplate', '').trim() ||
    DEFAULT_INTAKE_TEMPLATE;
  const prompt = renderIntakePrompt(
    template,
    intakeContext(dump, { labels, statuses, priorities })
  );

  const root = path.dirname(parser.getBacklogPath());
  const handoffFile = writeHandoff(root, 'intake', prompt);
  await vscode.env.clipboard.writeText(prompt);

  return { prompt, handoffFile };
}
