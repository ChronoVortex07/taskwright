import * as vscode from 'vscode';
import * as path from 'path';
import { readSyncConfig, syncConfigPath, type SyncConfig } from '../core/syncConfig';
import { nodeQueueFs } from '../core/mergeQueue';
import { reconcileBoardRef, compactBoardRef } from '../core/boardLifecycle';
import { refreshBoard, type SyncTarget } from '../core/boardSyncEngine';
import { GitBranchService } from '../core/GitBranchService';

/** Injectable seams so the poll surfacing (below) is unit-testable without git/vscode. */
export interface BoardSyncControllerDeps {
  refresh: (target: SyncTarget) => Promise<{ changed: boolean }>;
  resolveConfig: () => Promise<{ cfg: SyncConfig; commonDir: string } | undefined>;
}

/**
 * Orchestrates the synced board inside the extension host: reconciles the board
 * ref on start, polls the shared remote to reflect teammates' changes, compacts
 * the ref history periodically, and reflects state in a status-bar item. All
 * business logic lives in the Plan 1–3 cores; this is orchestration only, so it
 * is verified by F5 + the visual-proof skill rather than unit tests (the poll's
 * degraded-state surfacing in `tick` is the exception — it is unit-tested).
 */
export class BoardSyncController {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly statusItem: vscode.StatusBarItem;
  private syncing = false;
  private pollsSinceCompact = 0;
  private degraded = false;
  private readonly refresh: BoardSyncControllerDeps['refresh'];
  private readonly resolveConfigFn: BoardSyncControllerDeps['resolveConfig'];

  /** Compact roughly every ~50 polls (≈ every 15–20 min at the default cadence). */
  private static readonly COMPACT_EVERY_POLLS = 50;

  constructor(
    private readonly workspaceRoot: string,
    private readonly onBoardChanged: () => void,
    deps: Partial<BoardSyncControllerDeps> = {}
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusItem.command = 'taskwright.enableSync';
    this.refresh = deps.refresh ?? ((target) => refreshBoard(target));
    this.resolveConfigFn = deps.resolveConfig ?? (() => this.resolveConfigImpl());
  }

  /** Resolve the shared sync config for this workspace, or undefined when unavailable. */
  private async resolveConfigImpl(): Promise<{ cfg: SyncConfig; commonDir: string } | undefined> {
    const git = new GitBranchService(this.workspaceRoot);
    const commonDir = await git.getCommonDir();
    if (!commonDir) return undefined;
    return { cfg: readSyncConfig(syncConfigPath(commonDir), nodeQueueFs), commonDir };
  }

  private target(cfg: SyncConfig): SyncTarget {
    return {
      repoRoot: this.workspaceRoot,
      ref: cfg.ref,
      remote: cfg.mode === 'github' ? cfg.remote : undefined,
      indexFile: path.join(this.workspaceRoot, '.taskwright', 'board.index'),
      backlogDir: 'backlog',
    };
  }

  private setStatus(cfg: SyncConfig): void {
    if (cfg.mode === 'off') {
      this.statusItem.hide();
      return;
    }
    if (this.degraded) {
      this.statusItem.text = '$(warning) Board: local (sync degraded)';
      this.statusItem.tooltip =
        'Board sync could not reach the remote (push/auth failed). Working against the local board ref.';
    } else {
      const label = cfg.mode === 'github' ? 'synced' : 'local';
      this.statusItem.text = `$(sync) Board: ${label}`;
      this.statusItem.tooltip =
        cfg.mode === 'github'
          ? `Board synced with ${cfg.remote}/${cfg.ref} (poll every ${cfg.pollSeconds}s).`
          : `Board on local ref ${cfg.ref} (off code branches).`;
    }
    this.statusItem.show();
  }

  /** Reconcile the ref, materialize, refresh the board, and start polling. */
  async start(): Promise<void> {
    if (this.timer) clearInterval(this.timer); // idempotent: allow restart after enable
    this.timer = undefined;
    const resolved = await this.resolveConfigFn();
    if (!resolved || resolved.cfg.mode === 'off') {
      this.statusItem.hide();
      return;
    }
    const { cfg } = resolved;
    this.setStatus(cfg);

    try {
      await reconcileBoardRef(this.target(cfg));
      this.onBoardChanged();
    } catch (err) {
      this.degraded = true;
      this.setStatus(cfg);
      console.error('[Taskwright] Board reconcile failed:', err);
    }

    this.timer = setInterval(() => void this.tick(), cfg.pollSeconds * 1000);
  }

  /** One poll: fetch the shared ref, materialize on change, periodically compact. */
  private async tick(): Promise<void> {
    if (this.syncing) return; // never overlap polls
    this.syncing = true;
    let cfg: SyncConfig | undefined;
    try {
      const resolved = await this.resolveConfigFn();
      if (!resolved || resolved.cfg.mode === 'off') return;
      cfg = resolved.cfg;
      const target = this.target(cfg);

      const { changed } = await this.refresh(target);
      this.degraded = false;
      if (changed) this.onBoardChanged();

      this.pollsSinceCompact += 1;
      if (this.pollsSinceCompact >= BoardSyncController.COMPACT_EVERY_POLLS) {
        this.pollsSinceCompact = 0;
        await compactBoardRef(target);
      }
      this.setStatus(cfg);
    } catch (err) {
      // Surface the degraded state instead of failing invisibly. A materialize
      // that throws (e.g. the board.materialized prune race) must show in the
      // status bar — and the log must fire only on the transition into degraded,
      // not every ~20s poll, so a persistent failure is visible without spam.
      const wasDegraded = this.degraded;
      this.degraded = true;
      if (cfg) this.setStatus(cfg);
      if (!wasDegraded) console.error('[Taskwright] Board poll failed:', err);
    } finally {
      this.syncing = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.statusItem.dispose();
  }
}
