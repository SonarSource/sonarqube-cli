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

import { describe, expect, it } from 'bun:test';

import {
  buildAuthURL,
  extractTokenFromPostBody,
} from '../../../../../src/cli/commands/_common/token';

const SONARCLOUD_SERVER = 'https://sonarcloud.io';
const SONARQUBE_CLOUD_US_SERVER = 'https://sonarqube.us';
const EXAMPLE_SERVER = 'https://sonar.example.com';
const TEST_PORT_A = 8080;
const TEST_PORT_B = 9000;

describe('Auth Helper Functions', () => {
  describe('buildAuthURL', () => {
    it('should build URL with clean server URL (no trailing slash)', () => {
      const url = buildAuthURL(SONARCLOUD_SERVER, TEST_PORT_A);
      expect(url).toBe(`${SONARCLOUD_SERVER}/auth?product=cli&port=${TEST_PORT_A}`);
    });

    it('should build URL and remove trailing slash', () => {
      const url = buildAuthURL(`${SONARCLOUD_SERVER}/`, TEST_PORT_B);
      expect(url).toBe(`${SONARCLOUD_SERVER}/auth?product=cli&port=${TEST_PORT_B}`);
    });

    it('should build URL for SQC US', () => {
      const url = buildAuthURL(`${SONARQUBE_CLOUD_US_SERVER}`, TEST_PORT_B);
      expect(url).toBe(`${SONARQUBE_CLOUD_US_SERVER}/auth?product=cli&port=${TEST_PORT_B}`);
    });

    it('should work with custom server URL', () => {
      const url = buildAuthURL(`${EXAMPLE_SERVER}/`, TEST_PORT_A);
      expect(url).toBe(
        `${EXAMPLE_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=${TEST_PORT_A}`,
      );
    });

    it('should use /auth for SQS >= 2026.2', () => {
      const url = buildAuthURL(EXAMPLE_SERVER, TEST_PORT_A, '2026.2');
      expect(url).toBe(`${EXAMPLE_SERVER}/auth?product=cli&port=${TEST_PORT_A}`);
    });

    it('should use /auth for SQS Community >= 26.2', () => {
      const url = buildAuthURL(EXAMPLE_SERVER, TEST_PORT_A, '26.2');
      expect(url).toBe(`${EXAMPLE_SERVER}/auth?product=cli&port=${TEST_PORT_A}`);
    });

    it('should use /sonarlint/auth for SQS < 2026.2', () => {
      const url = buildAuthURL(EXAMPLE_SERVER, TEST_PORT_A, '2025.1');
      expect(url).toBe(
        `${EXAMPLE_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=${TEST_PORT_A}`,
      );
    });

    it('should fallback to /sonarlint/auth when server version is unknown/SQC', () => {
      const url = buildAuthURL(EXAMPLE_SERVER, TEST_PORT_A, undefined);
      expect(url).toBe(
        `${EXAMPLE_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=${TEST_PORT_A}`,
      );
    });
  });

  describe('extractTokenFromPostBody', () => {
    it('should extract token from valid JSON POST body', () => {
      const body = JSON.stringify({ token: 'squ_valid_token' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBe('squ_valid_token');
    });

    it('should return undefined for missing token field', () => {
      const body = JSON.stringify({ data: 'something' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });

    it('should return undefined for empty token', () => {
      const body = JSON.stringify({ token: '' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });

    it('should return undefined for invalid JSON', () => {
      const token = extractTokenFromPostBody('not json');
      expect(token).toBeUndefined();
    });

    it('should return undefined if token is not a string', () => {
      const body = JSON.stringify({ token: null });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });
  });
});
