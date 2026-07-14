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

  it('warns agents away from the manual close path', () => {
    expect(TASKWRIGHT_MCP_INSTRUCTIONS).toContain('do not merge from the primary checkout');
  });

  // TASK-133: complete_task is no longer registered as an MCP tool, so the instructions must not
  // spend their (truncation-prone) budget warning agents away from a tool they cannot call. The
  // warning existed only to defend against a surface we ourselves exposed.
  it('does not warn about complete_task, which is no longer an exposed tool', () => {
    expect(TASKWRIGHT_MCP_INSTRUCTIONS).not.toContain('complete_task');
  });
});
