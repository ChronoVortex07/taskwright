/**
 * Release metadata for the Taskwright MCP server, derived from the single source
 * of truth (`package.json`) so the version the server advertises to clients can
 * never drift from the shipped extension version (TASK-102 — it had been a
 * hand-written `0.0.1` placeholder while the package was at 1.x).
 *
 * esbuild inlines the JSON import at bundle time, so the standalone
 * `dist/mcp/server.js` reports the version of the build it came from with no
 * runtime file access — matching the "the running server reflects the primary
 * build" contract. The named `{ version }` import lets esbuild tree-shake the
 * rest of `package.json` out of the bundle.
 */
import { version } from '../../package.json';

/** The name the MCP server advertises to connecting clients. */
export const MCP_SERVER_NAME = 'taskwright';

/** The version the MCP server advertises — always the `package.json` version. */
export const MCP_SERVER_VERSION: string = version;
