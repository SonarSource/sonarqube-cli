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

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { PI_SECRETS_EXTENSION_CONTENT } from '@/commands/integrate/pi/secrets-extension-content.ts';

import { TestHarness } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner';
import { IS_WINDOWS } from '../../harness/platform';

// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';
const SESSION_ID = 'ses_test';

const FAKE_SERVER = 'http://localhost:19999';
const FAKE_TOKEN = 'fake-token';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

async function loadExtensionHandlers(directory: string): Promise<Map<string, Handler>> {
  const file = join(directory, 'extension.mjs');
  writeFileSync(
    file,
    new Bun.Transpiler({ loader: 'ts' }).transformSync(PI_SECRETS_EXTENSION_CONTENT),
  );
  const loaded = (await import(file)) as {
    default: (pi: { on: (name: string, handler: Handler) => void }) => void;
  };
  const handlers = new Map<string, Handler>();
  loaded.default({ on: (name, handler) => handlers.set(name, handler) });
  return handlers;
}

function piContext(cwd: string) {
  return { cwd, sessionManager: { getSessionId: () => SESSION_ID } };
}

function readEvent(path: string) {
  return { type: 'tool_call', toolName: 'read', input: { path } };
}

function userMessageEvent(content: string) {
  return { type: 'message_end', message: { role: 'user', content, timestamp: 42 } };
}

describe.skipIf(IS_WINDOWS)('Pi secrets extension running the real sonar hooks', () => {
  let harness: TestHarness;
  let extensionDir: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
    harness.withAuth(FAKE_SERVER, FAKE_TOKEN);

    extensionDir = mkdtempSync(join(tmpdir(), 'sonar-pi-extension-'));
    const sonarShim = join(extensionDir, 'sonar');
    writeFileSync(sonarShim, `#!/bin/sh\nexec "${getCliBinaryPath()}" "$@"\n`);
    chmodSync(sonarShim, 0o755);

    previousEnv = { ...process.env };
    const harnessEnv = harness.env();
    Object.assign(process.env, harnessEnv, {
      PATH: [extensionDir, harnessEnv.PATH ?? previousEnv.PATH ?? ''].join(delimiter),
    });
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previousEnv);
    rmSync(extensionDir, { recursive: true, force: true });
    await harness.dispose();
  });

  it(
    'blocks the read of a file holding a secret and lets a clean file through',
    async () => {
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
      const onToolCall = (await loadExtensionHandlers(extensionDir)).get('tool_call');
      const context = piContext(harness.cwd.path);

      const blocked = (await onToolCall?.(readEvent('secret.js'), context)) as {
        block: boolean;
        reason: string;
      };
      const allowed = await onToolCall?.(readEvent('clean.js'), context);

      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain(
        `${join(harness.cwd.path, 'secret.js')}. Do not attempt to access this file another way`,
      );
      expect(allowed).toBeUndefined();
    },
    { timeout: 60000 },
  );

  it(
    'masks the secret of a user message and keeps the text around it',
    async () => {
      const before = 'please push a commit using my token ';
      const after = ' to the remote';
      const onMessageEnd = (await loadExtensionHandlers(extensionDir)).get('message_end');

      const result = (await onMessageEnd?.(
        userMessageEvent(`${before}${GITHUB_TEST_TOKEN}${after}`),
        piContext(harness.cwd.path),
      )) as { message: { role: string; content: string; timestamp: number } };

      expect(result.message.role).toBe('user');
      expect(result.message.timestamp).toBe(42);
      expect(result.message.content).not.toContain(GITHUB_TEST_TOKEN);
      expect(result.message.content).not.toContain('[Sonar] Message blocked');
      expect(result.message.content.startsWith(before)).toBe(true);
      expect(result.message.content.endsWith(after)).toBe(true);
    },
    { timeout: 60000 },
  );
});
