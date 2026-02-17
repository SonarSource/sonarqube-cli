import { describe, it, expect } from 'bun:test';
import { findAssetForPlatform } from '../../src/lib/github-releases';
import type { GitHubRelease } from '../../src/lib/install-types';

describe('github-releases', () => {
  describe('findAssetForPlatform', () => {
    it('should find asset by exact name', () => {
      const release: GitHubRelease = {
        tag_name: 'v2.38.0.10279',
        name: 'Release v2.38.0.10279',
        assets: [
          {
            name: 'sonar-secrets-2.38.0.10279-linux-x86-64',
            browser_download_url: 'https://github.com/.../download/linux',
            size: 1024
          },
          {
            name: 'sonar-secrets-2.38.0.10279-macos-arm64',
            browser_download_url: 'https://github.com/.../download/macos',
            size: 2048
          }
        ]
      };

      const asset = findAssetForPlatform(release, 'sonar-secrets-2.38.0.10279-linux-x86-64');
      expect(asset).toBeDefined();
      expect(asset?.name).toBe('sonar-secrets-2.38.0.10279-linux-x86-64');
      expect(asset?.size).toBe(1024);
    });

    it('should return null if asset not found', () => {
      const release: GitHubRelease = {
        tag_name: 'v2.38.0.10279',
        name: 'Release v2.38.0.10279',
        assets: [
          {
            name: 'sonar-secrets-2.38.0.10279-linux-x86-64',
            browser_download_url: 'https://github.com/.../download/linux',
            size: 1024
          }
        ]
      };

      const asset = findAssetForPlatform(release, 'sonar-secrets-2.38.0.10279-windows-x86-64.exe');
      expect(asset).toBeNull();
    });

    it('should handle empty assets array', () => {
      const release: GitHubRelease = {
        tag_name: 'v2.38.0.10279',
        name: 'Release v2.38.0.10279',
        assets: []
      };

      const asset = findAssetForPlatform(release, 'sonar-secrets-2.38.0.10279-linux-x86-64');
      expect(asset).toBeNull();
    });

    it('should find correct asset when multiple exist', () => {
      const release: GitHubRelease = {
        tag_name: 'v2.38.0.10279',
        name: 'Release v2.38.0.10279',
        assets: [
          {
            name: 'sonar-secrets-2.38.0.10279-linux-x86-64',
            browser_download_url: 'https://github.com/.../download/linux',
            size: 1024
          },
          {
            name: 'sonar-secrets-2.38.0.10279-macos-arm64',
            browser_download_url: 'https://github.com/.../download/macos-arm64',
            size: 2048
          },
          {
            name: 'sonar-secrets-2.38.0.10279-windows-x86-64.exe',
            browser_download_url: 'https://github.com/.../download/windows',
            size: 3072
          }
        ]
      };

      const asset = findAssetForPlatform(release, 'sonar-secrets-2.38.0.10279-macos-arm64');
      expect(asset).toBeDefined();
      expect(asset?.name).toBe('sonar-secrets-2.38.0.10279-macos-arm64');
      expect(asset?.size).toBe(2048);
    });
  });
});
