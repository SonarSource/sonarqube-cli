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
  parseBrowserAuthCallback,
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

  describe('parseBrowserAuthCallback', () => {
    it('should extract token from valid JSON POST body', () => {
      const body = JSON.stringify({ token: 'squ_valid_token' });
      const result = parseBrowserAuthCallback(body);
      expect(result?.token).toBe('squ_valid_token');
    });

    it('should extract token name from valid JSON POST body', () => {
      const body = JSON.stringify({ token: 'squ_valid_token', name: 'cli-token-name' });
      const authResult = parseBrowserAuthCallback(body);
      expect(authResult).toEqual({ token: 'squ_valid_token', tokenName: 'cli-token-name' });
    });

    it('should parse a full real-world payload (login, name, token, createdAt)', () => {
      const body = JSON.stringify({
        login: 'admin',
        name: 'cli-token-name',
        token: 'squ_valid_token',
        createdAt: '2026-04-23T10:20:30+0200',
      });
      const authResult = parseBrowserAuthCallback(body);
      expect(authResult).toEqual({ token: 'squ_valid_token', tokenName: 'cli-token-name' });
    });

    it('should return undefined tokenName when name is empty', () => {
      const body = JSON.stringify({ token: 'squ_valid_token', name: '' });
      const authResult = parseBrowserAuthCallback(body);
      expect(authResult).toEqual({ token: 'squ_valid_token', tokenName: undefined });
    });

    it('should return undefined tokenName when name is not a string', () => {
      const body = JSON.stringify({ token: 'squ_valid_token', name: 42 });
      const authResult = parseBrowserAuthCallback(body);
      expect(authResult).toEqual({ token: 'squ_valid_token', tokenName: undefined });
    });

    it('should return undefined tokenName when name is missing', () => {
      const body = JSON.stringify({ token: 'squ_valid_token' });
      const authResult = parseBrowserAuthCallback(body);
      expect(authResult).toEqual({ token: 'squ_valid_token', tokenName: undefined });
    });

    it('should return undefined for missing token field', () => {
      const body = JSON.stringify({ data: 'something' });
      expect(parseBrowserAuthCallback(body)).toBeUndefined();
    });

    it('should return undefined for empty token', () => {
      const body = JSON.stringify({ token: '' });
      expect(parseBrowserAuthCallback(body)).toBeUndefined();
    });

    it('should return undefined for invalid JSON', () => {
      expect(parseBrowserAuthCallback('not json')).toBeUndefined();
    });

    it('should return undefined if token is not a string', () => {
      const body = JSON.stringify({ token: null });
      expect(parseBrowserAuthCallback(body)).toBeUndefined();
    });
  });
});
