import * as vscode from 'vscode';
import { BacklogParser } from '../core/BacklogParser';
import type { WebviewMessage, ExtensionMessage } from '../core/types';
import { loadTreeBoardFromParser } from '../core/treeDerived';
import { resolvePriorities } from '../core/priorityOrder';

/**
 * Sidebar navigator for the tech-tree canvas (P2 spec §3). Computes lane counts /
 * bands / priorities from the parser and posts `navigatorData`; relays the user's
 * filter / lane-toggle / jump intents to the board (canvas) via an injected callback.
 */
export class TreeNavigatorProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private parser: BacklogParser | undefined,
    private readonly relayToBoard: (message: ExtensionMessage) => void
  ) {}

  setParser(parser: BacklogParser): void {
    this.parser = parser;
  }

  postMessage(message: ExtensionMessage): void {
    this._view?.webview.postMessage(message);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      if (message.type === 'refresh') {
        await this.refresh();
        return;
      }
      if (
        message.type === 'navigatorFilterChanged' ||
        message.type === 'navigatorLaneToggle' ||
        message.type === 'navigatorJump'
      ) {
        this.relayToBoard(message as unknown as ExtensionMessage);
      }
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.parser || !this._view) return;
    try {
      const [board, config] = await Promise.all([
        loadTreeBoardFromParser(this.parser),
        this.parser.getConfig(),
      ]);
      const counts = new Map<string, number>();
      for (const s of board.states.values()) {
        counts.set(s.layout.lane, (counts.get(s.layout.lane) ?? 0) + 1);
      }
      const lanes = board.laneOrder
        .filter((l) => counts.has(l))
        .map((name) => ({ name, count: counts.get(name) ?? 0 }));
      this.postMessage({
        type: 'navigatorData',
        lanes,
        bands: board.bandOrder,
        priorities: resolvePriorities(config),
      });
    } catch (error) {
      console.error('[Taskwright] navigator refresh failed:', error);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${uri('styles.css')}" rel="stylesheet">
  <link href="${uri('tree-navigator.css')}" rel="stylesheet">
  <title>Tree Navigator</title>
</head>
<body class="tree-navigator-page">
  <div id="app"></div>
  <script type="module" src="${uri('tree-navigator.js')}"></script>
</body>
</html>`;
  }
}
