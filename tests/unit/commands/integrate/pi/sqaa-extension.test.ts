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

import { PI_SQAA_EXTENSION_CONTENT } from '@/commands/integrate/pi/sqaa-extension-content.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Answer = { error?: Error; stdout?: string };
type HookCall = { subcommand: string; payload: Record<string, unknown> };
type ToolResultAnswer = { content: { type: string; text: string }[] } | undefined;
type TurnEndAnswer = {
  continue: boolean;
  entries: { type: string; customType: string; display: boolean; content: { text: string }[] }[];
};

const SESSION_ID = 'ses_1';
const FAKE_EXEC_FILE_KEY = '__piTestExecFile';
const VORTEX_CONTEXT = 'Vortex found 1 issue in a.ts';
const NO_CONTEXT: Answer = { stdout: JSON.stringify({}) };
const EDIT_OUTPUT = { type: 'text', text: 'Edited a.ts' };

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
  const source = PI_SQAA_EXTENSION_CONTENT.replace(
    "import { execFile } from 'node:child_process';",
    `const execFile = globalThis.${FAKE_EXEC_FILE_KEY};`,
  );
  expect(source).not.toBe(PI_SQAA_EXTENSION_CONTENT);
  (globalThis as Record<string, unknown>)[FAKE_EXEC_FILE_KEY] = execFile;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const dir = mkdtempSync(join(tmpdir(), 'sonar-pi-sqaa-extension-'));
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

function toolResultEvent(path: string | undefined, toolName = 'edit', isError = false) {
  return {
    type: 'tool_result',
    toolName,
    input: path === undefined ? {} : { path },
    content: [EDIT_OUTPUT],
    isError,
  };
}

function withContext(context: string): Answer {
  return { stdout: JSON.stringify({ context }) };
}

describe('Pi SQAA extension, loaded and executed', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-pi-cwd-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>)[FAKE_EXEC_FILE_KEY];
  });

  describe('tool_result', () => {
    it('ignores tools other than edit and write without calling sonar', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts', 'bash'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });

    it('ignores a failed edit without calling sonar', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts', 'edit', true),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });

    it('ignores an edit without a path without calling sonar', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent(undefined),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });

    it('sends the tool, the resolved path and the session id to sonar for an edit', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      await handlers.get('tool_result')?.(toolResultEvent('a.ts'), piContext(workDir));

      expect(sonar.calls).toEqual([
        {
          subcommand: 'pi-post-tool-use',
          payload: { tool: 'edit', filePath: join(workDir, 'a.ts'), sessionID: SESSION_ID },
        },
      ]);
    });

    it('analyzes a write the same way', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      await handlers.get('tool_result')?.(toolResultEvent('a.ts', 'write'), piContext(workDir));

      expect(sonar.calls[0]?.payload.tool).toBe('write');
    });

    it('appends the Vortex context to the tool output inside a system-reminder', async () => {
      const sonar = createFakeSonar(() => withContext(VORTEX_CONTEXT));
      const handlers = await loadExtension(sonar.execFile);

      const result = (await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir),
      )) as ToolResultAnswer;

      expect(result?.content).toHaveLength(2);
      expect(result?.content[0]).toEqual(EDIT_OUTPUT);
      expect(result?.content[1].text).toStartWith('<system-reminder>\n');
      expect(result?.content[1].text).toContain(VORTEX_CONTEXT);
      expect(result?.content[1].text).toContain('Sonar Vortex analysis');
      expect(result?.content[1].text).toEndWith('\n</system-reminder>');
    });

    it('leaves the tool output alone when sonar has nothing to report', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
    });

    it('leaves the tool output alone when the context is not a string', async () => {
      const sonar = createFakeSonar(() => ({ stdout: JSON.stringify({ context: 42 }) }));
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
    });

    it('stays silent when the sonar command fails', async () => {
      const sonar = createFakeSonar(() => ({ error: new Error('spawn sonar ENOENT') }));
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
    });

    it('stays silent when sonar answers with something that is not JSON', async () => {
      const sonar = createFakeSonar(() => ({ stdout: 'not json' }));
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
    });

    it('stays silent when sonar answers with null', async () => {
      const sonar = createFakeSonar(() => ({ stdout: 'null' }));
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir),
      );

      expect(result).toBeUndefined();
    });

    it('stays silent when the session id cannot be read', async () => {
      const sonar = createFakeSonar(() => withContext(VORTEX_CONTEXT));
      const handlers = await loadExtension(sonar.execFile);

      const result = await handlers.get('tool_result')?.(
        toolResultEvent('a.ts'),
        piContext(workDir, () => {
          throw new Error('no session');
        }),
      );

      expect(result).toBeUndefined();
      expect(sonar.calls).toHaveLength(0);
    });
  });

  describe('path resolution, as Pi resolves the path of its edit and write tools', () => {
    async function resolvedFilePath(path: string, cwd: string): Promise<unknown> {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      await handlers.get('tool_result')?.(toolResultEvent(path), piContext(cwd));
      return sonar.calls[0]?.payload.filePath;
    }

    it('joins a relative path to the working directory', async () => {
      expect(await resolvedFilePath('src/a.ts', workDir)).toBe(join(workDir, 'src', 'a.ts'));
    });

    it('strips a leading @', async () => {
      expect(await resolvedFilePath('@src/a.ts', workDir)).toBe(join(workDir, 'src', 'a.ts'));
    });

    it('expands ~/ and ~ to the home directory', async () => {
      expect(await resolvedFilePath('~/x.ts', workDir)).toBe(join(homedir(), 'x.ts'));
      expect(await resolvedFilePath('~', workDir)).toBe(homedir());
    });

    it('keeps an absolute path', async () => {
      const absolute = join(workDir, 'abs.ts');
      expect(await resolvedFilePath(absolute, '/somewhere/else')).toBe(absolute);
    });

    it('converts a file:// URL to a path instead of treating it as a relative one', async () => {
      const target = join(workDir, 'url.ts');
      expect(await resolvedFilePath(pathToFileURL(target).href, '/somewhere/else')).toBe(target);
    });

    it('replaces Unicode spaces with normal spaces', async () => {
      const noBreakSpace = String.fromCharCode(0x00a0);
      expect(await resolvedFilePath(`my${noBreakSpace}notes.ts`, workDir)).toBe(
        join(workDir, 'my notes.ts'),
      );
    });
  });

  describe('turn_end', () => {
    it('does nothing when the turn edited no file', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      expect(await handlers.get('turn_end')?.({}, piContext(workDir))).toBeUndefined();
    });

    it('does nothing when the only edits of the turn failed', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      await handlers.get('tool_result')?.(
        toolResultEvent('a.ts', 'edit', true),
        piContext(workDir),
      );

      expect(await handlers.get('turn_end')?.({}, piContext(workDir))).toBeUndefined();
    });

    it('asks for one more turn with a DEEP analysis of each edited file', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      await handlers.get('tool_result')?.(toolResultEvent('a.ts'), piContext(workDir));
      await handlers.get('tool_result')?.(toolResultEvent('b.ts', 'write'), piContext(workDir));
      await handlers.get('tool_result')?.(toolResultEvent('a.ts'), piContext(workDir));

      const result = (await handlers.get('turn_end')?.({}, piContext(workDir))) as TurnEndAnswer;

      expect(result.continue).toBe(true);
      expect(result.entries).toHaveLength(1);
      const [entry] = result.entries;
      expect(entry.type).toBe('custom_message');
      expect(entry.customType).toBe('sonar-deep-reminder');
      expect(entry.display).toBe(false);
      expect(entry.content[0].text).toBe(
        '<system-reminder>\n' +
          'Before ending your turn, run `sonar analyze agentic --depth DEEP ' +
          `--file "${join(workDir, 'a.ts')}" --file "${join(workDir, 'b.ts')}"` +
          '` and summarize the result for the user.\n</system-reminder>',
      );
    });

    it('clears the edited files, so the extra turn does not ask for another one', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      await handlers.get('tool_result')?.(toolResultEvent('a.ts'), piContext(workDir));

      await handlers.get('turn_end')?.({}, piContext(workDir));

      expect(await handlers.get('turn_end')?.({}, piContext(workDir))).toBeUndefined();
    });

    it('still asks for the analysis of a file whose per-edit analysis failed', async () => {
      const sonar = createFakeSonar(() => ({ error: new Error('spawn sonar ENOENT') }));
      const handlers = await loadExtension(sonar.execFile);
      await handlers.get('tool_result')?.(toolResultEvent('a.ts'), piContext(workDir));

      const result = (await handlers.get('turn_end')?.({}, piContext(workDir))) as TurnEndAnswer;

      expect(result.continue).toBe(true);
    });
  });
});
