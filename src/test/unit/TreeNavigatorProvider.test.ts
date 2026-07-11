import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { TreeNavigatorProvider } from '../../providers/TreeNavigatorProvider';
import { BacklogParser } from '../../core/BacklogParser';
import { ExtensionMessage, NavigatorTask } from '../../core/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('TreeNavigatorProvider', () => {
  let extensionUri: vscode.Uri;

  beforeEach(() => {
    extensionUri = vscode.Uri.file('/test/extension');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeParser(tasks: unknown[] = []): BacklogParser {
    return {
      getTasks: vi.fn().mockResolvedValue(tasks),
      getDrafts: vi.fn().mockResolvedValue([]),
      getCompletedTasks: vi.fn().mockResolvedValue([]),
      getArchivedTasks: vi.fn().mockResolvedValue([]),
      getConfig: vi.fn().mockResolvedValue({
        statuses: ['To Do', 'In Progress', 'Done'],
        priorities: ['high', 'medium', 'low'],
      }),
      getMilestones: vi.fn().mockResolvedValue([{ id: 'm-1', name: 'v1.0' }]),
      getCategories: vi.fn().mockResolvedValue(['Features', 'Bugs']),
      getTask: vi.fn(),
      getBacklogPath: vi.fn().mockReturnValue('/fake/backlog'),
      getPrimaryRoot: vi.fn().mockReturnValue('/fake'),
    } as unknown as BacklogParser;
  }

  it('includes tasks in navigatorData with compact task info', async () => {
    const parser = makeParser([
      {
        id: 'TASK-1',
        title: 'Test task',
        status: 'In Progress',
        priority: 'high',
        category: 'Features',
        milestone: 'v1.0',
        dependencies: [],
        labels: [],
        assignee: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/task-1.md',
      },
    ]);

    const posted: ExtensionMessage[] = [];
    const mockWebview = {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn((msg: ExtensionMessage) => {
        posted.push(msg);
        return Promise.resolve(true);
      }),
      cspSource: 'test-csp',
    } as unknown as vscode.Webview;

    const mockWVView = { webview: mockWebview, visible: true } as unknown as vscode.WebviewView;

    const provider = new TreeNavigatorProvider(extensionUri, parser, () => {});
    // Manually set _view so postMessage works — bypass resolveWebviewView's html rendering
    (provider as Any)._view = mockWVView;

    // Call refresh and AWAIT it directly
    await (provider as Any).refresh();

    const navDataMsg = posted.find((m) => m.type === 'navigatorData') as
      | Extract<ExtensionMessage, { type: 'navigatorData' }>
      | undefined;
    expect(navDataMsg).toBeDefined();
    expect(navDataMsg!.tasks).toBeDefined();
    expect(navDataMsg!.tasks.length).toBe(1);

    const task: NavigatorTask = navDataMsg!.tasks[0];
    expect(task.id).toBe('TASK-1');
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('In Progress');
    expect(task.lane).toBe('Features');
    expect(task.band).toBe('v1.0');
  });

  it('serializes task priority when present', async () => {
    const parser = makeParser([
      {
        id: 'TASK-2',
        title: 'High priority',
        status: 'To Do',
        priority: 'high',
        category: 'Features',
        dependencies: [],
        labels: [],
        assignee: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/task-2.md',
      },
    ]);

    const posted: ExtensionMessage[] = [];
    const mockWebview = {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn((msg: ExtensionMessage) => {
        posted.push(msg);
        return Promise.resolve(true);
      }),
      cspSource: 'test-csp',
    } as unknown as vscode.Webview;

    const mockWVView = { webview: mockWebview, visible: true } as unknown as vscode.WebviewView;
    const provider = new TreeNavigatorProvider(extensionUri, parser, () => {});
    (provider as Any)._view = mockWVView;
    await (provider as Any).refresh();

    const navDataMsg = posted.find((m) => m.type === 'navigatorData') as Extract<
      ExtensionMessage,
      { type: 'navigatorData' }
    >;
    expect(navDataMsg.tasks[0].priority).toBe('high');
  });

  it('uses Misc lane when category is undefined', async () => {
    const parser = makeParser([
      {
        id: 'TASK-3',
        title: 'No-category task',
        status: 'To Do',
        category: undefined,
        milestone: '',
        dependencies: [],
        labels: [],
        assignee: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/fake/task-3.md',
      },
    ]);

    const posted: ExtensionMessage[] = [];
    const mockWebview = {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn((msg: ExtensionMessage) => {
        posted.push(msg);
        return Promise.resolve(true);
      }),
      cspSource: 'test-csp',
    } as unknown as vscode.Webview;

    const mockWVView = { webview: mockWebview, visible: true } as unknown as vscode.WebviewView;
    const provider = new TreeNavigatorProvider(extensionUri, parser, () => {});
    (provider as Any)._view = mockWVView;
    await (provider as Any).refresh();

    const navDataMsg = posted.find((m) => m.type === 'navigatorData') as Extract<
      ExtensionMessage,
      { type: 'navigatorData' }
    >;
    expect(navDataMsg.tasks[0].lane).toBe('Misc');
  });

  it('relays navigatorJumpToTask from navigator to board', async () => {
    const relayed: ExtensionMessage[] = [];
    const parser = makeParser([]);

    const mockWebview = {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(() => Promise.resolve(true)),
      cspSource: 'test-csp',
    } as unknown as vscode.Webview;

    const mockWVView = { webview: mockWebview, visible: true } as unknown as vscode.WebviewView;
    const provider = new TreeNavigatorProvider(extensionUri, parser, (msg) =>
      relayed.push(msg)
    );

    // Use resolveWebviewView to register the message handler
    provider.resolveWebviewView(mockWVView);

    // Extract the registered onDidReceiveMessage handler
    const onMsgFn = mockWebview.onDidReceiveMessage as Any;
    const handler = onMsgFn.mock?.calls?.[0]?.[0] as (msg: Any) => void | undefined;
    if (handler) {
      await handler({ type: 'navigatorJumpToTask', taskId: 'TASK-1' });
      expect(relayed.some((m) => m.type === 'navigatorJumpToTask')).toBe(true);
    } else {
      expect(handler).toBeDefined();
    }
  });
});
