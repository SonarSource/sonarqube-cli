/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Tests for src/lib/self-update.ts

import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { compareVersions, fetchLatestCliVersion } from '../../src/lib/self-update.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.0.1', '0.0.1')).toBe(0);
  });

  it('returns negative when a is less than b', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
  });

  it('returns positive when a is greater than b', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('compares minor/patch segments numerically, not lexicographically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
  });
});

describe('fetchLatestCliVersion', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('returns the trimmed version string on success', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '1.5.0\n',
    } as Response);

    const version = await fetchLatestCliVersion();
    expect(version).toBe('1.5.0');
  });

  it('throws when the server returns a non-OK response', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as Response);

    expect(fetchLatestCliVersion()).rejects.toThrow('Failed to fetch latest version: 503 Service Unavailable');
  });

  it('throws when the response body is empty', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '   ',
    } as Response);

    expect(fetchLatestCliVersion()).rejects.toThrow('Could not determine latest version');
  });

  it('throws when the network request fails', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    expect(fetchLatestCliVersion()).rejects.toThrow('network error');
  });
});
