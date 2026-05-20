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

/**
 * E2E tests for parseSecretsOutput against the real sonar-secrets binary.
 *
 * Verify that our plain-text stdout parser correctly handles the actual binary
 * output format. If the binary changes its output format, these tests catch it.
 *
 * Skipped when the binary is not installed.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { resolveSecretsBinaryPath } from '../../src/cli/commands/_common/install/secrets';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../../src/cli/commands/analyze/secrets';
import { parseSecretsOutput } from '../../src/cli/commands/analyze/secrets-output';
import type { ResolvedAuth } from '../../src/lib/auth-resolver';
import { FakeSonarQubeServerBuilder } from '../integration/harness';

const TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(TEST_TIMEOUT_MS);

// sonar-ignore-next-line
const GITHUB_TEST_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';

const binaryPath = resolveSecretsBinaryPath();
// Non-null path used in tests: safe because describe.skipIf guards against null.
const installedBinaryPath = binaryPath ?? '';

describe.skipIf(binaryPath === null)('parseSecretsOutput — real binary', () => {
  let tempDir: string;
  let auth: ResolvedAuth;
  let server: Awaited<ReturnType<InstanceType<typeof FakeSonarQubeServerBuilder>['start']>>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `sonar-e2e-secrets-parser-${crypto.randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });

    server = await new FakeSonarQubeServerBuilder().withAuthToken('e2e-token').start();

    auth = {
      serverUrl: server.baseUrl(),
      token: 'e2e-token',
      connectionType: 'cloud',
      orgKey: 'test-org',
    };

    // Allow HTTP for the local fake server
    process.env['SONAR_SECRETS_ALLOW_UNSECURE_HTTP'] = 'true';
  });

  afterEach(async () => {
    delete process.env['SONAR_SECRETS_ALLOW_UNSECURE_HTTP'];
    await server.stop().catch(() => {});
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses a single-file secret correctly', async () => {
    const filePath = join(tempDir, 'leaked.ts');
    writeFileSync(filePath, `const token = "${GITHUB_TEST_TOKEN}";`);

    const result = await runSecretsBinary(installedBinaryPath, [filePath], auth, 'pipe');

    expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

    const issues = parseSecretsOutput(result.stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBeTruthy();
    expect(issues[0].file).toContain('leaked.ts');
    expect(issues[0].location).not.toBeNull();
    expect(issues[0].location?.startLine).toBeGreaterThan(0);
    expect(issues[0].secret).toBeTruthy();
  });

  it('returns empty array for a clean file', async () => {
    const filePath = join(tempDir, 'clean.ts');
    writeFileSync(filePath, 'const x = 1;');

    const result = await runSecretsBinary(installedBinaryPath, [filePath], auth, 'pipe');

    expect(result.exitCode).toBe(0);

    const issues = parseSecretsOutput(result.stdout);
    expect(issues).toHaveLength(0);
  });

  it('parses secrets from multiple files', async () => {
    const file1 = join(tempDir, 'file1.ts');
    const file2 = join(tempDir, 'file2.ts');
    writeFileSync(file1, `const a = "${GITHUB_TEST_TOKEN}";`);
    writeFileSync(file2, `const b = "${GITHUB_TEST_TOKEN}";`);

    const result = await runSecretsBinary(installedBinaryPath, [file1, file2], auth, 'pipe');

    expect(result.exitCode).toBe(EXIT_CODE_SECRETS_FOUND);

    const issues = parseSecretsOutput(result.stdout);

    expect(issues.length).toBeGreaterThanOrEqual(2);
    const files = issues.map((i) => i.file);
    expect(files.some((f) => f.includes('file1.ts'))).toBe(true);
    expect(files.some((f) => f.includes('file2.ts'))).toBe(true);
  });
});
