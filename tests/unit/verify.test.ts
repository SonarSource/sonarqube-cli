// Unit tests for sonar verify command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyCommand } from '../../src/commands/verify.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
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

  it('exits 0 when analysis succeeds', async () => {
    const testDir = join(tmpdir(), `test-verify-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');

    const loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    const postSpy = spyOn(SonarQubeClient.prototype, 'post').mockResolvedValue({ issues: [] });

    try {
      await verifyCommand({
        file: testFile,
        token: 'test-token',
        organizationKey: 'test-org',
        projectKey: 'test-project',
      });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      loadStateSpy.mockRestore();
      postSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
