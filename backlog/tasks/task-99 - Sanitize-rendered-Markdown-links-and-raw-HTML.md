---
id: TASK-99
title: Sanitize rendered Markdown links and raw HTML
type: bug
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 09:20'
labels: []
dependencies: []
priority: high
category: Core Board
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 16:58'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Harden all rendered task/document Markdown against unsafe URL schemes such as javascript: and dangerous raw HTML. Centralize the policy, preserve expected safe links, and add adversarial unit plus webview coverage.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 javascript:, data:, vbscript:, encoded, and mixed-case unsafe link targets cannot execute from any rendered Markdown surface
- [x] #2 Raw HTML is disabled or sanitized with a documented allowlist
- [x] #3 Safe http, https, mailto, workspace-relative, and task-reference links retain expected behavior
- [x] #4 Unit and Playwright tests cover adversarial payloads and link activation
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Centralized the URL-safety policy in a new pure, dependency-free core module src/core/sanitizeUrl.ts (isSafeUrl / urlScheme / isRelativeUrl / sanitizeUrlAttributes + SAFE_URL_SCHEMES allowlist = http/https/mailto). urlScheme HTML-entity-decodes (numeric + named e.g. &colon;/&Tab;) and strips whitespace/control chars before matching the scheme, so mixed-case, whitespace-, control-char- and entity-obfuscated javascript:/data:/vbscript: are all detected; schemeless (relative/#fragment/query) URLs are treated as safe. Percent-encoded schemes are intentionally inert (a '%' is invalid in a scheme, so browsers navigate to them as relative paths, not code).

Provider-side (THE choke point): all task/document Markdown funnels through src/core/parseMarkdown.ts. Added sanitizeUrlAttributes() after marked.parse and before addLinkTitles, so every marked-emitted href/src with an unsafe scheme has the attribute dropped (leaving an inert <a>text</a>) and no title ever reflects a stripped dangerous URL. Raw HTML stays disabled by the existing source-side sanitizeMarkdownSource (escapes <letter), verified end-to-end.

Webview (defense in depth): the three markdown click handlers (ContentDetail.svelte, CompactTaskDetails.svelte, MarkdownSection.svelte) now import the same core policy and block navigation on unsafe schemes even if one ever reaches the DOM; safe external schemes keep default navigation and workspace-relative links keep opening via openWorkspaceFile. The webview already imports pure core modules (treeGate precedent), so there is exactly one policy with no drift.

Coverage: src/test/unit/sanitizeUrl.test.ts (24 adversarial cases), extended src/test/unit/parseMarkdown.test.ts (13 end-to-end cases incl. reference-style/autolink/mixed-case/entity/data/vbscript + raw-HTML-escaped assertions), and e2e/markdown-sanitization.spec.ts (4 Playwright link-activation cases proving a javascript: click neither executes nor opens a file, and safe relative/external links behave). Full suite: 2024 unit tests + 4 Playwright pass; lint + typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Hardened all rendered task/document Markdown against unsafe URL schemes and raw HTML via a single centralized policy (src/core/sanitizeUrl.ts). Output-side sanitization in parseMarkdown strips dangerous href/src (javascript:/data:/vbscript:, incl. encoded/mixed-case/whitespace-obfuscated) while preserving http/https/mailto/workspace-relative/task-reference links; raw HTML remains disabled (escaped) with the policy documented in-module. The same policy guards the three webview link-click handlers for defense in depth. Adversarial unit + Playwright coverage added.
<!-- SECTION:FINAL_SUMMARY:END -->
