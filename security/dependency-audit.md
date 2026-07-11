# Dependency vulnerability audit & policy (TASK-100)

This document is the reviewed triage of the dependency vulnerabilities reported by
`bun audit`, the remediation decision for each, and the CI policy that prevents
regressions. It is the human-readable companion to the machine-readable
`security/audit-allowlist.json`, which the CI gate (`scripts/audit-gate.ts`)
consumes.

- **Last full review:** 2026-07-11 (bun 1.3.14).
- **Snapshot at review:** 46 `bun audit` rows → **45 unique advisories** (one
  advisory is double-listed by bun): 1 critical, 16 high, 20 moderate, 8 low.
- **Exceptions expire:** 2026-10-11 (re-review required by then — the gate fails
  on any expired entry).

## TL;DR — why (almost) everything is an accepted exception

1. **Nothing in this table ships to end users.** The published VSIX bundles only
   `dist/` (esbuild output) and explicitly excludes `node_modules/**` and
   `src/**` (see `.vscodeignore`). No dependency listed here is installed on an
   end user's machine; the shipped runtime code is only what esbuild bundles from
   the code paths the extension/MCP/webview actually import.
2. **The compatible `bun update` removes zero of them.** Every advisory here is
   pinned deep inside a dev/build/test tool's own transitive range
   (`vscode-extension-tester`, `release-it`, `generate-license-file`,
   `oxipng-bin`, `depcheck`, `eslint`, `jsdom`, `vite`); those tools have not
   shipped upgraded ranges, so `bun update` (compatible) leaves the count at 46.
3. **Force-overriding transitive versions is riskier than the exposure.** Forcing
   patched transitive versions into that dev tooling would risk breaking the
   e2e/packaging toolchain (which AC#3 requires intact and which cannot be fully
   re-verified on every platform locally) for effectively zero end-user security
   benefit, since none of it ships. The few genuinely-reachable ones
   (`dompurify`/`uuid` via `mermaid`; `js-yaml` 3.x via `gray-matter`) only ever
   process **the user's own board content** inside a CSP-restricted VS Code
   webview — no third-party/attacker input.

The durable control is therefore not a one-time bump but the **reviewed-baseline
audit gate** below, which forces every _new_ or _shipped-dependency_ advisory to
be triaged by a human, and forces these accepted exceptions to be re-reviewed on
expiry.

## Reachability classes

| Class                                            | Meaning                                                                                                                                                                                                                               | Practical exposure                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Dev/build/test only — not shipped**            | Transitive dep of a `devDependency`; never in the VSIX or on a user machine.                                                                                                                                                          | None for end users.                                                                                                       |
| **In runtime tree but unreachable**              | Present under `@modelcontextprotocol/sdk`, but the Taskwright MCP server uses the **stdio** transport with no HTTP server, rate-limiter, or subprocess-spawn path, so this code is not bundled into `dist/` nor reachable at runtime. | None (dead code path, not bundled).                                                                                       |
| **Reachable in webview (own content)**           | `dompurify`/`uuid` via `mermaid`, rendering diagrams from the user's own task content inside a CSP-restricted webview.                                                                                                                | Low — own content, sandboxed, no attacker input. Highest-priority to remediate when `mermaid` ships a patched transitive. |
| **Reachable in frontmatter parse (own content)** | The vulnerable `js-yaml` **3.x** reaches runtime via `gray-matter` parsing the user's own task-file frontmatter (the **direct** `js-yaml@4.x` is _not_ affected — the advisory range is `<3.15.0`).                                   | Low — DoS-only, own content.                                                                                              |

## Full triage

Every reported advisory, mapped to its top-level direct dependency, reachability,
severity, and remediation decision:

<!-- AUDIT-TABLE:BEGIN (generated from `bun audit --json`; keep in sync with security/audit-allowlist.json) -->

| Package                | Advisory                                                                 | Severity | Direct dependency (type)                                                                          | Reachability                                 | Decision                                    |
| ---------------------- | ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `decompress`           | [GHSA-mp2f-45pm-3cg9](https://github.com/advisories/GHSA-mp2f-45pm-3cg9) | critical | oxipng-bin (dev)                                                                                  | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `basic-ftp`            | [GHSA-rpmf-866q-6p89](https://github.com/advisories/GHSA-rpmf-866q-6p89) | high     | release-it (dev)                                                                                  | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `basic-ftp`            | [GHSA-rp42-5vxx-qpwr](https://github.com/advisories/GHSA-rp42-5vxx-qpwr) | high     | release-it (dev)                                                                                  | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `cross-spawn`          | [GHSA-3xgq-45jj-v275](https://github.com/advisories/GHSA-3xgq-45jj-v275) | high     | eslint / @modelcontextprotocol/sdk / vscode-extension-tester / generate-license-file / oxipng-bin | In runtime tree but unreachable              | Time-bounded exception (expires 2026-10-11) |
| `fast-uri`             | [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) | high     | @modelcontextprotocol/sdk / eslint / vscode-extension-tester (via ajv)                            | In runtime tree but unreachable              | Time-bounded exception (expires 2026-10-11) |
| `fast-uri`             | [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) | high     | @modelcontextprotocol/sdk / eslint / vscode-extension-tester (via ajv)                            | In runtime tree but unreachable              | Time-bounded exception (expires 2026-10-11) |
| `form-data`            | [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) | high     | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `http-cache-semantics` | [GHSA-rc47-6667-2j5j](https://github.com/advisories/GHSA-rc47-6667-2j5j) | high     | vscode-extension-tester / generate-license-file / oxipng-bin (dev)                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `linkify-it`           | [GHSA-22p9-wv53-3rq4](https://github.com/advisories/GHSA-22p9-wv53-3rq4) | high     | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `semver-regex`         | [GHSA-44c6-4v22-4mhx](https://github.com/advisories/GHSA-44c6-4v22-4mhx) | high     | oxipng-bin (dev)                                                                                  | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `serialize-javascript` | [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq) | high     | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `sigstore`             | [GHSA-52v5-jr5w-gjxr](https://github.com/advisories/GHSA-52v5-jr5w-gjxr) | high     | generate-license-file (dev)                                                                       | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `tmp`                  | [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) | high     | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-vmh5-mc38-953g](https://github.com/advisories/GHSA-vmh5-mc38-953g) | high     | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q) | high     | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-hm92-r4w5-c3mj](https://github.com/advisories/GHSA-hm92-r4w5-c3mj) | high     | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `ws`                   | [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | high     | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `@sigstore/core`       | [GHSA-jfc7-64v2-mr8c](https://github.com/advisories/GHSA-jfc7-64v2-mr8c) | moderate | generate-license-file (dev)                                                                       | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `@sigstore/verify`     | [GHSA-xgjw-pm74-86q4](https://github.com/advisories/GHSA-xgjw-pm74-86q4) | moderate | generate-license-file (dev)                                                                       | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `brace-expansion`      | [GHSA-jxxr-4gwj-5jf2](https://github.com/advisories/GHSA-jxxr-4gwj-5jf2) | moderate | eslint / depcheck / typescript-eslint / generate-license-file / vscode-extension-tester (dev)     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-76mc-f452-cxcm](https://github.com/advisories/GHSA-76mc-f452-cxcm) | moderate | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-hpcv-96wg-7vj8](https://github.com/advisories/GHSA-hpcv-96wg-7vj8) | moderate | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-r47g-fvhr-h676](https://github.com/advisories/GHSA-r47g-fvhr-h676) | moderate | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-rp9w-3fw7-7cwq](https://github.com/advisories/GHSA-rp9w-3fw7-7cwq) | moderate | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-cmwh-pvxp-8882](https://github.com/advisories/GHSA-cmwh-pvxp-8882) | moderate | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `got`                  | [GHSA-pfrx-2q88-qq97](https://github.com/advisories/GHSA-pfrx-2q88-qq97) | moderate | vscode-extension-tester / oxipng-bin (dev)                                                        | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `ip-address`           | [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) | moderate | @modelcontextprotocol/sdk / release-it / generate-license-file                                    | In runtime tree but unreachable              | Time-bounded exception (expires 2026-10-11) |
| `js-yaml`              | [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | moderate | gray-matter (runtime) / depcheck, vscode-extension-tester, generate-license-file (dev)            | Reachable in frontmatter parse (own content) | Time-bounded exception (expires 2026-10-11) |
| `markdown-it`          | [GHSA-6v5v-wf23-fmfq](https://github.com/advisories/GHSA-6v5v-wf23-fmfq) | moderate | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `postcss`              | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | moderate | vite / depcheck (dev)                                                                             | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `qs`                   | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) | moderate | @modelcontextprotocol/sdk / vscode-extension-tester                                               | In runtime tree but unreachable              | Time-bounded exception (expires 2026-10-11) |
| `serialize-javascript` | [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) | moderate | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `tar`                  | [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh) | moderate | generate-license-file (dev)                                                                       | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-p88m-4jfj-68fv](https://github.com/advisories/GHSA-p88m-4jfj-68fv) | moderate | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-pr7r-676h-xcf6](https://github.com/advisories/GHSA-pr7r-676h-xcf6) | moderate | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `uuid`                 | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | moderate | mermaid (runtime, webview) / vscode-extension-tester (dev)                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `ws`                   | [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) | moderate | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `diff`                 | [GHSA-73rr-hh4g-fpgx](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) | low      | vscode-extension-tester (dev)                                                                     | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-x4vx-rjvf-j5p4](https://github.com/advisories/GHSA-x4vx-rjvf-j5p4) | low      | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-vxr8-fq34-vvx9](https://github.com/advisories/GHSA-vxr8-fq34-vvx9) | low      | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `dompurify`            | [GHSA-gvmj-g25r-r7wr](https://github.com/advisories/GHSA-gvmj-g25r-r7wr) | low      | mermaid (runtime, webview)                                                                        | Reachable in webview (own content)           | Time-bounded exception (expires 2026-10-11) |
| `esbuild`              | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | low      | esbuild (direct dev) / vite                                                                       | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `semver-regex`         | [GHSA-4x5v-gmq8-25ch](https://github.com/advisories/GHSA-4x5v-gmq8-25ch) | low      | oxipng-bin (dev)                                                                                  | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-35p6-xmwp-9g52](https://github.com/advisories/GHSA-35p6-xmwp-9g52) | low      | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |
| `undici`               | [GHSA-g8m3-5g58-fq7m](https://github.com/advisories/GHSA-g8m3-5g58-fq7m) | low      | release-it / jsdom / vscode-extension-tester (dev)                                                | Dev/build/test only — not shipped            | Time-bounded exception (expires 2026-10-11) |

<!-- AUDIT-TABLE:END -->

## The CI audit gate (policy)

`scripts/audit-gate.ts` (pure logic in `src/core/auditGate.ts`, unit-tested in
`src/test/unit/auditGate.test.ts`) runs `bun audit --json` and evaluates it
against `security/audit-allowlist.json`. It is wired into CI as the **Dependency
audit gate** step (and into the `ci` npm script) and runs locally via
`bun run audit:gate`.

**Documented threshold.** The allowlist declares `"threshold": "high"`. The gate
**fails the build** when either:

1. an advisory at or above the threshold severity is **not** on the allowlist
   (a newly published or newly introduced advisory), or
2. an allowlist entry has **expired** (`expires` is in the past).

Findings below the threshold, and findings covered by a live allowlist entry, are
**reported but do not fail** the build.

**Why this is not "vulnerable to unreviewed advisory churn."** A naïve
`bun audit --audit-level=high` gate flaps red the moment a new advisory is
published against an unchanged dependency — pressuring maintainers to weaken or
disable it. This gate instead pins the green baseline to a **curated, reviewed
allowlist**: the current known set is deterministic and green, while any _new_
high/critical advisory (churn) surfaces as a failure a human must consciously
triage — remediate it, or add a reviewed, time-bounded exception. Exceptions
cannot rot silently because every entry **expires** and re-fails the gate on its
date. Advisories on genuinely-shipped/reachable dependencies are the ones the
threshold is designed to catch first.

## Runbook — how to respond when the gate fails

1. **A new advisory failed the gate.** Read it (`bun run audit`). Decide:
   - _Reachable / shipped?_ Remediate: upgrade the direct dependency, add a
     `bun` override for the transitive version, or replace the dependency. Then
     re-run `bun run audit:gate`.
   - _Dev-only / unreachable?_ Add a reviewed entry to
     `security/audit-allowlist.json` with an honest `reason`, the reachability
     `category`, and a near-term `expires`, and add the corresponding row to the
     table above.
2. **An exception expired.** Re-review it. If upstream has shipped a fix, remove
   the entry (and its table row) and let `bun audit` confirm it is gone. If not,
   renew `expires` with a fresh review note.
3. **Prune stale entries.** The gate prints allowlist entries that match no
   current finding ("prunable") — remove those and their table rows.

Keep this table and `security/audit-allowlist.json` in sync — the allowlist is
the enforced source of truth; this document is the human rationale.
