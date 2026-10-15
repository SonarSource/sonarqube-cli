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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { PI_SECRETS_EXTENSION_CONTENT } from '@/commands/integrate/pi/secrets-extension-content.ts';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Answer = { error?: Error; stdout?: string };
type HookCall = { subcommand: string; payload: Record<string, unknown> };

const SESSION_ID = 'ses_1';
const SECRET_VALUE = 'ghp_FAKE_TOKEN_VALUE';
const FAKE_EXEC_FILE_KEY = '__piTestExecFile';
const BLOCKED_PLACEHOLDER = '[Sonar] Message blocked';

function createFakeSonar(answer: (call: HookCall) => Answer) {
  const calls: HookCall[] = [];
  const execFile = (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => ({
    stdin: {
      end: (rawPayload: string) => {
        const call = {
          subcommand: args[1],
          payload: JSON.parse(rawPayload) as HookCall['payload'],
        };
        calls.push(call);
        const { error, stdout } = answer(call);
        queueMicrotask(() => callback(error ?? null, stdout ?? ''));
      },
    },
  });
  return { execFile, calls };
}

async function loadExtension(execFile: unknown): Promise<Map<string, Handler>> {
  const source = PI_SECRETS_EXTENSION_CONTENT.replace(
    "import { execFile } from 'node:child_process';",
    `const execFile = globalThis.${FAKE_EXEC_FILE_KEY};`,
  );
  expect(source).not.toBe(PI_SECRETS_EXTENSION_CONTENT);
  (globalThis as Record<string, unknown>)[FAKE_EXEC_FILE_KEY] = execFile;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const dir = mkdtempSync(join(tmpdir(), 'sonar-pi-extension-'));
  try {
    const file = join(dir, 'extension.mjs');
    writeFileSync(file, js);
    const loaded = (await import(file)) as {
      default: (pi: { on: (name: string, handler: Handler) => void }) => void;
    };
    const handlers = new Map<string, Handler>();
    loaded.default({ on: (name, handler) => handlers.set(name, handler) });
    return handlers;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function piContext(cwd: string, getSessionId: () => string = () => SESSION_ID) {
  return { cwd, sessionManager: { getSessionId } };
}

function readEvent(path?: string, toolName = 'read') {
  return { type: 'tool_call', toolName, input: path === undefined ? {} : { path } };
}

function userMessageEvent(content: unknown) {
  return { type: 'message_end', message: { role: 'user', content, timestamp: 42 } };
}

const ALLOW: Answer = { stdout: JSON.stringify({ block: false }) };

describe('Pi secrets extension, loaded and executed', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-pi-cwd-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>)[FAKE_EXEC_FILE_KEY];
  });

  describe('tool_call', () => {
    it('ignores tools other than read without calling sonar', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_call')?.(
        readEvent('a.ts', 'bash'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });

    it('ignores a read without a path without calling sonar', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_call')?.(readEvent(), piContext(workDir));

      expect(result).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });

    it('lets a clean read through and sends the session id to sonar', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_call')?.(readEvent('a.ts'), piContext(workDir));

      expect(result).toBeUndefined();
      expect(sonar.calls).toEqual([
        {
          subcommand: 'pi-pre-tool-use',
          payload: { tool: 'read', filePath: join(workDir, 'a.ts'), sessionID: SESSION_ID },
        },
      ]);
    });

    it('blocks with sonar reason and tells the agent not to bypass the block', async () => {
      const sonar = createFakeSonar(() => ({
        stdout: JSON.stringify({ block: true, reason: 'Sonar detected secrets in file: X' }),
      }));
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('tool_call')?.(
        readEvent('a.env'),
        piContext(workDir),
      )) as {
        block: boolean;
        reason: string;
      };

      expect(result.block).toBe(true);
      expect(result.reason).toContain('Sonar detected secrets in file: X');
      expect(result.reason).toContain('Do not attempt to access this file another way');
    });

    it('uses a default reason when sonar blocks without one', async () => {
      const sonar = createFakeSonar(() => ({ stdout: JSON.stringify({ block: true }) }));
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('tool_call')?.(
        readEvent('a.env'),
        piContext(workDir),
      )) as {
        reason: string;
      };

      expect(result.reason).toContain('Sonar blocked this file read.');
    });

    it.each([
      [
        'sonar is not found',
        { error: Object.assign(new Error('spawn sonar ENOENT'), { code: 'ENOENT' }) },
      ],
      ['sonar exits with an error', { error: new Error('Command failed: sonar hook') }],
      ['sonar answers invalid JSON', { stdout: 'not json' }],
      ['sonar answers nothing', { stdout: '' }],
      ['sonar answers an unexpected JSON shape', { stdout: '{}' }],
      ['sonar answers a non-boolean block', { stdout: JSON.stringify({ block: 'false' }) }],
    ] as [string, Answer][])('blocks the read when %s', async (_name, answer) => {
      const sonar = createFakeSonar(() => answer);
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('tool_call')?.(readEvent('a.ts'), piContext(workDir))) as {
        block: boolean;
        reason: string;
      };

      expect(result.block).toBe(true);
      expect(result.reason).toContain('could not verify a.ts');
      expect(result.reason).toContain('Do not attempt to access this file another way');
    });

    it('blocks the read when the session id cannot be read', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);
      const context = piContext(workDir, () => {
        throw new Error('no session');
      });

      const result = (await handlers.get('tool_call')?.(readEvent('a.ts'), context)) as {
        block: boolean;
      };

      expect(result.block).toBe(true);
      expect(sonar.calls).toHaveLength(0);
    });
  });

  describe('path resolution, as Pi resolves the path of its read tool', () => {
    async function resolvedFilePath(path: string, cwd: string): Promise<unknown> {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);
      await handlers.get('tool_call')?.(readEvent(path), piContext(cwd));
      return sonar.calls[0]?.payload.filePath;
    }

    it('joins a relative path to the working directory', async () => {
      expect(await resolvedFilePath('src/a.env', workDir)).toBe(join(workDir, 'src', 'a.env'));
    });

    it('strips a leading @', async () => {
      expect(await resolvedFilePath('@src/a.env', workDir)).toBe(join(workDir, 'src', 'a.env'));
    });

    it('expands ~/ and ~ to the home directory', async () => {
      expect(await resolvedFilePath('~/x.env', workDir)).toBe(join(homedir(), 'x.env'));
      expect(await resolvedFilePath('~', workDir)).toBe(homedir());
    });

    it('keeps an absolute path', async () => {
      const absolute = join(workDir, 'abs.env');
      expect(await resolvedFilePath(absolute, '/somewhere/else')).toBe(absolute);
    });

    it('converts a file:// URL to a path instead of treating it as a relative one', async () => {
      const target = join(workDir, 'url.env');
      expect(await resolvedFilePath(pathToFileURL(target).href, '/somewhere/else')).toBe(target);
    });

    it('replaces Unicode spaces with normal spaces', async () => {
      expect(await resolvedFilePath('my\u00A0notes.env', workDir)).toBe(
        join(workDir, 'my notes.env'),
      );
    });

    it('finds a file whose name has a curly apostrophe when the path has a straight one', async () => {
      writeFileSync(join(workDir, 'it\u2019s.env'), 'x');
      expect(await resolvedFilePath("it's.env", workDir)).toBe(join(workDir, 'it\u2019s.env'));
    });

    it('finds a macOS screenshot name with a narrow no-break space before AM/PM', async () => {
      writeFileSync(join(workDir, 'shot 1\u202FPM.png'), 'x');
      expect(await resolvedFilePath('shot 1 PM.png', workDir)).toBe(
        join(workDir, 'shot 1\u202FPM.png'),
      );
    });
  });

  describe('message_end', () => {
    it('ignores messages that are not from the user', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);
      const event = { type: 'message_end', message: { role: 'assistant', content: 'hi' } };

      expect(await handlers.get('message_end')?.(event, piContext(workDir))).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });

    it('replaces a string message with the redacted text and keeps its other fields', async () => {
      const sonar = createFakeSonar(() => ({
        stdout: JSON.stringify({ block: false, redactedText: 'token ghp****', secretsFound: 1 }),
      }));
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('message_end')?.(
        userMessageEvent('token ghp_real'),
        piContext(workDir),
      );

      expect(result).toEqual({
        message: { role: 'user', content: 'token ghp****', timestamp: 42 },
      });
      expect(sonar.calls).toEqual([
        {
          subcommand: 'pi-chat-message',
          payload: { text: 'token ghp_real', sessionID: SESSION_ID },
        },
      ]);
    });

    it('redacts each text part and leaves other parts untouched', async () => {
      const sonar = createFakeSonar(({ payload }) => ({
        stdout: JSON.stringify({ block: false, redactedText: String(payload.text).toUpperCase() }),
      }));
      const handlers = await loadExtension(sonar.execFile);
      const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

      const result = (await handlers.get('message_end')?.(
        userMessageEvent([{ type: 'text', text: 'one' }, image, { type: 'text', text: 'two' }]),
        piContext(workDir),
      )) as { message: { content: unknown[] } };

      expect(result.message.content).toEqual([
        { type: 'text', text: 'ONE' },
        image,
        { type: 'text', text: 'TWO' },
      ]);
    });

    it('keeps the text when sonar finds nothing', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('message_end')?.(
        userMessageEvent('hello'),
        piContext(workDir),
      )) as {
        message: { content: string };
      };

      expect(result.message.content).toBe('hello');
    });

    it('does not call sonar for an empty message', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);

      await handlers.get('message_end')?.(userMessageEvent(''), piContext(workDir));

      expect(sonar.calls).toHaveLength(0);
    });

    it('replaces the message with a placeholder carrying the reason when sonar blocks it', async () => {
      const sonar = createFakeSonar(() => ({
        stdout: JSON.stringify({ block: true, reason: 'could not mask all of them.' }),
      }));
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('message_end')?.(
        userMessageEvent(SECRET_VALUE),
        piContext(workDir),
      )) as {
        message: { content: string };
      };

      expect(result.message.content).toContain(BLOCKED_PLACEHOLDER);
      expect(result.message.content).toContain('could not mask all of them.');
      expect(result.message.content).not.toContain(SECRET_VALUE);
    });

    it.each([
      [
        'sonar is not found',
        { error: Object.assign(new Error('spawn sonar ENOENT'), { code: 'ENOENT' }) },
      ],
      ['sonar answers invalid JSON', { stdout: 'not json' }],
      ['sonar answers an unexpected JSON shape', { stdout: '{}' }],
      [
        'sonar answers a non-string redactedText',
        { stdout: JSON.stringify({ block: false, redactedText: 5 }) },
      ],
    ] as [string, Answer][])(
      'replaces the message with a placeholder when %s',
      async (_name, answer) => {
        const sonar = createFakeSonar(() => answer);
        const handlers = await loadExtension(sonar.execFile);

        const result = (await handlers.get('message_end')?.(
          userMessageEvent(SECRET_VALUE),
          piContext(workDir),
        )) as {
          message: { content: string };
        };

        expect(result.message.content).toContain(BLOCKED_PLACEHOLDER);
        expect(result.message.content).toContain('could not verify this message for secrets');
        expect(result.message.content).not.toContain(SECRET_VALUE);
      },
    );

    it('replaces the message instead of throwing when the session id cannot be read', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);
      const context = piContext(workDir, () => {
        throw new Error('no session');
      });

      const result = (await handlers.get('message_end')?.(
        userMessageEvent(SECRET_VALUE),
        context,
      )) as {
        message: { content: string };
      };

      expect(result.message.content).toContain(BLOCKED_PLACEHOLDER);
      expect(sonar.calls).toHaveLength(0);
    });

    it('replaces the message instead of throwing when its content has an unexpected shape', async () => {
      const sonar = createFakeSonar(() => ALLOW);
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('message_end')?.(
        userMessageEvent(42),
        piContext(workDir),
      )) as {
        message: { content: string };
      };

      expect(result.message.content).toContain(BLOCKED_PLACEHOLDER);
    });
  });
});
