// Unit tests for sonar secret install command

import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockUi } from '../../src/ui';
import { detectPlatform, buildAssetName, buildLocalBinaryName } from '../../src/lib/platform-detector.js';
import * as processLib from '../../src/lib/process.js';
import type { GitHubRelease, GitHubAsset } from '../../src/lib/install-types.js';

// Configurable mock implementations — changed per test as needed
let mockFetchLatestRelease: () => Promise<GitHubRelease> = async () => {
  throw new Error('network unavailable');
};
let mockDownloadBinary: (url: string, path: string) => Promise<void> = async () => {};

// Mock github-releases module BEFORE importing secret.ts (which depends on it).
// findAssetForPlatform uses the real implementation to avoid contaminating github-releases.test.ts,
// since Bun shares the module registry across test files in the same process.
mock.module('../../src/lib/github-releases.js', () => ({
  fetchLatestRelease: () => mockFetchLatestRelease(),
  findAssetForPlatform: (release: GitHubRelease, assetName: string): GitHubAsset | null =>
    release.assets.find(a => a.name === assetName) ?? null,
  downloadBinary: (url: string, path: string) => mockDownloadBinary(url, path),
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
    // Reset mock implementations to default (failing)
    mockFetchLatestRelease = async () => { throw new Error('network unavailable'); };
    mockDownloadBinary = async () => {};
  });

  it('exits 1 when binary installation fails', async () => {
    await secretInstallCommand({ force: true });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 0 when installation succeeds', async () => {
    const tempBinDir = join(tmpdir(), `sonar-install-test-${Date.now()}`);
    const platform = detectPlatform();
    const version = '1.0.0';
    const assetName = buildAssetName(`v${version}`, platform);

    mockFetchLatestRelease = async () => ({
      tag_name: `v${version}`,
      assets: [{
        name: assetName,
        browser_download_url: 'https://fake.example.com/release',
        size: 1024,
        content_type: 'application/octet-stream',
      }],
    } as GitHubRelease);

    mockDownloadBinary = async (_url: string, path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ''); // empty placeholder so chmod in makeExecutable succeeds
    };

    // spyOn so verifyInstallation returns a version without executing the binary
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0, stdout: `sonar-secrets version ${version}\n`, stderr: '',
    });

    try {
      await secretInstallCommand({ force: true }, { binDir: tempBinDir });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      spawnSpy.mockRestore();
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });
});
