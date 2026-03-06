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

// Integration tests for `sonar integrate claude`

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { TestHarness } from '../harness/index.js';

describe('integrate claude', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // --- Without --non-interactive (auth succeeds, no repair triggered) ---

  it(
    'installs secrets-only hooks when sonar-project.properties is absent',
    async () => {
      // No props file, no server, no token → secrets-only mode
      const projectDir = await harness.newFileSystem().build();

      const result = await harness.run('integrate claude --non-interactive', { cwd: projectDir });

      expect(result.exitCode).toBe(0);
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'performs full integration with valid --token and URL from sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --token test-token --non-interactive', {
        cwd: projectDir,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'uses SONAR_CLI_TOKEN + SONAR_CLI_SERVER env vars for full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('env-token')
        .withProject('env-project')
        .start();

      // sonar-project.properties has only the project key — no sonar.host.url,
      // so the server URL must come exclusively from SONAR_CLI_SERVER env var
      const projectDir = await harness
        .newFileSystem()
        .withFile('sonar-project.properties', 'sonar.projectKey=env-project')
        .build();

      const result = await harness.run('integrate claude --non-interactive', {
        cwd: projectDir,
        extraEnv: {
          SONAR_CLI_TOKEN: 'env-token',
          SONAR_CLI_SERVER: server.baseUrl(),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'uses keychain token for full integration when no --token flag is provided',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('keychain-token')
        .withProject('keychain-project')
        .start();

      harness.env().withKeychainToken(server.baseUrl(), 'keychain-token');

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=keychain-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --non-interactive', { cwd: projectDir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs secrets-only hooks when sonar-project.properties has URL but no project key',
    async () => {
      const server = await harness.newFakeServer().start();

      const projectDir = await harness
        .newFileSystem()
        .withFile('sonar-project.properties', `sonar.host.url=${server.baseUrl()}`)
        .build();

      const result = await harness.run('integrate claude --non-interactive', { cwd: projectDir });

      expect(result.exitCode).toBe(0);
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  // --- Without --non-interactive (interactive browser auth via browserToken) ---

  it(
    'performs full integration via browser auth when no token is initially available',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('browser-token')
        .withProject('browser-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=browser-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude', {
        cwd: projectDir,
        browserToken: 'browser-token',
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'replaces invalid token via browser auth and completes full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-browser-token')
        .withProject('repair-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=repair-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --token invalid-token', {
        cwd: projectDir,
        browserToken: 'valid-browser-token',
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    },
    { timeout: 30000 },
  );

  // --- With --non-interactive ---

  it(
    'installs hooks even when token is invalid (--non-interactive degraded mode)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --token wrong-token --non-interactive', {
        cwd: projectDir,
      });

      expect(result.exitCode).toBe(0);
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'installs hooks when no token and --non-interactive',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('some-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --non-interactive', { cwd: projectDir });

      expect(result.exitCode).toBe(0);
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'does not open browser when env vars are set but token is invalid (env vars imply non-interactive)',
    async () => {
      // Regression test: when SONAR_CLI_TOKEN + SONAR_CLI_SERVER are set but the token is
      // rejected by the server, the command must NOT open a browser — env vars imply CI/automated
      // context. Without the fix this test hangs (browser auth is triggered, loopback server waits).
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token') // server only accepts 'valid-token'
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      const result = await harness.run(
        'integrate claude', // no --non-interactive flag
        {
          cwd: projectDir,
          extraEnv: {
            SONAR_CLI_TOKEN: 'invalid-token', // rejected by server → tokenValid = false
            SONAR_CLI_SERVER: server.baseUrl(),
            // no browserToken: if browser auth is triggered the test times out
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'falls back to secrets-only mode when only SONAR_CLI_TOKEN is set and no sonar-project.properties',
    async () => {
      const projectDir = await harness.newFileSystem().build();

      const result = await harness.run('integrate claude --non-interactive', {
        cwd: projectDir,
        extraEnv: { SONAR_CLI_TOKEN: 'some-token' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('SONAR_CLI_SERVER');
      expect(
        existsSync(
          join(
            projectDir,
            '.claude',
            'hooks',
            'sonar-secrets',
            'build-scripts',
            'pretool-secrets.sh',
          ),
        ),
      ).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'warns about missing SONAR_CLI_SERVER when only SONAR_CLI_TOKEN is set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('some-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --non-interactive', {
        cwd: projectDir,
        extraEnv: { SONAR_CLI_TOKEN: 'some-token' },
      });

      expect(result.exitCode).toBe(0);
      // warn() outputs to stderr
      expect(result.stderr).toContain('SONAR_CLI_SERVER');
    },
    { timeout: 30000 },
  );

  it(
    'uses --server flag URL and overrides sonar-project.properties URL',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          ['sonar.host.url=http://wrong-server.example.com', 'sonar.projectKey=my-project'].join(
            '\n',
          ),
        )
        .build();

      const result = await harness.run(
        `integrate claude --token test-token --server ${server.baseUrl()} --non-interactive`,
        { cwd: projectDir },
      );

      expect(result.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      expect(requests.length).toBeGreaterThan(0);
    },
    { timeout: 30000 },
  );

  it(
    'performs full integration using --token, --server, and --project flags without sonar-project.properties',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('flag-token')
        .withProject('flag-project')
        .start();

      const projectDir = await harness.newFileSystem().build();

      const result = await harness.run(
        `integrate claude --token flag-token --server ${server.baseUrl()} --project flag-project --non-interactive`,
        { cwd: projectDir },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    },
    { timeout: 30000 },
  );

  // TODO: --skip-hooks is not fully respected in the repair path (runRepair always installs hooks).
  // Re-enable once the bug is fixed.
  // it('does not install hooks when --skip-hooks flag is provided', async () => {
  //   ...
  // });

  it(
    'installs settings.json with PreToolUse hook on full integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      const result = await harness.run('integrate claude --token test-token --non-interactive', {
        cwd: projectDir,
      });

      expect(result.exitCode).toBe(0);
      const settingsPath = join(projectDir, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks?.PreToolUse).toBeDefined();
    },
    { timeout: 30000 },
  );

  it(
    'pretool-secrets.sh exists and is executable after integration',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();

      const projectDir = await harness
        .newFileSystem()
        .withFile(
          'sonar-project.properties',
          [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=my-project'].join('\n'),
        )
        .build();

      await harness.run('integrate claude --token test-token --non-interactive', {
        cwd: projectDir,
      });

      const scriptPath = join(
        projectDir,
        '.claude',
        'hooks',
        'sonar-secrets',
        'build-scripts',
        'pretool-secrets.sh',
      );
      expect(existsSync(scriptPath)).toBe(true);
      const stats = statSync(scriptPath);
      // Check executable bit (owner execute)
      expect(stats.mode & 0o100).toBeTruthy();
    },
    { timeout: 30000 },
  );
});

// ─── Local vs Global file placement ──────────────────────────────────────────

describe('integrate claude — file placement (local vs global)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  // ─── Project-level (no -g) ─────────────────────────────────────────────────

  describe('project-level hooks (no -g flag)', () => {
    it(
      'writes hook scripts and settings.json inside projectDir/.claude/',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();

        const projectDir = await harness
          .newFileSystem()
          .withFile(
            'sonar-project.properties',
            [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
          )
          .build();

        const result = await harness.run('integrate claude --token tok --non-interactive', {
          cwd: projectDir,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
        expect(
          existsSync(
            join(
              projectDir,
              '.claude',
              'hooks',
              'sonar-secrets',
              'build-scripts',
              'pretool-secrets.sh',
            ),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(
              projectDir,
              '.claude',
              'hooks',
              'sonar-secrets',
              'build-scripts',
              'prompt-secrets.sh',
            ),
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'does not touch the global dir when running without -g',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();

        const projectDir = await harness
          .newFileSystem()
          .withFile(
            'sonar-project.properties',
            [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
          )
          .build();

        await harness.run('integrate claude --token tok --non-interactive', {
          cwd: projectDir,
        });

        // Global dir must be completely untouched
        expect(existsSync(join(harness.homeDir, '.claude'))).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'registers hook commands with relative paths in settings.json',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();

        const projectDir = await harness
          .newFileSystem()
          .withFile(
            'sonar-project.properties',
            [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
          )
          .build();

        await harness.run('integrate claude --token tok --non-interactive', {
          cwd: projectDir,
        });

        const settings = JSON.parse(
          readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf-8'),
        );
        const preToolCmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
        const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;

        // Must be relative (not absolute) so they resolve from the project root
        expect(isAbsolute(preToolCmd)).toBe(false);
        expect(preToolCmd.startsWith('.claude')).toBe(true);
        expect(isAbsolute(promptCmd)).toBe(false);
        expect(promptCmd.startsWith('.claude')).toBe(true);
      },
      { timeout: 30000 },
    );
  });

  // ─── Global (-g flag) ──────────────────────────────────────────────────────

  describe('global hooks (-g flag)', () => {
    it(
      'writes hook scripts and settings.json to $HOME/.claude/',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();

        const projectDir = await harness
          .newFileSystem()
          .withFile(
            'sonar-project.properties',
            [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
          )
          .build();

        const result = await harness.run('integrate claude -g --token tok --non-interactive', {
          cwd: projectDir,
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(harness.homeDir, '.claude', 'settings.json'))).toBe(true);
        expect(
          existsSync(
            join(
              harness.homeDir,
              '.claude',
              'hooks',
              'sonar-secrets',
              'build-scripts',
              'pretool-secrets.sh',
            ),
          ),
        ).toBe(true);
        expect(
          existsSync(
            join(
              harness.homeDir,
              '.claude',
              'hooks',
              'sonar-secrets',
              'build-scripts',
              'prompt-secrets.sh',
            ),
          ),
        ).toBe(true);
      },
      { timeout: 30000 },
    );

    it(
      'does not create .claude/ inside the project directory when -g is set',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();

        const projectDir = await harness
          .newFileSystem()
          .withFile(
            'sonar-project.properties',
            [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
          )
          .build();

        await harness.run('integrate claude -g --token tok --non-interactive', {
          cwd: projectDir,
        });

        // Project-level .claude/ must NOT be created
        expect(existsSync(join(projectDir, '.claude'))).toBe(false);
      },
      { timeout: 30000 },
    );

    it(
      'registers hook commands with absolute paths pointing to $HOME',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('tok')
          .withProject('proj')
          .start();

        const projectDir = await harness
          .newFileSystem()
          .withFile(
            'sonar-project.properties',
            [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
          )
          .build();

        await harness.run('integrate claude -g --token tok --non-interactive', {
          cwd: projectDir,
        });

        const settings = JSON.parse(
          readFileSync(join(harness.homeDir, '.claude', 'settings.json'), 'utf-8'),
        );
        const preToolCmd = settings.hooks.PreToolUse[0].hooks[0].command as string;
        const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;

        // Must be absolute paths rooted at harness.homeDir
        expect(isAbsolute(preToolCmd)).toBe(true);
        expect(preToolCmd.startsWith(harness.homeDir)).toBe(true);
        expect(isAbsolute(promptCmd)).toBe(true);
        expect(promptCmd.startsWith(harness.homeDir)).toBe(true);
      },
      { timeout: 30000 },
    );
  });
});

// ─── Argument validation ──────────────────────────────────────────────────────

describe('integrate — argument validation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when an unsupported tool argument is provided',
    async () => {
      const result = await harness.run('integrate gemini');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Allowed choices are claude');
    },
    { timeout: 15000 },
  );
});
