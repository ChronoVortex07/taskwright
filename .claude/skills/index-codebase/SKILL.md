---
name: index-codebase
description: Bootstrap an initial Taskwright tech-tree over an EXISTING repo. Reads git history, module structure, and docs ("forensics") to reconstruct the already-built foundation as Done baseline drafts and mine visible gaps (TODO/FIXME) as To-Do drafts, then applies everything as draft nodes the human reviews and promotes on the board. Use when the user says /index-codebase, or asks to "bootstrap the tree", "index the codebase", "reconstruct the board from the repo", or "populate the tech-tree from history". Re-runnable and deduped against the live board; never promotes for you.
allowed-tools: Bash, Read, Grep, Glob, mcp__taskwright__list_categories, mcp__taskwright__list_milestones, mcp__taskwright__get_board, mcp__taskwright__search_tasks, mcp__taskwright__create_category, mcp__taskwright__create_milestone, mcp__taskwright__create_task, mcp__taskwright__edit_task, Skill(superpowers:brainstorming)
---

# Index codebase (Taskwright tree bootstrap)

Reconstruct an initial tech-tree from an existing repository: read git history, module
structure, and docs ("forensics"), infer the major built foundation and the visible gaps, and
propose the result as **draft nodes** — **Done** baseline drafts for what already exists,
**To-Do** drafts for the gaps — that the human reviews and promotes on the canvas. Parity:
every tool here is one a human can drive by hand via the P3/P4 board — you are deriving a
proposal from the repo, not bypassing review.

## When to use

- The user invokes `/index-codebase`, or asks you to bootstrap / reconstruct / populate the
  tech-tree from an existing codebase or its history.
- Best on a **fresh** Taskwright mount over a repo with real history — an empty (or nearly
  empty) board that needs a foundation for new work to attach to.
- Not for authoring a single feature's tasks from a brief — that is `/create-task`. This skill
  reconstructs the _existing_ structure; it does not decompose new scope.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any
headless agent. Forensics use local `Bash`/`Read`/`Grep`/`Glob`; every board write goes through
the `taskwright` MCP tools. `superpowers:brainstorming` (optional, for genuinely ambiguous
scope) runs in-session.

## The loop

Granularity is deliberately **coarse** — tens of nodes for a typical project, capturing major
subsystems, releases, and decisions, not per-file detail.

1. **Survey** — see what already exists so the bootstrap is **additive**:
   - `list_categories` — the existing lanes (with counts; reserved: Misc/Bugs).
   - `list_milestones` — the existing bands in board order (Backburner = no milestone).
   - `get_board` — the live board (active tasks + existing drafts) to dedupe against.

2. **Forensics** — inspect the repo (read-only Bash/Read/Grep/Glob):
   - **git** — tags/releases (`git tag`, `git log --tags`), commit clusters and file churn,
     dates/authors (`git log --stat`, `git shortlog`) for chronology and phases.
   - **structure** — top-level modules/dirs, package manifests (package.json, pyproject,
     Cargo.toml, go.mod…), entry points, and the module dependency graph.
   - **docs** — README, CHANGELOG, `backlog/decisions/` or ADRs, architecture notes.

3. **Reconstruct (coarse)** — form the proposal in memory (do not write yet):
   - top-level modules/areas → **lanes** (reuse existing categories by sideways traversal;
     only a genuinely new area becomes a new `create_category`).
   - git tags/releases (or inferred phases when untagged) → **milestone ages**, ordered
     **oldest → newest** (they render left→right by creation order — so you will create them
     oldest-first in step 5).
   - major subsystems/features/decisions → **Done baseline drafts** in the age they were built.
   - module dependency graph + build chronology → **dependencies** (each checked so it never
     forms a cycle; design the graph acyclic — the tools reject cycles).

4. **Mine gaps** — scan `TODO`/`FIXME`/`XXX` markers (`Grep`) and obvious structural gaps →
   **To-Do drafts**, attached (as dependents) to the relevant baseline module, in the current
   age (or Backburner when the flow position is unknown). A `FIXME` is a candidate **bug**
   (`type: "bug"`, `causedBy` the baseline it regresses) but defaults to a plain task unless it
   is clearly a defect.

5. **Propose as drafts (confirm before writing)** — first print a **reconstruction summary**:
   _N lanes (X new), M ages, K Done baseline drafts, J To-Do gap drafts, and the key edges._
   **Wait for the user's confirmation** before any write — lanes (`create_category`) and ages
   (`create_milestone`) land in config/on-disk immediately, and Done baseline drafts touch the
   board. On confirmation, write in this order so every reference resolves:
   - `create_category` for each approved new lane; `create_milestone` for each age, **oldest
     first** (creation order = left→right band order).
   - `create_task` for each node, in **dependency order (prerequisites first)** — edges are the
     `dependencies` array and a prerequisite must exist before a dependent can name it. The ID
     each draft comes back with is **final** (a draft is minted with a real task ID, e.g.
     `TASK-112` in `drafts/`, and promotion is a pure move that never renames it), so you can
     name it in a later node's `dependencies`/`causedBy` and the edge survives promotion. Set
     `draft: true`, `status: "Done"` for a **baseline** node (a Done draft) and `draft: true`
     with **no status** (defaults to To Do) for a **gap** node, plus `category`, `priority`,
     `milestone`, and `dependencies` in the one call (drafts carry all of these). Use
     `type: "bug"` + `causedBy` for a bug node.
   - Acceptance criteria are **not** a `create_task` field — add them to a gap draft with a
     follow-up `edit_task` after the draft exists.
   - Everything renders as **proposed (draft) nodes** on the tree canvas.

6. **Hand off to review** — tell the user the reconstruction is on the tree as draft nodes.
   They edit / reslot / connect / disconnect (P3 gestures) and **promote** what they accept —
   single (per-node Promote) or all at once ("Promote all proposed"). **Do not promote for
   them; discarded drafts leave no trace.**

## Dedupe & re-runnability

The skill is **re-runnable** (e.g. after more history accrues). Before proposing anything, and
before each write, dedupe against the live board:

- Use `get_board` and `search_tasks` (on a node's key terms) to find existing nodes; **extend
  or link** to them rather than creating a near-duplicate.
- The board universe the tools see is **tasks + drafts only** — completed and archived tasks
  are invisible to `get_board`/`search_tasks`, so a foundation already archived will not be
  detected; note this limit to the user rather than re-proposing archived work.
- Prefer a dependency edge to an existing node over a duplicate baseline.
- A **config-only** milestone (a `milestones:` entry in `config.yml` with no file in
  `backlog/milestones/` yet) is matched by `create_milestone`'s idempotency check and returns
  `{ created: false }` **without** writing a file; because milestone reads are file-first, a
  config-only age is shadowed once any real `m-N` file exists — so when bootstrapping ages,
  prefer (re)creating the intended ages as **real milestone files**.

## Rules of thumb

- Coarse, not exhaustive — major subsystems/releases/decisions, tens of nodes.
- Baseline = **Done draft**; gap = **To-Do draft**; everything provisional until the human promotes.
- Ages are created oldest-first (creation order = left→right band order).
- Emit drafts prerequisites-first; design the dependency graph acyclic.
- A draft's ID is final — one ID space, promotion never renames. Reference it freely.
- Reuse a lane before creating one; a new lane is a decision to surface, not assume.
- Confirm the reconstruction summary before writing; never promote — the human does.
- Subscription-safe: forensics via Bash/Read/Grep/Glob, writes via MCP, never `claude -p`.
