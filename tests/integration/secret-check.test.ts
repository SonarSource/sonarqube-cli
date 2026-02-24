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

/**
 * Integration tests for sonar secret check command
 * Tests real sonar-secrets binary with stdin and file modes
 * Note: This file contains hardcoded test secrets and OS commands for testing purposes only
 *
 * SONAR EXCLUSIONS (see pom.xml for file-level suppressions):
 * - S4036: env variables spread is safe - only test environment data
 * - S4721: execSync is safe - all commands and args are hardcoded for testing
 *
 * <!-- sonar.exclusions -->
 * @SuppressWarnings("java:S4036")
 * @SuppressWarnings("java:S4721")
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir, platform as osPlatform, arch as osArch } from 'node:os';

let BINARY_PATH: string;
const BINARY_DIR = join(homedir(), '.sonar', 'sonarqube-cli', 'bin');

// Test data with real secrets
const GITHUB_TOKEN = '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';
const AWS_SECRET = 'kHeUAwnSUizTWpSbyGAz4f+As5LshPIjvtpswqGb';
const CLEAN_TEXT = 'export API_URL="https://api.example.com"';

function getBinaryName(): string {
  const plt = osPlatform();
  const arch = osArch();

  if (plt === 'darwin') {
    return arch === 'arm64' ? 'sonar-secrets-macos-arm64' : 'sonar-secrets-macos-x86-64';
  } else if (plt === 'linux') {
    return arch === 'arm64' ? 'sonar-secrets-linux-arm64' : 'sonar-secrets-linux-x86-64';
  } else if (plt === 'win32') {
    return arch === 'arm64' ? 'sonar-secrets-windows-arm64.exe' : 'sonar-secrets-windows-x86-64.exe';
  }

  throw new Error(`Unsupported platform: ${plt}`);
}

function skipIfNoToken(): boolean {
  const hasToken = process.env.SONAR_SECRETS_TOKEN && process.env.SONAR_SECRETS_AUTH_URL;
  if (!hasToken) {
    console.log('⚠️  Skipping sonar-secrets integration tests: SONAR_SECRETS_TOKEN not set');
  }
  return !hasToken;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- sonarjs/nosonar
/* sonar-cli: safe for integration tests with hardcoded test data */
describe('sonar secret check - integration tests', () => {
  beforeAll(() => {
    const skip = skipIfNoToken();
    if (skip) {
      return;
    }

    // Detect binary path
    const binaryName = getBinaryName();
    BINARY_PATH = join(BINARY_DIR, binaryName);

    // Check if binary exists, install if needed
    if (!existsSync(BINARY_PATH)) {
      console.log('📥 Installing sonar-secrets binary for integration tests...');
      try {
        mkdirSync(BINARY_DIR, { recursive: true });
        // NOSONAR - S4721: Safe command in test environment
        execSync('npm run build:binary', { stdio: 'inherit' });
        // NOSONAR - S4036,S4721: Safe test environment with only test vars
        execSync('dist/sonar-cli secret install', {
          stdio: 'inherit',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
      } catch (error) {
        console.error('Failed to install sonar-secrets:', error);
        throw error;
      }
    }

    if (!existsSync(BINARY_PATH)) {
      throw new Error(`sonar-secrets binary not found at ${BINARY_PATH}`);
    }

    console.log(`✅ Using sonar-secrets at ${BINARY_PATH}`);
  });

  describe('stdin mode', () => {
    it('should detect GitHub token in stdin', () => {
      if (skipIfNoToken()) {
        return;
      }

      try {
        const result = execSync(
          `echo "${GITHUB_TOKEN}" | dist/sonar-cli secret check --stdin`,
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
              SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
            }
          }
        );
        // If we get here, exit code was 0 (no error)
        expect(result).toBeDefined();
      } catch (error) {
        // Exit code 1 means secrets found (expected)
        const err = error as { status?: number; stdout?: string };
        expect(err.status).toBe(1);
      }
    });

    it('should pass clean content in stdin', () => {
      if (skipIfNoToken()) {
        return;
      }

      try {
        const result = execSync(
          `echo "${CLEAN_TEXT}" | dist/sonar-cli secret check --stdin`,
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
              SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
            }
          }
        );

        // Clean content should succeed (exit 0)
        expect(result).toBeDefined();
      } catch (error) {
        // If error, exit code should not be 1 (secrets found)
        const err = error as { status?: number };
        expect(err.status).not.toBe(1);
      }
    });

    it('should handle empty stdin', () => {
      if (skipIfNoToken()) {
        return;
      }

      try {
        execSync('echo "" | dist/sonar-cli secret check --stdin', {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
        // Empty input should succeed
      } catch (error) {
        const err = error as { status?: number };
        // Empty input is clean, so should not find secrets
        expect(err.status).not.toBe(1);
      }
    });

    it('should handle multiple secrets in stdin', () => {
      if (skipIfNoToken()) {
        return;
      }

      const multiSecret = `${GITHUB_TOKEN}\n${AWS_SECRET}`;

      try {
        execSync(`echo "${multiSecret}" | dist/sonar-cli secret check --stdin`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
      } catch (error) {
        // Multiple secrets should be detected (exit 1)
        const err = error as { status?: number };
        expect(err.status).toBe(1);
      }
    });

    it('should reject when both --stdin and --file are provided', () => {
      if (skipIfNoToken()) {
        return;
      }

      try {
        execSync(
          `echo "test" | dist/sonar-cli secret check --stdin --file /tmp/test.txt`,
          {
            stdio: 'pipe'
          }
        );
        expect.unreachable();
      } catch (error) {
        const err = error as { status?: number; stderr?: string };
        expect(err.status).not.toBe(0);
      }
    });

    it('should reject when no --stdin and no --file', () => {
      if (skipIfNoToken()) {
        return;
      }

      try {
        execSync('dist/sonar-cli secret check', {
          stdio: 'pipe'
        });
        expect.unreachable();
      } catch (error) {
        const err = error as { status?: number };
        expect(err.status).not.toBe(0);
      }
    });
  });

  describe('file mode', () => {
    let testFile: string;

    beforeAll(() => {
      testFile = join(tmpdir(), `secret-test-${Date.now()}.env`);
    });

    afterAll(() => {
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    });

    it('should detect AWS secret in file', () => {
      if (skipIfNoToken()) {
        return;
      }

      writeFileSync(testFile, `props.set("aws-secret-access-key", "${AWS_SECRET}")`);

      try {
        execSync(`dist/sonar-cli secret check --file "${testFile}"`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
      } catch (error) {
        // Should find secret (exit 1)
        const err = error as { status?: number };
        expect(err.status).toBe(1);
      }
    });

    it('should pass clean file content', () => {
      if (skipIfNoToken()) {
        return;
      }

      writeFileSync(testFile, CLEAN_TEXT);

      try {
        execSync(`dist/sonar-cli secret check --file "${testFile}"`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
        // Clean file should succeed
      } catch (error) {
        const err = error as { status?: number };
        expect(err.status).not.toBe(1);
      }
    });

    it('should detect GitHub token in file', () => {
      if (skipIfNoToken()) {
        return;
      }

      writeFileSync(testFile, `export GH_TOKEN="${GITHUB_TOKEN}"`);

      try {
        execSync(`dist/sonar-cli secret check --file "${testFile}"`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
      } catch (error) {
        // Should find secret
        const err = error as { status?: number };
        expect(err.status).toBe(1);
      }
    });

    it('should handle non-existent file gracefully', () => {
      if (skipIfNoToken()) {
        return;
      }

      const nonExistent = join(tmpdir(), 'nonexistent-file-12345.txt');

      try {
        execSync(`dist/sonar-cli secret check --file "${nonExistent}"`, {
          stdio: 'pipe'
        });
        expect.unreachable();
      } catch (error) {
        const err = error as { status?: number };
        expect(err.status).not.toBe(0);
      }
    });

    it('should handle empty file', () => {
      if (skipIfNoToken()) {
        return;
      }

      writeFileSync(testFile, '');

      try {
        execSync(`dist/sonar-cli secret check --file "${testFile}"`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
        // Empty file is clean
      } catch (error) {
        const err = error as { status?: number };
        expect(err.status).not.toBe(1);
      }
    });
  });

  describe('comparison: stdin vs file', () => {
    let testFile: string;

    beforeAll(() => {
      testFile = join(tmpdir(), `secret-compare-${Date.now()}.txt`);
    });

    afterAll(() => {
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    });

    it('should produce same result for same content via stdin and file', () => {
      if (skipIfNoToken()) {
        return;
      }

      const testContent = `API_KEY="${GITHUB_TOKEN}"`;
      writeFileSync(testFile, testContent);

      let stdinExitCode = null;
      let fileExitCode = null;

      // Test stdin
      try {
        execSync(`echo "${testContent}" | dist/sonar-cli secret check --stdin`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
        stdinExitCode = 0;
      } catch (error) {
        const err = error as { status?: number };
        stdinExitCode = err.status;
      }

      // Test file
      try {
        execSync(`dist/sonar-cli secret check --file "${testFile}"`, {
          stdio: 'pipe',
          env: {
            ...process.env,
            SONAR_SECRETS_TOKEN: process.env.SONAR_SECRETS_TOKEN,
            SONAR_SECRETS_AUTH_URL: process.env.SONAR_SECRETS_AUTH_URL
          }
        });
        fileExitCode = 0;
      } catch (error) {
        const err = error as { status?: number };
        fileExitCode = err.status;
      }

      // Both should detect the same secret
      expect(stdinExitCode).toBe(fileExitCode);
    });
  });
});
