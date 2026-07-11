import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { BacklogWorkspaceManager } from '../../core/BacklogWorkspaceManager';
import type { BacklogDirectoryResolution } from '../../core/resolveBacklogDirectory';

vi.mock('../../core/boardRoot', () => ({
  resolveWorkspaceBacklogRoot: vi.fn(),
}));

import { resolveWorkspaceBacklogRoot } from '../../core/boardRoot';

const mockResolve = resolveWorkspaceBacklogRoot as Mock;

// The vscode mock has a mutable workspaceFolders, but TS types it as readonly.
// Cast to allow assignment in tests.
const mockWorkspace = vscode.workspace as {
  workspaceFolders: vscode.WorkspaceFolder[] | undefined;
};

function createMockMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue?: T) => (store.get(key) as T) ?? defaultValue,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
}

function makeFolder(name: string, fsPath: string): vscode.WorkspaceFolder {
  return {
    uri: { fsPath, scheme: 'file', path: fsPath } as vscode.Uri,
    name,
    index: 0,
  };
}

/** Helper to create a "found" resolution result */
function foundResolution(
  projectRoot: string,
  backlogDir = 'backlog',
  configPath?: string
): BacklogDirectoryResolution {
  return {
    projectRoot,
    backlogDir,
    backlogPath: `${projectRoot}/${backlogDir}`,
    source:
      backlogDir === '.backlog' ? '.backlog' : backlogDir === 'backlog' ? 'backlog' : 'custom',
    configPath: configPath ?? `${projectRoot}/${backlogDir}/config.yml`,
    configSource: 'folder',
    rootConfigPath: `${projectRoot}/backlog.config.yml`,
    rootConfigExists: false,
  };
}

/** Helper to create a "not found" resolution result */
function notFoundResolution(projectRoot: string): BacklogDirectoryResolution {
  return {
    projectRoot,
    backlogDir: null,
    backlogPath: null,
    source: null,
    configPath: null,
    configSource: null,
    rootConfigPath: `${projectRoot}/backlog.config.yml`,
    rootConfigExists: false,
  };
}

describe('BacklogWorkspaceManager', () => {
  let memento: vscode.Memento;

  beforeEach(() => {
    vi.clearAllMocks();
    memento = createMockMemento();
    mockWorkspace.workspaceFolders = undefined;
  });

  describe('discover()', () => {
    it('returns empty when no workspace folders', async () => {
      mockWorkspace.workspaceFolders = undefined;
      const manager = new BacklogWorkspaceManager(memento);
      const roots = await manager.discover();
      expect(roots).toEqual([]);
    });

    it('returns empty when no folder has backlog', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(notFoundResolution('/home/user/projectA'));

      const manager = new BacklogWorkspaceManager(memento);
      const roots = await manager.discover();
      expect(roots).toEqual([]);
    });

    it('discovers single root with backlog/', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA'));

      const manager = new BacklogWorkspaceManager(memento);
      const roots = await manager.discover();
      expect(roots).toHaveLength(1);
      expect(roots[0].label).toBe('projectA');
      expect(roots[0].backlogPath).toBe('/home/user/projectA/backlog');
      expect(roots[0].backlogDir).toBe('backlog');
    });

    it('discovers .backlog/ directory', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA', '.backlog'));

      const manager = new BacklogWorkspaceManager(memento);
      const roots = await manager.discover();
      expect(roots).toHaveLength(1);
      expect(roots[0].backlogPath).toBe('/home/user/projectA/.backlog');
      expect(roots[0].backlogDir).toBe('.backlog');
    });

    it('discovers custom backlog directory', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(
        foundResolution(
          '/home/user/projectA',
          'planning/data',
          '/home/user/projectA/backlog.config.yml'
        )
      );

      const manager = new BacklogWorkspaceManager(memento);
      const roots = await manager.discover();
      expect(roots).toHaveLength(1);
      expect(roots[0].backlogPath).toBe('/home/user/projectA/planning/data');
      expect(roots[0].backlogDir).toBe('planning/data');
      expect(roots[0].configPath).toBe('/home/user/projectA/backlog.config.yml');
    });

    it('discovers multiple roots', async () => {
      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
        makeFolder('projectC', '/home/user/projectC'),
      ];
      mockResolve.mockImplementation(async (root: string) => {
        if (root.includes('projectB')) return notFoundResolution(root);
        return foundResolution(root);
      });

      const manager = new BacklogWorkspaceManager(memento);
      const roots = await manager.discover();
      expect(roots).toHaveLength(2);
      expect(roots[0].label).toBe('projectA');
      expect(roots[1].label).toBe('projectC');
    });
  });

  describe('initialize()', () => {
    it('returns undefined when no roots found', async () => {
      mockWorkspace.workspaceFolders = undefined;
      const manager = new BacklogWorkspaceManager(memento);
      const result = await manager.initialize();
      expect(result).toBeUndefined();
    });

    it('auto-selects single root', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA'));

      const manager = new BacklogWorkspaceManager(memento);
      const result = await manager.initialize();
      expect(result).toBeDefined();
      expect(result!.label).toBe('projectA');
      expect(manager.getActiveRoot()).toBe(result);
    });

    it('auto-selects first root when multiple exist', async () => {
      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
      ];
      mockResolve.mockImplementation(async (root: string) => foundResolution(root));

      const manager = new BacklogWorkspaceManager(memento);
      const result = await manager.initialize();
      expect(result!.label).toBe('projectA');
    });

    it('restores persisted selection', async () => {
      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
      ];
      mockResolve.mockImplementation(async (root: string) => foundResolution(root));

      // Pre-persist projectB
      await memento.update('backlog.activeBacklogPath', '/home/user/projectB/backlog');

      const manager = new BacklogWorkspaceManager(memento);
      const result = await manager.initialize();
      expect(result!.label).toBe('projectB');
    });

    it('falls back to first when persisted path is gone', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA'));

      // Persist a path that no longer exists
      await memento.update('backlog.activeBacklogPath', '/home/user/removed/backlog');

      const manager = new BacklogWorkspaceManager(memento);
      const result = await manager.initialize();
      expect(result!.label).toBe('projectA');
    });
  });

  describe('setActiveRoot()', () => {
    it('fires onDidChangeActiveRoot event', async () => {
      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
      ];
      mockResolve.mockImplementation(async (root: string) => foundResolution(root));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();

      const handler = vi.fn();
      manager.onDidChangeActiveRoot(handler);

      const roots = manager.getRoots();
      manager.setActiveRoot(roots[1]);

      expect(handler).toHaveBeenCalledWith(roots[1]);
      expect(manager.getActiveRoot()).toBe(roots[1]);
    });

    it('persists active path', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA'));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();

      manager.setActiveRoot(manager.getRoots()[0]);
      expect(memento.get('backlog.activeBacklogPath')).toBe('/home/user/projectA/backlog');
    });
  });

  describe('addRoot()', () => {
    it('adds root and fires event', async () => {
      mockWorkspace.workspaceFolders = [];
      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();

      const handler = vi.fn();
      manager.onDidChangeActiveRoot(handler);

      const folder = makeFolder('newProject', '/home/user/newProject');
      const root = {
        backlogPath: '/home/user/newProject/backlog',
        backlogDir: 'backlog',
        primaryRoot: '/home/user/newProject',
        workspaceFolder: folder,
        label: 'newProject',
      };

      manager.addRoot(root);

      expect(manager.getRoots()).toHaveLength(1);
      expect(manager.getActiveRoot()).toBe(root);
      expect(handler).toHaveBeenCalledWith(root);
    });

    it('does not duplicate existing root', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA'));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();
      expect(manager.getRoots()).toHaveLength(1);

      const folder = makeFolder('projectA', '/home/user/projectA');
      manager.addRoot({
        backlogPath: '/home/user/projectA/backlog',
        backlogDir: 'backlog',
        primaryRoot: '/home/user/projectA',
        workspaceFolder: folder,
        label: 'projectA',
      });

      expect(manager.getRoots()).toHaveLength(1);
    });
  });

  describe('selectBacklog()', () => {
    it('returns undefined when no roots', async () => {
      mockWorkspace.workspaceFolders = undefined;
      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();

      const result = await manager.selectBacklog();
      expect(result).toBeUndefined();
    });

    it('auto-returns single root without Quick Pick', async () => {
      mockWorkspace.workspaceFolders = [makeFolder('projectA', '/home/user/projectA')];
      mockResolve.mockResolvedValue(foundResolution('/home/user/projectA'));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();

      const result = await manager.selectBacklog();
      expect(result!.label).toBe('projectA');
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('shows Quick Pick when multiple roots', async () => {
      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
      ];
      mockResolve.mockImplementation(async (root: string) => foundResolution(root));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.discover();

      // Mock user picking projectB
      (vscode.window.showQuickPick as Mock).mockResolvedValue({
        label: 'projectB',
        description: '/home/user/projectB/backlog',
        root: manager.getRoots()[1],
      });

      const handler = vi.fn();
      manager.onDidChangeActiveRoot(handler);

      const result = await manager.selectBacklog();
      expect(result!.label).toBe('projectB');
      expect(vscode.window.showQuickPick).toHaveBeenCalled();
      expect(handler).toHaveBeenCalled();
    });

    it('keeps current root when Quick Pick is cancelled', async () => {
      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
      ];
      mockResolve.mockImplementation(async (root: string) => foundResolution(root));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.initialize();

      (vscode.window.showQuickPick as Mock).mockResolvedValue(undefined);

      const result = await manager.selectBacklog();
      expect(result!.label).toBe('projectA');
    });
  });

  describe('workspace folder changes', () => {
    it('re-discovers on workspace folder change and handles removed root', async () => {
      let folderChangeHandler: (() => Promise<void>) | undefined;
      (vscode.workspace.onDidChangeWorkspaceFolders as Mock).mockImplementation(
        (handler: () => Promise<void>) => {
          folderChangeHandler = handler;
          return { dispose: vi.fn() };
        }
      );

      mockWorkspace.workspaceFolders = [
        makeFolder('projectA', '/home/user/projectA'),
        makeFolder('projectB', '/home/user/projectB'),
      ];
      mockResolve.mockImplementation(async (root: string) => foundResolution(root));

      const manager = new BacklogWorkspaceManager(memento);
      await manager.initialize();
      manager.startWatching();

      // Simulate removing projectA (the active root)
      const eventHandler = vi.fn();
      manager.onDidChangeActiveRoot(eventHandler);

      mockWorkspace.workspaceFolders = [makeFolder('projectB', '/home/user/projectB')];

      await folderChangeHandler!();

      // Should have fallen back to projectB
      expect(manager.getActiveRoot()!.label).toBe('projectB');
      expect(eventHandler).toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('cleans up without error', () => {
      const manager = new BacklogWorkspaceManager(memento);
      expect(() => manager.dispose()).not.toThrow();
    });
  });
});
