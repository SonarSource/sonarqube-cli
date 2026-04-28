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

// Integration tests for `sonar run mcp`

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { IS_WINDOWS, TestHarness } from '../../harness';

const EXECUTABLE_MODE = 0o755;
const PATH_SEP = IS_WINDOWS ? ';' : ':';

describe('run mcp', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /**
   * Writes a platform-appropriate fake docker binary that:
   * - exits 0 for `docker info` (runtime availability check)
   * - prints args and key env vars to stdout for `docker run`, echoes stdin, then exits with runExitCode
   * Returns the directory containing the fake binary so it can be prepended to PATH.
   *
   * On Unix: a shell script named `docker` (chmod 755).
   * On Windows: a batch script named `docker.cmd` (no chmod needed).
   */
  function setupFakeDocker(runExitCode = 0): string {
    const fakeBinDir = join(harness.cwd.path, 'fake-bin');

    if (IS_WINDOWS) {
      const script = [
        '@echo off',
        'if "%1"=="info" exit /b 0',
        'if "%1"=="run" (',
        '  echo ARGS: %*',
        '  echo ENV_TOKEN=%SONARQUBE_TOKEN%',
        '  echo ENV_URL=%SONARQUBE_URL%',
        '  echo ENV_PROJECT_KEY=%SONARQUBE_PROJECT_KEY%',
        '  echo ENV_DEBUG_ENABLED=%SONARQUBE_DEBUG_ENABLED%',
        '  echo ENV_READ_ONLY=%SONARQUBE_READ_ONLY%',
        '  echo ENV_TOOLSETS=%SONARQUBE_TOOLSETS%',
        '  more',
        `  exit /b ${runExitCode}`,
        ')',
        'exit /b 1',
      ].join('\r\n');
      harness.cwd.writeFile('fake-bin/docker.cmd', script);
    } else {
      const script = [
        '#!/bin/sh',
        'case "$1" in',
        '  info) exit 0 ;;',
        '  run)',
        String.raw`    printf "ARGS: %s\n" "$*"`,
        String.raw`    printf "ENV_TOKEN=%s\n" "$SONARQUBE_TOKEN"`,
        String.raw`    printf "ENV_URL=%s\n" "$SONARQUBE_URL"`,
        String.raw`    printf "ENV_PROJECT_KEY=%s\n" "$SONARQUBE_PROJECT_KEY"`,
        String.raw`    printf "ENV_DEBUG_ENABLED=%s\n" "$SONARQUBE_DEBUG_ENABLED"`,
        String.raw`    printf "ENV_READ_ONLY=%s\n" "$SONARQUBE_READ_ONLY"`,
        String.raw`    printf "ENV_TOOLSETS=%s\n" "$SONARQUBE_TOOLSETS"`,
        '    cat',
        `    exit ${runExitCode} ;;`,
        'esac',
        'exit 1',
      ].join('\n');
      harness.cwd.writeFile('fake-bin/docker', script);
      chmodSync(join(fakeBinDir, 'docker'), EXECUTABLE_MODE);
    }

    return fakeBinDir;
  }

  it(
    'invokes docker with correct project env and workspace mount when authenticated inside a discoverable project',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
      });

      expect(result.exitCode).toBe(0);
      // docker run was called with the project key passed via -e
      expect(result.stdout).toContain('-e SONARQUBE_PROJECT_KEY');
      // workspace was mounted
      expect(result.stdout).toContain('/app/mcp-workspace:ro');
      // correct image
      expect(result.stdout).toContain('mcp/sonarqube');
      // env vars were injected into the docker process
      expect(result.stdout).toContain('ENV_TOKEN=test-token');
      expect(result.stdout).toContain(`ENV_URL=${server.baseUrl()}`);
      expect(result.stdout).toContain('ENV_PROJECT_KEY=my-project');
    },
    { timeout: 15000 },
  );

  it(
    'invokes docker without project key or workspace mount when no project is discoverable in home directory',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      // no sonar-project.properties written
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp', {
        extraEnv: {
          PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}`,
        },
        cwd: harness.userHome.path,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('SONARQUBE_PROJECT_KEY');
      expect(result.stdout).not.toContain('/app/mcp-workspace:ro');
      expect(result.stdout).toContain('mcp/sonarqube');
      expect(result.stdout).toContain('ENV_TOKEN=test-token');
    },
    { timeout: 15000 },
  );

  it(
    'passes SONARQUBE_DEBUG_ENABLED=true to docker when --debug is set',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp --debug', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-e SONARQUBE_DEBUG_ENABLED');
      expect(result.stdout).toContain('ENV_DEBUG_ENABLED=true');
    },
    { timeout: 15000 },
  );

  it(
    'passes SONARQUBE_READ_ONLY=true to docker when --read-only is set',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp --read-only', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-e SONARQUBE_READ_ONLY');
      expect(result.stdout).toContain('ENV_READ_ONLY=true');
    },
    { timeout: 15000 },
  );

  it(
    'passes SONARQUBE_TOOLSETS to docker when --toolsets is set',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp --toolsets issues,rules', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-e SONARQUBE_TOOLSETS');
      expect(result.stdout).toContain('ENV_TOOLSETS=issues,rules');
    },
    { timeout: 15000 },
  );

  it(
    'propagates non-zero container exit code to CLI exit code',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      const fakeBinDir = setupFakeDocker(1);

      const result = await harness.run('run mcp', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
      });

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'proxies stdin to docker and stdout back to the caller (stdio: inherit)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('test-token').start();
      harness.withAuth(server.baseUrl(), 'test-token');
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
        stdin: 'hello mcp\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello mcp');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when the saved connection is SonarQube Cloud but has no organization key',
    async () => {
      const server = await harness.newFakeServer().start();
      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'cloud')
        .withKeychainToken(server.baseUrl(), 'test-token');

      const result = await harness.run('run mcp');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Not authenticated');
    },
    { timeout: 15000 },
  );

  it(
    'does not write CLI log output to stdout (stdout must be clean for MCP transport)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
      );
      const fakeBinDir = setupFakeDocker();

      const result = await harness.run('run mcp', {
        extraEnv: { PATH: `${fakeBinDir}${PATH_SEP}${process.env.PATH ?? ''}` },
        stdin: 'hello mcp\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello mcp');
      // Any CLI log written to stdout corrupts the MCP JSON-RPC stream
      expect(result.stdout).not.toContain('Found sonar-project.properties');
    },
    { timeout: 15000 },
  );
});
