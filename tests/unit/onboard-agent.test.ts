// Unit tests for sonar onboard-agent command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { onboardAgentCommand } from '../../src/commands/onboard-agent.js';
import { setMockUi } from '../../src/ui';

describe('onboardAgentCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when unsupported agent is provided', async () => {
    await onboardAgentCommand('gemini', {});
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
