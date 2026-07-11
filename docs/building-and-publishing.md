# Building, installing & publishing Taskwright

Everything you need to build Taskwright locally, install it into your own VS Code,
and (eventually) publish it to the Marketplace.

## Prerequisites

- **Node ≥ 22** and **[Bun](https://bun.sh)** (the project pins these via `mise.toml`).
- For the runtime features: the **[Backlog.md](https://github.com/MrLesk/Backlog.md) CLI** on PATH
  is **optional** (Taskwright handles all CRUD natively). Only needed if you want the upstream
  cross-branch board view.
- Windows only: `git config --global core.longpaths true` (Backlog.md task filenames can exceed
  `MAX_PATH`).

```bash
bun install      # once, after cloning
```

---

## 1. Develop locally (hot dev loop)

```bash
bun run build    # build:css + compile:webview + compile (extension + MCP server)
```

Then press **F5** in VS Code to launch an **Extension Development Host** — a second VS Code window
with the extension loaded from source. Open a folder containing a `backlog/` directory to see the
board. Re-run the build (or use `bun run watch`) and reload the host window (`Ctrl+R`) to pick up
changes.

Useful scripts:

| Command                              | What it does                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `bun run build`                      | Full build: CSS + Svelte webviews + extension + MCP server → `dist/`                     |
| `bun run watch`                      | Rebuild the extension bundle on change                                                   |
| `bun run test`                       | Unit tests (Vitest). Passes fully on Windows, macOS, and Linux — 0 failures on all three |
| `bun run lint` / `bun run typecheck` | ESLint / TypeScript checks                                                               |
| `bun run proof`                      | Build + run the Playwright visual-proof specs (screenshots in `e2e/__screenshots__/`)    |

> The F5 dev host is for **iterating on the code**. To actually _use_ Taskwright day-to-day in your
> normal editor, install it as a packaged extension (next section) instead.

---

## 2. Install it into your own VS Code (global, persistent)

This makes Taskwright available in **every** VS Code window, surviving restarts, with **no dev host**.

```bash
bun run package          # builds, then emits taskwright-<version>.vsix in the repo root
code --install-extension taskwright-1.0.0.vsix
```

`bun run package` is self-contained: a `vscode:prepublish` hook runs the full build first, so you
never have to run `bun run build` separately. (`code` is the VS Code CLI — if it's not found, run
**"Shell Command: Install 'code' command in PATH"** from the Command Palette.)

**Update after changing code:** bump `version` in `package.json`, then:

```bash
bun run package
code --install-extension taskwright-1.0.0.vsix --force   # --force reinstalls the same/again version
```

Reload the window (`Ctrl+R` / "Developer: Reload Window") to load the new build.

**Other editors:** Cursor / VSCodium use the same mechanism — `cursor --install-extension <file>.vsix`,
or the Extensions panel → `…` menu → **Install from VSIX…**.

**Uninstall:** `code --uninstall-extension ChronoVortex07.taskwright`.

> The `.vsix` is git-ignored (`*.vsix`) — it's a build artifact, not source.

---

## 3. Publish to the VS Code Marketplace

You have **two ways** to publish. For occasional releases, the web upload is simplest and needs no
tokens at all.

### Prerequisites (one-time)

1. A **publisher** at <https://marketplace.visualstudio.com/manage>. Ours is **`ChronoVortex07`** —
   it must match the `publisher` field in `package.json`.
2. Listing metadata (already in place, keep it good): `displayName`, `description`, `icon`,
   `repository`, `categories`, a `README.md` (rendered as the Marketplace page), `LICENSE`, and
   `CHANGELOG.md`.

### Option A — Web upload (recommended; no token)

1. `bun run package` to produce `taskwright-<version>.vsix`.
2. Go to <https://marketplace.visualstudio.com/manage/publishers/ChronoVortex07>.
3. **New Extension → Visual Studio Code**, and upload the `.vsix`. (This is the "New Extension"
   button you saw.)
4. To release an update later: bump `version`, repackage, then use the extension's **`⋯` → Update**
   on the same page and upload the new `.vsix`.

That's the whole flow — no Azure DevOps token required.

### Option B — Command line (`vsce publish`)

This automates packaging + upload but requires authenticating the CLI with a token.

```bash
bunx @vscode/vsce login ChronoVortex07   # paste a token when prompted (one-time)
bunx @vscode/vsce publish                # builds via vscode:prepublish, then uploads
# or bump + publish in one step:
bunx @vscode/vsce publish patch          # 1.0.0 -> 1.0.1 (also: minor / major)
```

**About the token (PATs):** CLI publishing has historically used an **Azure DevOps Personal Access
Token** (an org at <https://dev.azure.com> → _User settings → Personal Access Tokens → New Token →
scope: Marketplace → Manage_). Microsoft is migrating Marketplace authentication, so the exact token
mechanism is in flux — the official page is the source of truth:
<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>. **If the token step
is ever a hassle, just use Option A (web upload), which sidesteps it entirely.**

### Open VSX (Cursor / VSCodium / Gitpod)

The VS Code Marketplace is Microsoft-only. Editors like Cursor and VSCodium pull from the separate
**[Open VSX](https://open-vsx.org)** registry. To list there too:

```bash
bunx ovsx publish taskwright-1.0.0.vsix -p <open-vsx-token>
```

(Create the token from your Open VSX account — independent of the Microsoft Marketplace.)

---

## Version bumping

The Marketplace rejects re-uploading an existing version, so bump `version` in `package.json` before
each release (`1.0.0 → 1.0.1 …`). `vsce publish <patch|minor|major>` does this for you; for web upload,
edit `package.json` (and add a `CHANGELOG.md` entry) yourself.

## Quick reference

```bash
bun install                                   # deps
bun run build                                 # compile to dist/ (for F5 dev host)
bun run package                               # build + emit .vsix
code --install-extension taskwright-1.0.0.vsix --force   # install into your VS Code
# publish: upload the .vsix at marketplace.visualstudio.com/manage, or `bunx @vscode/vsce publish`
```
