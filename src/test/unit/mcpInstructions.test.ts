import { describe, expect, it } from 'vitest';
import { TASKWRIGHT_MCP_INSTRUCTIONS } from '../../mcp/instructions';

describe('TASKWRIGHT_MCP_INSTRUCTIONS', () => {
  it('keeps the critical cross-tool session workflow self-contained', () => {
    const critical = TASKWRIGHT_MCP_INSTRUCTIONS.slice(0, 512);

    expect(critical).toContain('get_active_task');
    expect(critical).toContain('claim_task');
    expect(critical).toContain('edit_task');
    expect(critical).toContain('request_merge');
    expect(critical).toContain('worktree');
  });

  it('warns agents away from the destructive/manual close paths', () => {
    expect(TASKWRIGHT_MCP_INSTRUCTIONS).toContain('Do not call complete_task');
    expect(TASKWRIGHT_MCP_INSTRUCTIONS).toContain('do not merge from the primary checkout');
  });
});
