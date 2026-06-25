import { describe, expect, it } from 'bun:test';

import { Version } from '../../../../../src/cli/commands/_common/version';

describe('Version', () => {
  it('exposes the full version and derived major.minor.patch version', () => {
    const version = new Version('1.2.3.456');

    expect(version.text).toBe('1.2.3.456');
    expect(version.noBuild).toBeInstanceOf(Version);
    expect(version.noBuild.text).toBe('1.2.3');
  });

  it('stringifies to the full version', () => {
    expect(String(new Version('1.2.3.456'))).toBe('1.2.3.456');
  });

  it('returns true when this version has a newer version', () => {
    const current = new Version('1.2.3');
    const latest = new Version('1.3.0.456');

    expect(latest.isNewerThan(current)).toBe(true);
  });

  it('considers build-number differences when comparing full versions', () => {
    const current = new Version('1.2.3');
    const latest = new Version('1.2.3.456');

    expect(latest.isNewerThan(current)).toBe(true);
  });
});
