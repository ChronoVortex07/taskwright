# Taskwright as native cross-agent skills

Taskwright ships its four workflow skills — `create-task`, `execute-task`, `index-codebase`,
`orchestrate-board` — as **native SKILL.md packages**, from one versioned source of truth
(`.claude/skills/`, bundled to `dist/skills/` at build time). Both agents get the same full,
progressively-disclosed skill packages — nothing is reduced to a flattened prompt:

| Agent                            | Discovery surface               | Installed by                                                             |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| Claude Code                      | `<repo>/.claude/skills/<name>/` | `Taskwright: Set Up Claude Code Integration` (`installTaskwrightSkills`) |
| Codex (& other AGENTS.md agents) | `<repo>/.agents/skills/<name>/` | `Taskwright: Set Up Codex Integration` (`installAgentSkills`)            |

`.agents/skills/` is Codex's canonical, vendor-neutral discovery surface. Codex scans it (repo root,
cwd, and `$HOME/.agents/skills`), reads each skill's `name` + `description` up front, and loads the
full `SKILL.md` only when it selects the skill (progressive disclosure). Because the packages are the
same source both agents share, a skill fix lands for Claude and Codex at once.

The detailed multi-step workflows live **inside** the skills, so the `AGENTS.md` convention block
Taskwright injects stays a concise pointer (well within Codex's per-file instruction budget) — see
`TASKWRIGHT_AGENTS_CONVENTION` / `TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS` in
`src/core/agentConvention.ts`.

## Per-repo install (the usual path)

Run **`Taskwright: Set Up Codex Integration (MCP + skills)`** from the VS Code command palette (or let
Taskwright offer it the first time it detects an un-integrated Codex install). It:

1. Registers the Taskwright MCP server in Codex's `~/.codex/config.toml` (`[mcp_servers.taskwright]`,
   absolute path to the packaged server).
2. Installs the four skills as native packages under `<repo>/.agents/skills/<name>/`
   (idempotent — existing skills are skipped; re-run after an upgrade to refresh).
3. Offers the shared `AGENTS.md` convention block.

Restart Codex to pick up the new MCP server and skills.

## Plugin distribution (the bundled path)

For distribution beyond a single repo, `bun run build` also assembles a **Codex plugin** — the
distribution primitive that ships the skills and the Taskwright MCP server together — into
`dist/codex-plugin/`:

```
dist/codex-plugin/
├── .codex-plugin/plugin.json          # manifest: name, version, skills, mcpServers
├── .mcp.json                          # the bundled MCP server (bare server-name map)
├── .agents/plugins/marketplace.json   # repo-scoped registration helper
├── mcp/server.js                      # the standalone, dependency-free MCP server
└── skills/<name>/SKILL.md             # the four native skill packages
```

The manifest (`.codex-plugin/plugin.json`) declares both components together:

```json
{
  "name": "taskwright",
  "version": "1.4.0",
  "description": "…",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

### Install

- **Interactive:** in Codex, run `/plugins`, choose **Install plugin**, and point it at the bundle
  (or its published location). Start a new thread; the skills appear in `/skills` (or via `$name`) and
  the `taskwright` MCP tools become available.
- **Repo-scoped (no publish):** copy `dist/codex-plugin/` into the target repo and merge its
  `.agents/plugins/marketplace.json` into the repo's `.agents/plugins/marketplace.json`. Restart
  Codex; the plugin appears in `/plugins` on the next session.

### Update

Codex uses the plugin **version** as its reinstall cache key, so bumping `version` in
`plugin.json` (driven by `package.json`'s version on every `bun run build`) forces a reinstall on the
next sync. To upgrade: rebuild (or re-fetch) the bundle and re-sync in `/plugins` — the version bump
pulls the new skills and MCP definition.

### Uninstall

Open the `/plugins` browser and choose **Uninstall plugin** (removes the bundle from
`~/.codex/plugins/cache/`), or set `enabled = false` under the plugin in `~/.codex/config.toml` to
disable it without removing it. To remove only the per-repo native skills, delete
`<repo>/.agents/skills/<name>/` for the Taskwright skills — `uninstallAgentSkills`
(`src/core/agentSkills.ts`) does exactly this, scoped to the Taskwright skill names so any unrelated
skills in the surface are left untouched.

## Source of truth & tests

- Skill sources: `.claude/skills/<name>/SKILL.md` → bundled to `dist/skills/` (`scripts/build.ts`,
  `bundleSkills`). Only the four `TASKWRIGHT_SKILL_NAMES` are shipped; the dev-only `visual-proof` /
  `agent-browser` skills are never bundled.
- Native install / discovery / uninstall: `src/core/agentSkills.ts`
  (`src/test/unit/agentSkills.test.ts`).
- Plugin manifest + bundle renderers: `src/core/codexPlugin.ts`
  (`src/test/unit/codexPlugin.test.ts`); assembly in `scripts/build.ts` (`bundleCodexPlugin`).
- Convention budget: `src/test/unit/agentConvention.test.ts`.
