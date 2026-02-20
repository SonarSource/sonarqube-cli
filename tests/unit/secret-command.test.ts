// Tests for secret command installation

import { describe, it, expect } from 'bun:test';
import { detectPlatform, buildAssetName, buildLocalBinaryName } from '../../src/lib/platform-detector.js';
import type { PlatformInfo } from '../../src/lib/install-types.js';

describe('Platform Detection and Binary Naming', () => {
  it('detectPlatform: returns valid OS and architecture from current system', () => {
    const platform = detectPlatform();

    expect(platform).toBeDefined();
    expect(platform.os).toBeDefined();
    expect(platform.arch).toBeDefined();
    expect(['macos', 'linux', 'windows']).toContain(platform.os);
    expect(['x86-64', 'arm64', 'arm', '386']).toContain(platform.arch);
    expect(typeof platform.extension).toBe('string');
  });

  it('buildAssetName: generates correct GitHub release asset names for all platforms/architectures', () => {
    // Unix platforms
    const linuxX64 = buildAssetName('1.0.0', { os: 'linux', arch: 'x86-64', extension: '' });
    expect(linuxX64).toBe('sonar-secrets-1.0.0-linux-x86-64');

    const linuxArm = buildAssetName('1.0.0', { os: 'linux', arch: 'arm64', extension: '' });
    expect(linuxArm).toContain('arm64');

    // macOS
    const macosArm = buildAssetName('1.0.0', { os: 'darwin', arch: 'arm64', extension: '' });
    expect(macosArm).toContain('darwin');
    expect(macosArm).toContain('arm64');

    // Windows with .exe extension
    const windowsExe = buildAssetName('1.0.0', { os: 'windows', arch: 'x86-64', extension: '.exe' });
    expect(windowsExe).toBe('sonar-secrets-1.0.0-windows-x86-64.exe');

    // Version handling (v prefix stripping)
    const versionWithV = buildAssetName('v2.1.0', { os: 'linux', arch: 'x86-64', extension: '' });
    expect(versionWithV).toContain('2.1.0');
    expect(versionWithV).not.toContain('v2.1.0');
  });

  it('buildLocalBinaryName: generates local filenames without version or path separators', () => {
    // Unix: no extension
    const unixBinary = buildLocalBinaryName({ os: 'linux', arch: 'x86-64', extension: '' });
    expect(unixBinary).toBe('sonar-secrets');
    expect(unixBinary.includes('/')).toBe(false);
    expect(unixBinary.includes('\\')).toBe(false);

    // Windows: .exe extension
    const windowsBinary = buildLocalBinaryName({ os: 'windows', arch: 'x86-64', extension: '.exe' });
    expect(windowsBinary).toBe('sonar-secrets.exe');

    // macOS
    const macosBinary = buildLocalBinaryName({ os: 'darwin', arch: 'arm64', extension: '' });
    expect(macosBinary).toBe('sonar-secrets');
  });

  it('All OS and architecture combinations produce valid asset names', () => {
    const osList = ['linux', 'darwin', 'windows'];
    const archList = ['x86-64', 'arm64'];

    osList.forEach((os) => {
      archList.forEach((arch) => {
        const platform: PlatformInfo = {
          os: os as any,
          arch,
          extension: os === 'windows' ? '.exe' : ''
        };

        const assetName = buildAssetName('1.0.0', platform);
        const localName = buildLocalBinaryName(platform);

        expect(assetName).toContain('sonar-secrets');
        expect(assetName).toContain(os);
        expect(assetName).toContain(arch);
        expect(localName).toBe('sonar-secrets' + platform.extension);
      });
    });
  });
});
