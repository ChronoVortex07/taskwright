/**
 * Taskwright advisory-claim helpers.
 *
 * Claims live in task frontmatter as `claimed_by` / `worktree` / `claimed_at`.
 * Unlike the rest of a task (written via the `backlog` CLI), claims are
 * Taskwright-only fields written **surgically** here — only those lines are
 * touched, so Backlog.md's canonical frontmatter round-trips unchanged.
 *
 * Claiming is advisory, not a hard lock: across worktrees/branches git syncs
 * asynchronously, so a claim reduces — but cannot prevent — duplicate work.
 */

export interface Claim {
  /** Who/what holds the claim (agent or user id, may be @-prefixed). */
  claimedBy: string;
  /** Branch or worktree the claimant is working in (optional). */
  worktree?: string;
  /** When the claim was made, as 'YYYY-MM-DD HH:mm' (local time). */
  claimedAt: string;
}

const CLAIM_KEY_RE = /^(claimed_by|worktree|claimed_at):/;

/**
 * Format a `Date` as a `claimed_at` value: `'YYYY-MM-DD HH:mm'` in **local**
 * time. Local (not UTC) so it round-trips with {@link isClaimStale}, which
 * parses the bare string as local time — the two must agree or staleness
 * checks drift by the timezone offset.
 */
export function claimTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

interface FrontmatterSplit {
  before: string[]; // up to and including the opening '---'
  fields: string[]; // frontmatter field lines (between the fences)
  after: string[]; // the closing '---' and everything after it
}

function splitFrontmatter(content: string): FrontmatterSplit | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { before: lines.slice(0, 1), fields: lines.slice(1, i), after: lines.slice(i) };
    }
  }
  return null;
}

/** Single-quote a value YAML would otherwise mis-parse (@-prefixed, spaces, etc.). */
function quoteValue(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function claimLines(claim: Claim): string[] {
  const lines = [`claimed_by: ${quoteValue(claim.claimedBy)}`];
  if (claim.worktree) lines.push(`worktree: ${quoteValue(claim.worktree)}`);
  // claimed_at is always quoted so YAML never reinterprets it as a timestamp.
  lines.push(`claimed_at: '${claim.claimedAt.replace(/'/g, "''")}'`);
  return lines;
}

/**
 * Add or replace the claim on a task file's content. Existing claim lines are
 * removed first, so re-claiming never duplicates fields. Returns `content`
 * unchanged if it has no frontmatter block.
 */
export function applyClaim(content: string, claim: Claim): string {
  const split = splitFrontmatter(content);
  if (!split) return content;
  const fields = split.fields.filter((line) => !CLAIM_KEY_RE.test(line));
  fields.push(...claimLines(claim));
  return [...split.before, ...fields, ...split.after].join('\n');
}

/**
 * Remove any claim from a task file's content. Idempotent: returns the exact
 * input string when there was nothing to remove.
 */
export function clearClaim(content: string): string {
  const split = splitFrontmatter(content);
  if (!split) return content;
  const fields = split.fields.filter((line) => !CLAIM_KEY_RE.test(line));
  if (fields.length === split.fields.length) return content;
  return [...split.before, ...fields, ...split.after].join('\n');
}

/**
 * Whether a claim is older than `maxAgeMs` and should be treated as stale
 * (auto-releasable). An absent or unparseable timestamp is never stale.
 * `claimedAt` is parsed as local time to match how it is written.
 */
export function isClaimStale(
  claimedAt: string | undefined,
  maxAgeMs: number,
  now: number = Date.now()
): boolean {
  if (!claimedAt) return false;
  const t = new Date(claimedAt.replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) return false;
  return now - t > maxAgeMs;
}
