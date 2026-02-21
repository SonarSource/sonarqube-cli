// Unit tests for sonar verify command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { verifyCommand } from '../../src/commands/verify.js';
import { setMockUi } from '../../src/ui';
import { createMockKeytar } from '../helpers/mock-keytar.js';

const keytarHandle = createMockKeytar();

describe('verifyCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when required params are missing', async () => {
    await verifyCommand({ file: '' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
