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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { PI_SQAA_EXTENSION_CONTENT } from '@/commands/integrate/pi/sqaa-extension-content.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Answer = { error?: Error; stdout?: string };
type HookCall = { subcommand: string; payload: Record<string, unknown> };
type ToolResultAnswer = { content: { type: string; text: string }[] } | undefined;
type SettleAnswer =
  | {
      continue: boolean;
      entries: {
        type: string;
        customType: string;
        display: boolean;
        content: { text: string }[];
      }[];
    }
  | undefined;

const SESSION_ID = 'ses_1';
const FAKE_EXEC_FILE_KEY = '__piTestExecFile';
const VORTEX_CONTEXT = 'Vortex found 1 issue in a.ts';
const SQAA_HOOK_TIMEOUT_MS = 20000;
const NO_CONTEXT: Answer = { stdout: JSON.stringify({}) };
const WITH_CONTEXT: Answer = { stdout: JSON.stringify({ context: VORTEX_CONTEXT }) };
const EDIT_OUTPUT = { type: 'text', text: 'Edited a.ts' };

function createFakeSonar(answer: (call: HookCall) => Answer) {
  const calls: HookCall[] = [];
  const timeouts: unknown[] = [];
  const execFile = (
    _command: string,
    args: string[],
    options: { timeout?: number },
    callback: (error: Error | null, stdout: string) => void,
  ) => ({
    stdin: {
      end: (rawPayload: string) => {
        const call = {
          subcommand: args[1],
          payload: JSON.parse(rawPayload) as HookCall['payload'],
        };
        calls.push(call);
        timeouts.push(options.timeout);
        const { error, stdout } = answer(call);
        queueMicrotask(() => callback(error ?? null, stdout ?? ''));
      },
    },
  });
  return { execFile, calls, timeouts };
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

function settleEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent_before_settle',
    outcome: 'completed',
    entries: [],
    continue: false,
    ...overrides,
  };
}

describe('Pi SQAA extension, loaded and executed', () => {
  let workDir: string;

  function touch(relativePath: string): string {
    const file = join(workDir, relativePath);
    writeFileSync(file, 'x');
    return file;
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-pi-cwd-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>)[FAKE_EXEC_FILE_KEY];
  });

  describe('registration', () => {
    it('listens to tool_result and to the agent_before_settle boundary, not to turn_end', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);

      const handlers = await loadExtension(sonar.execFile);

      expect([...handlers.keys()].sort()).toEqual(['agent_before_settle', 'tool_result']);
    });
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

    it('does not let a stuck sonar hold the agent for as long as the secrets hooks may', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      await handlers.get('tool_result')?.(toolResultEvent('a.ts'), piContext(workDir));

      expect(sonar.timeouts).toEqual([SQAA_HOOK_TIMEOUT_MS]);
    });

    it('appends the Vortex context to the tool output inside a system-reminder', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
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
      const sonar = createFakeSonar(() => WITH_CONTEXT);
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

  describe('agent_before_settle', () => {
    async function analyzeEdit(handlers: Map<string, Handler>, path: string, toolName = 'edit') {
      await handlers.get('tool_result')?.(toolResultEvent(path, toolName), piContext(workDir));
    }

    async function settle(handlers: Map<string, Handler>, overrides: Record<string, unknown> = {}) {
      return (await handlers.get('agent_before_settle')?.(
        settleEvent(overrides),
        piContext(workDir),
      )) as SettleAnswer;
    }

    it('does nothing when no edit was analyzed', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      expect(await settle(handlers)).toBeUndefined();
    });

    it('does nothing when sonar analyzed nothing, as in a project not linked to Sonar', async () => {
      const sonar = createFakeSonar(() => NO_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      await analyzeEdit(handlers, 'a.ts');

      expect(await settle(handlers)).toBeUndefined();
    });

    it('does nothing when the only edits of the run failed', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      await handlers.get('tool_result')?.(
        toolResultEvent('a.ts', 'edit', true),
        piContext(workDir),
      );

      expect(await settle(handlers)).toBeUndefined();
    });

    it('asks for one more turn with a DEEP analysis of each analyzed file, as relative single-quoted paths', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      touch('b.ts');
      await analyzeEdit(handlers, 'a.ts');
      await analyzeEdit(handlers, 'b.ts', 'write');
      await analyzeEdit(handlers, 'a.ts');

      const result = await settle(handlers);

      expect(result?.continue).toBe(true);
      expect(result?.entries).toHaveLength(1);
      const [entry] = result?.entries ?? [];
      expect(entry.type).toBe('custom_message');
      expect(entry.customType).toBe('sonar-deep-reminder');
      expect(entry.display).toBe(false);
      expect(entry.content[0].text).toBe(
        '<system-reminder>\n' +
          "Before ending your turn, run `sonar analyze agentic --depth DEEP --file 'a.ts' --file 'b.ts'` and summarize the result for the user.\n" +
          '</system-reminder>',
      );
    });

    it('asks only once for edits spread over several turns of the same run', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      touch('b.ts');
      await analyzeEdit(handlers, 'a.ts');
      await analyzeEdit(handlers, 'b.ts');

      const result = await settle(handlers);

      expect(result?.entries).toHaveLength(1);
      expect(result?.entries[0].content[0].text).toContain("--file 'a.ts' --file 'b.ts'");
    });

    it('keeps the entries already proposed for the boundary, ahead of its own', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      await analyzeEdit(handlers, 'a.ts');
      const existing = { type: 'custom', customType: 'other-extension', data: 1 };

      const result = await settle(handlers, { entries: [existing] });

      expect(result?.entries).toHaveLength(2);
      expect(result?.entries[0]).toEqual(existing as never);
      expect(result?.entries[1].customType).toBe('sonar-deep-reminder');
    });

    it('still works when the event carries no entries', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      await analyzeEdit(handlers, 'a.ts');

      const result = await settle(handlers, { entries: undefined });

      expect(result?.entries).toHaveLength(1);
    });

    it('leaves the boundary alone when nothing was analyzed, even if other entries exist', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);

      const result = await settle(handlers, { entries: [{ type: 'custom', customType: 'other' }] });

      expect(result).toBeUndefined();
    });

    it('clears the analyzed files, so the extra turn does not ask for another one', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch('a.ts');
      await analyzeEdit(handlers, 'a.ts');

      await settle(handlers);

      expect(await settle(handlers)).toBeUndefined();
    });

    it('keeps files in subdirectories as relative paths', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      mkdirSync(join(workDir, 'src'));
      touch(join('src', 'a.ts'));
      await analyzeEdit(handlers, 'src/a.ts');

      const result = await settle(handlers);

      expect(result?.entries[0].content[0].text).toContain(`--file '${join('src', 'a.ts')}'`);
    });

    it('leaves out a file outside the working directory, so the command cannot fail on it', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      const outsideDir = mkdtempSync(join(tmpdir(), 'sonar-pi-outside-'));
      try {
        const outside = join(outsideDir, 'notes.md');
        writeFileSync(outside, 'x');
        touch('a.ts');
        await analyzeEdit(handlers, outside, 'write');
        await analyzeEdit(handlers, 'a.ts');

        const result = await settle(handlers);

        expect(result?.entries[0].content[0].text).toContain("--file 'a.ts'");
        expect(result?.entries[0].content[0].text).not.toContain('notes.md');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('leaves out a file deleted before the end of the run', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      const file = touch('a.ts');
      await analyzeEdit(handlers, 'a.ts');
      rmSync(file);

      expect(await settle(handlers)).toBeUndefined();
    });

    it.each(['aborted', 'error'])(
      'does not force a turn after a run that ended as %s, and forgets its files',
      async (outcome) => {
        const sonar = createFakeSonar(() => WITH_CONTEXT);
        const handlers = await loadExtension(sonar.execFile);
        touch('a.ts');
        await analyzeEdit(handlers, 'a.ts');

        expect(await settle(handlers, { outcome })).toBeUndefined();
        expect(await settle(handlers)).toBeUndefined();
      },
    );

    it('quotes a path so the shell expands nothing in it', async () => {
      const sonar = createFakeSonar(() => WITH_CONTEXT);
      const handlers = await loadExtension(sonar.execFile);
      touch("it's $HOME b.ts");
      await analyzeEdit(handlers, "it's $HOME b.ts");

      const result = await settle(handlers);

      expect(result?.entries[0].content[0].text).toContain("--file 'it'\\''s $HOME b.ts'");
    });

    it.skipIf(process.platform === 'win32')(
      'gives the command the exact file names when a shell runs it',
      async () => {
        const sonar = createFakeSonar(() => WITH_CONTEXT);
        const handlers = await loadExtension(sonar.execFile);
        const names = ["it's $HOME b.ts", 'back`tick.ts', 'plain.ts'];
        for (const name of names) {
          touch(name);
          await analyzeEdit(handlers, name);
        }

        const result = await settle(handlers);

        const text = result?.entries[0].content[0].text ?? '';
        const command = /run `(.*)` and summarize/s.exec(text)?.[1] ?? '';
        const fileArguments = command.replace('sonar analyze agentic --depth DEEP ', '');
        const printed = Bun.spawnSync(['sh', '-c', `printf '%s\n' ${fileArguments}`], {
          cwd: workDir,
        }).stdout.toString();
        expect(printed.trimEnd().split('\n')).toEqual(names.flatMap((name) => ['--file', name]));
      },
    );
  });
});
