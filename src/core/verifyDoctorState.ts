import * as path from 'path';
import type { QueueFsDeps } from './mergeQueue';
import { verifyDoctorSignature, type VerifyDoctorReport } from './verifyDoctor';

/**
 * The verify doctor's prompt-once memory (TASK-132).
 *
 * The doctor (TASK-86) could already prove that a repo's configured merge-verify
 * commands were wrong — but it was purely advisory, and the bun-flavored defaults
 * ship with every install, so a cross-repo scan found 0/5 repos had ever changed
 * them. They surfaced only as a confusing `verify_failed` abort at merge time.
 *
 * Making the doctor PROACTIVE means it must also be well-mannered, and that needs
 * exactly one durable fact: what the human already decided about this situation.
 *
 *  - `shouldPromptVerifyDoctor` — ask at most ONCE per situation. Any recorded
 *    decision (applied / declined / deferred) closes the question.
 *  - `isVerifyDoctorDismissed` — only an EXPLICIT decline also silences the
 *    standing `board_doctor` finding. A prompt merely dismissed with X is
 *    `deferred`: the nag stops, but the finding stays available in the doctor, so
 *    a stray click cannot lose the diagnosis.
 *
 * The record is keyed by {@link verifyDoctorSignature}, so it is a decision about
 * ONE situation, never a blanket mute: change the commands, or change the repo so
 * the advice changes, and the doctor may speak once more.
 *
 * Nothing here rewrites a verify command. Applying is the human's click; this
 * module only remembers that they were asked.
 */

export type VerifyDoctorDecision =
  /** The human took the doctor's suggestions. */
  | 'applied'
  /** The human explicitly said no — respected everywhere, including board_doctor. */
  | 'declined'
  /** The prompt was dismissed without an answer; stop asking, keep the finding. */
  | 'deferred';

export interface VerifyDoctorState {
  /** The {@link verifyDoctorSignature} the decision was made about. */
  signature?: string;
  decision?: VerifyDoctorDecision;
  /** ISO timestamp of the decision (diagnostics only). */
  decidedAt?: string;
}

type StateFs = Pick<QueueFsDeps, 'exists' | 'read' | 'writeAtomic'>;

/** `<commonDir>/taskwright/verify-doctor.json` — beside merge-config.json, shared by every worktree. */
export function verifyDoctorStatePath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'verify-doctor.json');
}

/** Read the decision record, tolerating a missing/corrupt file as "nothing decided". Never throws. */
export function readVerifyDoctorState(
  filePath: string,
  fsDeps: Pick<StateFs, 'exists' | 'read'>
): VerifyDoctorState {
  if (!fsDeps.exists(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fsDeps.read(filePath));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const state: VerifyDoctorState = {};
    if (typeof raw.signature === 'string') state.signature = raw.signature;
    if (raw.decision === 'applied' || raw.decision === 'declined' || raw.decision === 'deferred') {
      state.decision = raw.decision;
    }
    if (typeof raw.decidedAt === 'string') state.decidedAt = raw.decidedAt;
    return state;
  } catch {
    return {};
  }
}

/** Persist the decision record atomically. */
export function writeVerifyDoctorState(
  filePath: string,
  state: VerifyDoctorState,
  fsDeps: Pick<StateFs, 'writeAtomic'>
): void {
  fsDeps.writeAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** Record what the human decided about the situation `report` describes. */
export function recordVerifyDoctorDecision(
  filePath: string,
  report: VerifyDoctorReport,
  decision: VerifyDoctorDecision,
  fsDeps: Pick<StateFs, 'writeAtomic'>,
  now: Date = new Date()
): VerifyDoctorState {
  const state: VerifyDoctorState = {
    signature: verifyDoctorSignature(report),
    decision,
    decidedAt: now.toISOString(),
  };
  writeVerifyDoctorState(filePath, state, fsDeps);
  return state;
}

/**
 * Should the human be prompted about this report? Only when something needs
 * attention AND they have not already decided about this exact situation.
 */
export function shouldPromptVerifyDoctor(
  report: VerifyDoctorReport,
  state: VerifyDoctorState
): boolean {
  if (report.ok) return false;
  return state.signature !== verifyDoctorSignature(report);
}

/**
 * Has the human explicitly declined this exact situation? Only then is the
 * standing `board_doctor` finding suppressed too — "declining is remembered and
 * respected" means the board stops calling it an issue, not just that the toast
 * stops appearing.
 */
export function isVerifyDoctorDismissed(
  report: VerifyDoctorReport,
  state: VerifyDoctorState
): boolean {
  return state.decision === 'declined' && state.signature === verifyDoctorSignature(report);
}
