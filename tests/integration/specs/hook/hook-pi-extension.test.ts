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

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { PI_SECRETS_EXTENSION_CONTENT } from '@/commands/integrate/pi/secrets-extension-content.ts';

import { TestHarness } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner';
import { IS_WINDOWS } from '../../harness/platform';

const execFileAsync = promisify(execFile);

// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const SESSION_ID = 'ses_test';

const FAKE_SERVER = 'http://localhost:19999';
const FAKE_TOKEN = 'fake-token';

const EXTENSION_RUNNER = `
import { pathToFileURL } from 'node:url';

const [extensionFile, eventName, eventJson, cwd, sessionId] = process.argv.slice(2);
const loaded = await import(pathToFileURL(extensionFile).href);
const handlers = new Map();
loaded.default({ on: (name, handler) => handlers.set(name, handler) });
const context = { cwd, sessionManager: { getSessionId: () => sessionId } };
const result = await handlers.get(eventName)(JSON.parse(eventJson), context);
process.stdout.write(JSON.stringify(result ?? null));
`;

function readEvent(path: string) {
  return { type: 'tool_call', toolName: 'read', input: { path } };
}

function userMessageEvent(content: string) {
  return { type: 'message_end', message: { role: 'user', content, timestamp: 42 } };
}

describe.skipIf(IS_WINDOWS)('Pi secrets extension running the real sonar hooks', () => {
  let harness: TestHarness;
  let extensionDir: string;

  async function runHandler<T>(eventName: string, event: unknown): Promise<T | null> {
    const harnessEnv = harness.env();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(extensionDir, 'runner.mjs'),
        join(extensionDir, 'extension.mjs'),
        eventName,
        JSON.stringify(event),
        harness.cwd.path,
        SESSION_ID,
      ],
      { env: { ...harnessEnv, PATH: [extensionDir, harnessEnv.PATH ?? ''].join(delimiter) } },
    );
    return JSON.parse(stdout) as T | null;
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    harness.withAuth(FAKE_SERVER, FAKE_TOKEN);

    extensionDir = mkdtempSync(join(tmpdir(), 'sonar-pi-extension-'));
    const sonarShim = join(extensionDir, 'sonar');
    writeFileSync(sonarShim, `#!/bin/sh\nexec "${getCliBinaryPath()}" "$@"\n`);
    chmodSync(sonarShim, 0o755);
    writeFileSync(
      join(extensionDir, 'extension.mjs'),
      new Bun.Transpiler({ loader: 'ts' }).transformSync(PI_SECRETS_EXTENSION_CONTENT),
    );
    writeFileSync(join(extensionDir, 'runner.mjs'), EXTENSION_RUNNER);
  });

  afterEach(async () => {
    rmSync(extensionDir, { recursive: true, force: true });
    await harness.dispose();
  });

  it(
    'blocks the read of a file holding a secret and lets a clean file through',
    async () => {
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);

      const blocked = await runHandler<{ block: boolean; reason: string }>(
        'tool_call',
        readEvent('secret.js'),
      );
      const allowed = await runHandler('tool_call', readEvent('clean.js'));

      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain(
        `${join(harness.cwd.path, 'secret.js')}. Do not attempt to access this file another way`,
      );
      expect(allowed).toBeNull();
    },
    { timeout: 60000 },
  );

  it(
    'masks the secret of a user message and keeps the text around it',
    async () => {
      const before = 'please push a commit using my token ';
      const after = ' to the remote';

      const result = await runHandler<{
        message: { role: string; content: string; timestamp: number };
      }>('message_end', userMessageEvent(`${before}${GITHUB_TEST_TOKEN}${after}`));

      expect(result?.message.role).toBe('user');
      expect(result?.message.timestamp).toBe(42);
      expect(result?.message.content).not.toContain(GITHUB_TEST_TOKEN);
      expect(result?.message.content).not.toContain('[Sonar] Message blocked');
      expect(result?.message.content.startsWith(before)).toBe(true);
      expect(result?.message.content.endsWith(after)).toBe(true);
    },
    { timeout: 60000 },
  );
});
