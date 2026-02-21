// Unit tests for sonar secret install command

import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { setMockUi } from '../../src/ui';
import type { GitHubRelease, GitHubAsset } from '../../src/lib/install-types.js';

// Mock github-releases module BEFORE importing secret.ts (which depends on it).
// findAssetForPlatform uses the real implementation to avoid contaminating github-releases.test.ts,
// since Bun shares the module registry across test files in the same process.
mock.module('../../src/lib/github-releases.js', () => ({
  fetchLatestRelease: async () => { throw new Error('network unavailable'); },
  findAssetForPlatform: (release: GitHubRelease, assetName: string): GitHubAsset | null =>
    release.assets.find(a => a.name === assetName) ?? null,
  downloadBinary: async () => {},
}));

const { secretInstallCommand } = await import('../../src/commands/secret.js');

describe('secretInstallCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when binary installation fails', async () => {
    await secretInstallCommand({ force: true });
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
