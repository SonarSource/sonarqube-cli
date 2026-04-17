/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { fetchServerVersion, isAtLeast, normalizeVersion } from '../../src/lib/server-info';

describe('server-info', () => {
  describe('normalizeVersion', () => {
    it('shortens 4-digit year to 2-digit', () => {
      expect(normalizeVersion('2026.2')).toBe('26.2');
    });

    it('shortens 4-digit year with patch segment', () => {
      expect(normalizeVersion('2025.1.3')).toBe('25.1.3');
    });

    it('keeps 2-digit year as-is', () => {
      expect(normalizeVersion('26.2')).toBe('26.2');
    });

    it('keeps 2-digit year with patch segment as-is', () => {
      expect(normalizeVersion('25.1.3')).toBe('25.1.3');
    });

    it('shortens full version with patch and build number', () => {
      expect(normalizeVersion('2026.3.0.121998')).toBe('26.3.0.121998');
    });

    it('shortens version with qualifier', () => {
      expect(normalizeVersion('2026.2-SNAPSHOT')).toBe('26.2');
    });

    it('keeps short version with qualifier as-is', () => {
      expect(normalizeVersion('26.2-SNAPSHOT')).toBe('26.2');
    });

    it('handles dot-separated qualifier', () => {
      expect(normalizeVersion('2026.2.SNAPSHOT')).toBe('26.2');
    });
  });

  describe('isAtLeast', () => {
    it('returns true when version equals minimum', () => {
      expect(isAtLeast('26.2', '26.2')).toBe(true);
    });

    it('returns true when version is above minimum', () => {
      expect(isAtLeast('26.3', '26.2')).toBe(true);
    });

    it('returns false when version is below minimum', () => {
      expect(isAtLeast('25.1', '26.2')).toBe(false);
    });

    it('handles commercial format against short minimum', () => {
      expect(isAtLeast('2026.2', '26.2')).toBe(true);
    });

    it('handles older commercial format against short minimum', () => {
      expect(isAtLeast('2025.1', '26.2')).toBe(false);
    });

    it('handles short format against commercial minimum', () => {
      expect(isAtLeast('26.2', '2026.2')).toBe(true);
    });

    it('handles full version with patch and build number', () => {
      expect(isAtLeast('2026.3.0.121998', '26.2')).toBe(true);
    });

    it('handles full version below minimum', () => {
      expect(isAtLeast('2025.1.0.99999', '26.2')).toBe(false);
    });

    it('handles version with qualifier', () => {
      expect(isAtLeast('2026.2-SNAPSHOT', '26.2')).toBe(true);
    });

    it('returns false when version is undefined', () => {
      expect(isAtLeast(undefined, '26.2')).toBe(false);
    });
  });

  describe('fetchServerVersion', () => {
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      fetchSpy = spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('returns version from /api/system/status', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ status: 'UP', version: '2026.2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const version = await fetchServerVersion('https://sonar.example.com');

      expect(version).toBe('2026.2');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://sonar.example.com/api/system/status');
      expect(options.headers).toHaveProperty('User-Agent');
    });

    it('strips trailing slash from server URL', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ status: 'UP', version: '26.2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await fetchServerVersion('https://sonar.example.com/');

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe('https://sonar.example.com/api/system/status');
    });

    it('throws on HTTP error', async () => {
      fetchSpy.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(fetchServerVersion('https://sonar.example.com')).rejects.toThrow('HTTP 503');
    });

    it('throws on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('Connection refused'));

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(fetchServerVersion('https://sonar.example.com')).rejects.toThrow(
        'Connection refused',
      );
    });

    it('throws when response has no version field', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ status: 'UP' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(fetchServerVersion('https://sonar.example.com')).rejects.toThrow(
        'did not return a version',
      );
    });
  });
});
