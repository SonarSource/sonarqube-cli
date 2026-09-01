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

import { describe, expect, it } from 'bun:test';

import {
  findPromptMatch,
  formatPrompt,
  type InteractiveProcessHandle,
  InteractiveSession,
  stripControlSequences,
} from '../../integration/harness/interactive-session.ts';

function createFakeProcess(): {
  writes: string[];
  ended: boolean;
  killCount: number;
  pushStdout: (text: string) => void;
  pushStderr: (text: string) => void;
  close: (code?: number) => void;
  handle: InteractiveProcessHandle;
} {
  const writes: string[] = [];
  let ended = false;
  let killCount = 0;
  let stdoutCtrl: ReadableStreamDefaultController<Uint8Array>;
  let stderrCtrl: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit: (code: number) => void;
  let exitCode: number | undefined;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const close = (code = 0): void => {
    if (exitCode !== undefined) {
      return;
    }
    exitCode = code;
    try {
      stdoutCtrl.close();
    } catch {
      /* already closed */
    }
    try {
      stderrCtrl.close();
    } catch {
      /* already closed */
    }
    resolveExit(code);
  };

  const handle: InteractiveProcessHandle = {
    stdin: {
      write(data) {
        writes.push(decoder.decode(data));
      },
      end() {
        ended = true;
      },
    },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutCtrl = controller;
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        stderrCtrl = controller;
      },
    }),
    kill() {
      killCount += 1;
      close(1);
    },
    get exited() {
      return exited;
    },
  };

  return {
    writes,
    get ended() {
      return ended;
    },
    get killCount() {
      return killCount;
    },
    pushStdout(text) {
      stdoutCtrl.enqueue(encoder.encode(text));
    },
    pushStderr(text) {
      stderrCtrl.enqueue(encoder.encode(text));
    },
    close,
    handle,
  };
}

describe('prompt matching', () => {
  it('formats string and regexp prompts', () => {
    expect(formatPrompt('Scope')).toBe('"Scope"');
    expect(formatPrompt(/hook/i)).toBe('/hook/i');
  });

  it('finds a string or regexp in the window', () => {
    expect(findPromptMatch('Install Vortex?', 'Vortex')).toBe(14);
    expect(findPromptMatch('Install Vortex?', /vortex/i)).toBe(14);
    expect(findPromptMatch('Install Vortex?', 'missing')).toBeNull();
  });

  it('skips a submitted prompt line and matches the live one', () => {
    expect(findPromptMatch('✓  Enter server URL bad-url', 'Enter server URL')).toBeNull();
    expect(findPromptMatch('?  Enter server URL', 'Enter server URL')).toBe(19);
    expect(
      findPromptMatch('✓  Enter server URL bad\n?  Enter server URL', 'Enter server URL'),
    ).toBe('✓  Enter server URL bad\n?  Enter server URL'.length);
  });

  it('skips a submitted line even when the wait text is not a prefix', () => {
    const submitted = '  ✓  MCP server (currently installed)  Keep? No';
    const live = '  ?  MCP server (currently installed)  Keep?';
    expect(findPromptMatch(submitted, 'Keep?')).toBeNull();
    expect(findPromptMatch(live, 'Keep?')).toBe(live.length);
    expect(findPromptMatch(`${submitted}\n${live}`, 'Keep?')).toBe(`${submitted}\n${live}`.length);
    expect(findPromptMatch(submitted, /Keep\?/)).toBeNull();
    expect(findPromptMatch(live, /Keep\?/)).toBe(live.length);
  });

  it('skips a submitted frame concatenated onto the previous paint', () => {
    const painted = '  › No  ✓  Keep? No  ?  Install Vortex?';
    expect(findPromptMatch(painted, 'Keep?')).toBeNull();
    expect(findPromptMatch(painted, 'Install Vortex?')).toBe(painted.length);
  });

  it('does not re-anchor a regexp at the next search offset', () => {
    expect(findPromptMatch('✓  Keep?prompt', /Keep\?|^prompt/)).toBeNull();
    expect(findPromptMatch('✓  Keep?\nprompt', /Keep\?|^prompt/m)).toBe('✓  Keep?\nprompt'.length);
    expect(findPromptMatch('✓  KeepXfoo', /KeepX|\bfoo/)).toBeNull();
  });

  it('strips CSI sequences so prompt text is visible', () => {
    expect(stripControlSequences('\x1b[?25lSelect the tool\x1b[2K\r')).toBe('Select the tool');
  });
});

describe('InteractiveSession', () => {
  it('waits for new text, writes keys, and waitFinish is idempotent', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    const waiting = session.waitText('Select a tool');
    fake.pushStdout('\x1b[1mSelect a tool\x1b[0m');
    await waiting;

    session.write('n');
    session.keyEnter();
    session.keyDown();
    session.keyUp();
    session.keySpace();
    expect(fake.writes).toEqual(['n', '\r', '\x1b[B', '\x1b[A', ' ']);
    expect(session.output()).toContain('Select a tool');

    fake.close(0);
    const first = await session.waitFinish();
    const second = await session.waitFinish();
    expect(first.exitCode).toBe(0);
    expect(second).toBe(first);
    expect(fake.ended).toBe(true);
  });

  it('keeps unread stdout for a later waitText', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    fake.pushStdout('Scope then Hook');
    await session.waitText('Scope');
    await session.waitText('Hook');
    expect(session.output()).toContain('Scope then Hook');

    session.kill();
    await session.waitFinish().catch(() => undefined);
  });

  it('does not rematch the same occurrence', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    fake.pushStdout('Scope');
    await session.waitText('Scope');

    let rematchError: unknown;
    try {
      await session.waitText('Scope', 50);
    } catch (error) {
      rematchError = error;
    }
    expect(rematchError).toBeInstanceOf(Error);
    expect(String(rematchError)).toContain('Timed out waiting for "Scope" on stdout');
    expect(String(rematchError)).toContain('--- stdout ---');
    expect(String(rematchError)).toContain('--- stderr ---');

    session.kill();
    await session.waitFinish().catch(() => undefined);
  });

  it('does not lose later text when an escape sequence splits across chunks', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    fake.pushStdout('Scope\x1b');
    await session.waitText('Scope');
    const later = session.waitText('Hook');
    fake.pushStdout('[2KHook the repo');
    await later;
    expect(session.output()).toContain('Hook the repo');

    session.kill();
    await session.waitFinish().catch(() => undefined);
  });

  it('waits for a repeated prompt only after a write', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    fake.pushStdout('Enter server URL');
    await session.waitText('Enter server URL');
    session.write('bad');
    session.keyEnter();

    const again = session.waitText('Enter server URL');
    fake.pushStdout('Enter server URL');
    await again;
    expect(fake.writes).toEqual(['bad', '\r']);

    session.kill();
    await session.waitFinish().catch(() => undefined);
  });

  it('does not treat a submitted prompt line as the next live prompt', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    fake.pushStdout('?  Enter server URL\n');
    await session.waitText('Enter server URL');
    session.write('bad-url');
    session.keyEnter();

    const submitted = session.waitText('Enter server URL', 50);
    fake.pushStdout('✓  Enter server URL bad-url\n');
    let rematchError: unknown;
    try {
      await submitted;
    } catch (error) {
      rematchError = error;
    }
    expect(rematchError).toBeInstanceOf(Error);
    expect(String(rematchError)).toContain('Timed out waiting for "Enter server URL" on stdout');

    const live = session.waitText('Enter server URL');
    fake.pushStdout('?  Enter server URL');
    await live;

    session.kill();
    await session.waitFinish().catch(() => undefined);
  });

  it('throws when the process exits before the prompt appears', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    const waiting = session.waitText('never shown');
    fake.close(1);
    let exitError: unknown;
    try {
      await waiting;
    } catch (error) {
      exitError = error;
    }
    expect(exitError).toBeInstanceOf(Error);
    expect(String(exitError)).toContain('CLI exited before "never shown" appeared on stdout');
  });

  it('sends Ctrl+C on keyCtrlC and treats kill as idempotent', async () => {
    const fake = createFakeProcess();
    const session = InteractiveSession.fromProcess(fake.handle, { timeoutMs: 2000 });

    fake.pushStdout('pick one');
    await session.waitText('pick one');
    session.keyCtrlC();
    expect(fake.writes).toEqual(['\x03']);

    session.kill();
    session.kill();
    expect(fake.killCount).toBe(1);
    expect(() => session.write('x')).toThrow('after kill()');

    const result = await session.waitFinish();
    expect(result.exitCode).toBe(1);
    expect(session.output()).toContain('pick one');
  });
});
