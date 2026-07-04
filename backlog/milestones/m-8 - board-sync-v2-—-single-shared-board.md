---
id: m-8
title: Board Sync v2 — Single Shared Board
---

## Description

Remake of the board-sync feature: one physical board (primary worktree's backlog/) with no per-worktree copies/CAS/poll for the live layer, plus a discrete git-native versioning layer (snapshot on push / materialize on pull, union-merge with surfaced conflicts). Drops the GitHub live-CAS multi-user sync; re-scopes team sharing to explicit push/pull. Supersedes the 2026-07-01 synced-board CAS architecture.
