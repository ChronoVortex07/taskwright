# Stable task IDs from birth — design

**Date:** 2026-07-12
**Status:** Approved (brainstorm)

## Problem

A draft is created as `DRAFT-N` and, on promotion, is **re-ID'd** to a freshly minted
`TASK-M` (`BacklogWriter.promoteDraft:405-462`). The numbers are unrelated — `DRAFT-3`
routinely becomes `TASK-11`, because drafts and tasks have two independent counters
(`getNextDraftId:934-949` scans `drafts/`, `getNextTaskId:1041-1075` scans `tasks/`).

Every reference written while a task was a draft is therefore stale the moment it is
promoted. This is not theoretical — it is already fossilized in this repo's own board.
`TASK-77`'s description reads:

> Wire the new worktree-bootstrap tool (DRAFT-3) and the request_merge worktree-target
> override (DRAFT-4) into the /execute-task skill…

`DRAFT-3` and `DRAFT-4` no longer exist. An agent reading that description, or a spec or
handoff written during the draft phase, cannot resolve the reference.

`promoteDrafts` (`src/core/promoteDrafts.ts:96-125`) exists solely to paper over this: it
runs a post-promote remap pass rewriting inbound `dependencies` and bug `causedBy`. It
does **not** remap `parent_task_id`, subtask IDs, or `references[]` — those dangle
silently. And it cannot possibly remap prose (descriptions, notes, specs, handoffs),
which is where the confusion actually bites.

## Goal

A task carries the ID it will keep, from creation. Promotion never changes an ID.
References written against a draft remain valid forever.

## Design

### One ID space; the folder is the only draftness marker

`createDraft` mints from the **task** counter. A new draft is `TASK-112`, living at
`backlog/drafts/task-112 - Title.md` with `id: TASK-112` in frontmatter.

This requires no new draftness signal, because there already is one:
`folder === 'drafts'`. The parser derives it from the containing directory
(`BacklogParser.ts:236-270`), the type system encodes it (`TaskFolder`,
`types.ts:45`), and every downstream consumer — the MCP `draft` flag
(`handlers.ts:1116`), `TaskDetailProvider:540`, the tree gate, `TreeNode.svelte`,
`DetailPopover.svelte` — already keys off it, never off the ID prefix. The P6/D2
design made this explicit: *"a draft is a provisional OVERLAY (folder === 'drafts') …
orthogonal to completion status — the folder is the marker, not a synthetic 'Draft'
status."* This change simply finishes that thought: the folder is the marker, not the ID
either.

### Promote and demote become pure moves

`promoteDraft` (`BacklogWriter.ts:405-462`) drops its re-ID entirely: rename the file
from `drafts/` to `tasks/`, leave `id` and status untouched, bump `updated_date`. There
is nothing to remap, because no ID changed.

`demoteTask` (`BacklogWriter.ts:469-513`) is the mirror: move `tasks/` → `drafts/`, ID
preserved. (Today demote is strictly worse than promote — it re-IDs and does no remap at
all, so any `dependencies: [TASK-11]` elsewhere dangles instantly. That bug disappears.)

`promoteDrafts` (`src/core/promoteDrafts.ts`) keeps its shape — validate, topo-order,
promote each, remap — but the remap pass now fires only for entries where
`from !== to`, i.e. legacy drafts. For stable-ID drafts it is a no-op.

This change **deletes** machinery rather than adding it. `getNextDraftId` retires.

### Three latent bugs this forces us to fix

The shared counter is only safe if allocation is genuinely global. Two of these are live
bugs today, independent of this feature.

**1. `getNextTaskId` must scan every folder.** It currently scans `tasks/` (plus an
optional cross-branch ID list) and ignores `drafts/`, `completed/`, and `archive/`. Under
one ID space it must take the max over all of them. This also closes an existing bug: a
task restored from `archive/` can today be assigned an ID that a live task already holds,
because `archive/` was never scanned.

**2. The allocation lock must move to one shared namespace.** `allocateAndWrite`
(`BacklogWriter.ts:891-929`) is the mutex that fixed the concurrent-create clobber
(TASK-48). It works by `mkdir`-ing a lock dir keyed on the numeric ID — but *inside the
target directory*: `tasks/.task-N.lock` for `createTask`, `drafts/.draft-N.lock` for
`createDraft`. Two dirs, two lock namespaces that cannot see each other. Under a shared
counter, a concurrent `create_task` and `create_task({draft: true})` would both `mkdir`
successfully and both claim `TASK-112` — reintroducing exactly the bug TASK-48 fixed.

The lock directory moves to a single shared location, `backlog/.locks/task-N.lock`,
used by both writers. The `flag: 'wx'` write guard stays as-is.

**3. `promoteDraft`/`demoteTask` bypass `allocateAndWrite`.** They call the scanners
directly and `renameSync` onto a scanned-but-unclaimed ID, so they race against a
concurrent create. For promote this evaporates (no ID is allocated at all). Demote no
longer allocates either. No further work needed — noting it because it explains why the
scanner-vs-allocator distinction matters.

### Archive routes by folder, not by ID prefix

`restoreArchivedTask:384` contains the **only** runtime branch on the ID prefix in the
entire codebase:

```ts
taskId.startsWith('DRAFT-') ? 'drafts' : 'tasks'
```

Once a draft is `TASK-112`, this can no longer tell where the file came from.

The fix keeps the invariant that already holds everywhere else — *the folder carries
draftness*:

- `archiveTask` routes by **source folder**: a file from `drafts/` goes to
  `archive/drafts/`, one from `tasks/` goes to `archive/tasks/`. The `archive/drafts/`
  directory is already scaffolded by `initBacklog.ts:83` and nothing has ever written to
  it.
- `restoreArchivedTask` routes back by **which archive subfolder holds the file**, found
  by looking in both.

This deletes the last `DRAFT-` prefix branch. No frontmatter marker is introduced — that
would create a second source of truth for draftness alongside the folder, which is the
exact ambiguity P6/D2 removed.

### Automatic migration of legacy boards

A board carrying `DRAFT-N` files must converge on the new format **by itself**. Leaving
legacy drafts to limp along on a compatibility path would strand exactly the boards the
feature exists to help: the draft IDs would stay unstable, and the confusion this design
sets out to kill would persist until each draft happened to be promoted.

**Detection.** A task file is *legacy* when it lives in `drafts/` (or in `archive/`, having
been archived while a draft) and its ID does not carry the configured `task_prefix`. This
is a pure predicate over already-parsed tasks — no filesystem probing, no `DRAFT-` string
match, so a board with a custom `task_prefix` classifies correctly.

**Shared remap core — `src/core/idRemap.ts`.** Extracted from `promoteDrafts`' remap pass
and used by both it and the migration. Given a board and a map of `oldId → newId`, it
rewrites every inbound reference:

| Field | Rewritten today by `promoteDrafts`? |
| --- | --- |
| `dependencies` | yes |
| bug `caused_by` | yes |
| `parent_task_id` | **no — silently dangles** |
| `subtasks` | **no — silently dangles** |
| `references[]` | **no — silently dangles** |

Extracting the core closes those three gaps for promote as well; they are the same bug,
and the migration would reintroduce them if it rolled its own pass.

**Migration core — `src/core/draftIdMigration.ts`.** Pure planner + executor, mirroring the
shape of `boardHomeMigration.ts`:

- `planDraftIdMigration(tasks, drafts, config)` → a typed plan: for each legacy draft, the
  fresh `TASK-M` it will take, the file rename, and the resulting `oldId → newId` map. Pure
  and unit-testable, with no writes.
- `runDraftIdMigration(deps)` → executes the plan: allocate each new ID through the same
  shared-lock `allocateAndWrite` path a normal create uses (so a concurrent create cannot
  collide), rename `drafts/draft-3 - X.md` → `drafts/task-112 - X.md`, rewrite frontmatter
  `id`, then run **one** `idRemap` pass across the whole board. Drafts are migrated in
  dependency-first topological order (reusing `promoteDrafts`' `topoOrder`), so the new IDs
  come out in a sensible sequence.
- A legacy **archived** draft (a `draft-N` file sitting in `archive/tasks/`, where today's
  `archiveTask` puts it) is additionally relocated to `archive/drafts/`, so the new
  folder-routed restore finds it.
- **Idempotent**: a board with no legacy drafts performs zero writes and returns
  `{ migrated: 0 }`. Re-running is free.

**Where it runs.** Both entry points call the identical core, so an agent-only session and
a UI session converge the same way (the parity rule this codebase already holds to):

1. **Extension activation**, inside the `deferredBootstrap` runner
   (`src/core/deferredBootstrap.ts`). It must not go inline in `activate()` — TASK-109
   moved every git/fs burst out of the activation path and that must not regress. Like the
   rest of that runner, a failure logs and degrades; it never rejects into activation.
2. **MCP server startup**, after the board root resolves — so a dispatched, headless, or
   agent-only session on an unmigrated board still migrates.

Both take the existing cross-process board lock, so an extension host and an MCP server
starting simultaneously cannot double-migrate.

**Visibility.** The migration rewrites git-tracked board files, so it is automatic but not
silent: it reports `Migrated N drafts to stable task IDs` with the full `DRAFT-3 → TASK-112`
mapping logged. `boardDoctor` also gains a `legacy-draft-ids` finding with the migration as
its declared repair — a visible safety net if an automatic pass ever fails or is skipped,
matching the existing doctor pattern.

**Residual compatibility.** After migration a board has no legacy drafts, but an external
tool (the upstream Backlog.md CLI) could still write one. So `promoteDraft` **keeps** its
re-ID fallback as defense-in-depth, fired only when a draft's ID lacks the task prefix, and
the parser continues to read `DRAFT-N` files unchanged — its ID regex is already generic
(`/^([a-zA-Z]+-\d+(?:\.\d+)*)/i`, `BacklogParser.ts:556`) and frontmatter `id` wins over the
filename. Likewise `getNextTaskId` matches on the task prefix when it scans `drafts/`, so a
stray `draft-3 - X.md` contributes nothing to the max and cannot collide with the counter.

This repo's own board is already clean — zero drafts, zero `DRAFT-*` files, highest ID
TASK-110 — so migration is a no-op here. It is exercised against the legacy fixtures
(`src/test/e2e/fixtures/test-workspace/backlog/drafts/draft-4 - ...md` and the archived
`draft-3` file), which are preserved for exactly that purpose.

### Documentation and agent-facing surfaces

The MCP tool descriptions that promise `DRAFT-N` must be corrected, or agents will keep
writing draft-flavored references:

- `src/mcp/server.ts:302` (`'Create as a draft (DRAFT-N in drafts/).'`), and the
  `promote_drafts` / `demote_task` descriptions at `:404-405, :415, :419, :430`. New
  wording: a draft is created **in `drafts/` with a normal `TASK-N` ID**; drafts and tasks
  share one ID space; **promotion never changes an ID**.
- `.claude/skills/create-task/SKILL.md` and `.claude/skills/index-codebase/SKILL.md` —
  both wire dependencies between drafts by ID. They get *simpler*: the ID an agent writes
  into a spec, handoff, or dependency is final.
- The literal `DRAFT` badge text on the Drafts-tab list rows
  (`ListView.svelte:583`) stays — it is gated on the tab, not the ID, and remains a
  correct label.

No UI logic changes. Every draft affordance in the webview is already folder- or
status-driven, never ID-driven.

## Consequences (accepted)

- **An ID no longer tells you something is a draft.** That is the point — the reference is
  stable — but it means draftness is visible only on the board, not in a bare ID string.
- **Discarded drafts burn ID numbers,** leaving gaps in the sequence. Gaps already occur
  via archive; this is not a new property.

## Testing

**Unit — `BacklogWriter`:**

- `createDraft` mints `TASK-N` from the shared counter and writes
  `drafts/task-N - Title.md` with `id: TASK-N`
- creating a task then a draft (and the reverse) yields **strictly increasing, distinct**
  IDs
- `getNextTaskId` takes the max across `tasks/`, `drafts/`, `completed/`, and `archive/`
- `promoteDraft` on a stable-ID draft is a **pure move**: same ID, same status, file
  relocated, frontmatter `id` untouched
- `promoteDraft` on a **legacy** `DRAFT-N` draft still re-IDs to a fresh `TASK-M`
- `demoteTask` preserves the ID and the status
- `archiveTask` sends a draft to `archive/drafts/` and a task to `archive/tasks/`;
  `restoreArchivedTask` round-trips each back to its original folder **without reading the
  ID prefix**
- a task restored from archive cannot collide with a live task's ID

**Unit — `allocateAndWrite`:** concurrent `createTask` and `createDraft` racing on the
same candidate ID resolve to two distinct IDs (the shared-lock regression test — this is
the TASK-48 bug re-armed).

**Unit — `promoteDrafts`:** a batch of stable-ID drafts promotes with **no** reference
rewriting and all `dependencies` / `causedBy` edges intact; a batch of legacy drafts still
remaps.

**Unit — `idRemap`:** rewrites `dependencies`, `caused_by`, `parent_task_id`, `subtasks`,
and `references[]` for a given `oldId → newId` map; leaves unrelated IDs untouched; does
not partially rewrite an ID that merely shares a prefix (`TASK-1` must not match inside
`TASK-11`).

**Unit — `draftIdMigration`:**

- `planDraftIdMigration` on a board with no legacy drafts yields an empty plan
- a legacy `DRAFT-3` is planned onto a fresh `TASK-M` above the current max, with the file
  rename and the `oldId → newId` map
- a board with a custom `task_prefix` classifies its own drafts as **non**-legacy
- drafts are planned in dependency-first order
- `runDraftIdMigration` renames the file, rewrites frontmatter `id`, and remaps every
  inbound `dependencies` / `caused_by` / `parent_task_id` / `subtasks` / `references[]`
  reference on the board
- a legacy archived draft in `archive/tasks/` is relocated to `archive/drafts/`
- **idempotence**: running it twice performs zero writes the second time
- a migration failure leaves the board readable and surfaces a `legacy-draft-ids` doctor
  finding rather than a half-migrated board

**Integration — the whole point of the feature:** create a draft, reference it by ID from a
second task's `dependencies` and from its description prose, promote it, and assert the
dependency still resolves and the prose reference is still correct. Then, separately, load
the **legacy fixture** board, let activation migrate it, and assert the same invariants hold
afterwards — no dangling references, drafts carry `TASK-N`, and a re-run is a no-op.

**Integration:** create a draft, reference it by ID from a second task's `dependencies`
and from its description prose, promote it, and assert the dependency still resolves and
the prose reference is still correct. This is the acceptance test for the whole feature.
