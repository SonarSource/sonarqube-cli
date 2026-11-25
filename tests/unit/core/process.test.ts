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

import type { ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  ProcessTimedOutError,
  type SpawnOptions,
  spawnProcessCapturingBytes,
  spawnProcessWithTimeout,
} from '@/core/process/process.ts';

const TEST_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MESSAGE = 'test process timed out';

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}) {
  return spawnProcessWithTimeout(command, args, options, TEST_TIMEOUT_MS, TEST_TIMEOUT_MESSAGE);
}

// Three bytes per character, so the boundaries of power-of-two sized chunks fall inside one.
const WIDE_CHAR = '€';
const CHAR_COUNT = 200_000;
const EXPECTED = WIDE_CHAR.repeat(CHAR_COUNT);

function emitTo(stream: 'stdout' | 'stderr'): string[] {
  return ['-e', `process.${stream}.write('${WIDE_CHAR}'.repeat(${String(CHAR_COUNT)}))`];
}

describe('spawnProcess', () => {
  it('keeps a character whose bytes straddle two stdout chunks intact', async () => {
    const result = await spawnProcess(process.execPath, emitTo('stdout'), { stdout: 'pipe' });

    expect(result.stdout).toBe(EXPECTED);
  });

  it('keeps a character whose bytes straddle two stderr chunks intact', async () => {
    const result = await spawnProcess(process.execPath, emitTo('stderr'), { stderr: 'pipe' });

    expect(result.stderr).toBe(EXPECTED);
  });

  it('returns stdout unchanged, including a trailing newline', async () => {
    const result = await spawnProcess(
      process.execPath,
      ['-e', 'process.stdout.write("skill\\n")'],
      { stdout: 'pipe' },
    );

    expect(result.stdout).toBe('skill\n');
  });

  it('does not pass the parent environment through when env is isolated', async () => {
    const leak = 'SQCLI_ISOLATED_ENV_LEAK';
    const previous = process.env[leak];
    process.env[leak] = 'yes';
    try {
      const result = await spawnProcess(
        process.execPath,
        ['-e', `process.stdout.write(process.env.${leak} ?? 'absent')`],
        { stdout: 'pipe', isolateEnv: true, env: {} },
      );

      expect(result.stdout).toBe('absent');
    } finally {
      if (previous === undefined) delete process.env[leak];
      else process.env[leak] = previous;
    }
  });
});

describe('spawnProcess stdin source', () => {
  const CHUNK = 64 * 1024;

  // eslint-disable-next-line @typescript-eslint/require-await -- an async generator with nothing to await is still the right shape
  async function* chunks(count: number, produced: { n: number }): AsyncGenerator<Buffer> {
    for (let i = 0; i < count; i++) {
      produced.n++;
      yield Buffer.alloc(CHUNK);
    }
  }

  it('delivers every byte to a child that reads slower than we write', async () => {
    const produced = { n: 0 };
    const counter =
      'let n=0;process.stdin.on("data",c=>{n+=c.length});process.stdin.on("end",()=>{process.stdout.write(String(n))})';

    const result = await spawnProcess(process.execPath, ['-e', counter], {
      stdin: 'pipe',
      stdinData: chunks(200, produced),
    });

    expect(result.stdout).toBe(String(200 * CHUNK));
    expect(produced.n).toBe(200);
  });

  it('stops pulling the source when the child never reads it', async () => {
    const produced = { n: 0 };

    await spawnProcess(process.execPath, ['-e', 'process.exit(0)'], {
      stdin: 'pipe',
      stdinData: chunks(5000, produced),
    }).catch(() => undefined);

    // Without backpressure every chunk would be produced and buffered in memory.
    expect(produced.n).toBeLessThan(100);
  });

  it('returns a failed result when a child exits before reading its input', async () => {
    const result = await spawnProcess(
      process.execPath,
      ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 100)'],
      { stdin: 'pipe', stdinData: 'input'.repeat(1_000_000) },
    );

    expect(result.exitCode).toBe(1);
  });
});

describe('spawnProcess stdin, against a mocked child', () => {
  /** A child whose stdin the test controls, and whose close the test decides. */
  function mockChild(stdin: Writable) {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: Readable | null;
      stderr: null;
      kill: () => void;
      killed: boolean;
    };
    proc.stdin = stdin;
    proc.stdout = null;
    proc.stderr = null;
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
    };
    spyOn(childProcess, 'spawn').mockReturnValue(proc as unknown as ChildProcess);
    return proc;
  }

  /** `stall` never completes a write, so the pipe stays full and the source cannot be pulled on. */
  function sink(options: { stall?: boolean } = {}) {
    const written: Buffer[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, done) {
        written.push(Buffer.from(chunk));
        if (!options.stall) done();
      },
    });
    return { stream, written };
  }

  afterEach(() => {
    spyOn(childProcess, 'spawn').mockRestore();
  });

  it('pulls the source no further than the child has taken', async () => {
    const { stream, written } = sink({ stall: true });
    const proc = mockChild(stream);
    let produced = 0;
    // eslint-disable-next-line @typescript-eslint/require-await -- a generator with nothing to await is still the shape under test
    async function* many(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 100; i++) {
        produced++;
        yield Buffer.from('x');
      }
    }

    const running = spawnProcess('child', [], { stdin: 'pipe', stdinData: many() });
    await Bun.sleep(20);

    expect(written).toHaveLength(1);
    expect(produced).toBeLessThan(5);

    proc.emit('close', 0);
    await running;
  });

  it('keeps stdout that arrives after exit and before the pipes close', async () => {
    const stdout = new Readable({ read() {} });
    const { stream } = sink();
    const proc = mockChild(stream);
    proc.stdout = stdout;

    const running = spawnProcess('child', [], { stdout: 'pipe' });
    proc.emit('exit', 0);
    stdout.push(Buffer.from('secret.js'));
    await new Promise((resolve) => {
      stdout.once('data', () => resolve(undefined));
    });
    proc.emit('close', 0);
    const result = await running;

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'secret.js',
      stderr: '',
    });
  });

  it('records the signal that killed the child', async () => {
    const { stream } = sink();
    const proc = mockChild(stream);

    const running = spawnProcess('child', []);
    proc.emit('close', null, 'SIGTERM');
    const result = await running;

    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  it('stops pulling the source once the child stops reading', async () => {
    const { stream } = sink();
    const proc = mockChild(stream);
    let produced = 0;
    let cleanedUp = false;
    // eslint-disable-next-line @typescript-eslint/require-await -- a generator with nothing to await is still the shape under test
    async function* many(): AsyncGenerator<Buffer> {
      try {
        for (let i = 0; i < 100; i++) {
          produced++;
          yield Buffer.from('x');
          if (i === 0) stream.destroy();
        }
      } finally {
        cleanedUp = true;
      }
    }

    // A destroyed destination rejects the feed, so the handler goes on before anything is awaited.
    const running = spawnProcess('child', [], { stdin: 'pipe', stdinData: many() }).catch(
      () => undefined,
    );
    await Bun.sleep(20);

    expect(produced).toBeLessThan(100);
    // The generator is returned rather than abandoned, so anything it holds is released.
    expect(cleanedUp).toBe(true);

    proc.emit('close', 0);
    await running;
  });

  it('kills the child and reports the failure when the source throws', async () => {
    const { stream } = sink();
    const proc = mockChild(stream);
    // eslint-disable-next-line @typescript-eslint/require-await -- a generator with nothing to await is still the shape under test
    async function* failing(): AsyncGenerator<Buffer> {
      yield Buffer.from('first');
      throw new Error('could not read the next commit');
    }

    const failure = await spawnProcess('child', [], {
      stdin: 'pipe',
      stdinData: failing(),
    }).catch((err: Error) => err);

    expect((failure as Error).message).toBe('could not read the next commit');
    expect(proc.killed).toBe(true);
  });

  it('rejects and kills a child that does not exit', async () => {
    const { stream } = sink();
    const proc = mockChild(stream);

    const failure = await spawnProcessWithTimeout(
      'child',
      [],
      { stdout: 'pipe' },
      20,
      'hung',
    ).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(ProcessTimedOutError);
    expect((failure as Error).message).toBe('hung');
    expect(proc.killed).toBe(true);
  });

  it('writes a string straight through rather than pulling it', async () => {
    const { stream, written } = sink();
    const proc = mockChild(stream);

    const running = spawnProcess('child', [], { stdin: 'pipe', stdinData: 'hello' });
    await Bun.sleep(10);
    proc.emit('close', 0);
    await running;

    expect(Buffer.concat(written).toString()).toBe('hello');
    expect(stream.writableEnded).toBe(true);
  });

  it('kills the child when options.signal aborts (after spawn or already aborted) and cleans up listener', async () => {
    const controller = new AbortController();
    const proc = mockChild(sink().stream);
    const removeListener = spyOn(controller.signal, 'removeEventListener');

    const running = spawnProcess('child', [], { signal: controller.signal });
    expect(proc.killed).toBe(false);
    controller.abort();
    expect(proc.killed).toBe(true);
    proc.emit('close', null, 'SIGTERM');
    expect((await running).signal).toBe('SIGTERM');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

    const alreadyAbortedProc = mockChild(sink().stream);
    const abortedRun = spawnProcess('child', [], { signal: controller.signal });
    expect(alreadyAbortedProc.killed).toBe(true);
    alreadyAbortedProc.emit('close', null, 'SIGTERM');
    await abortedRun;
  });

  it('falls back to proc.kill() when process-group termination fails on stdin error', async () => {
    const proc = mockChild(sink().stream) as ReturnType<typeof mockChild> & { pid?: number };
    proc.pid = 999_999_999;
    const spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(proc as unknown as ChildProcess);
    // eslint-disable-next-line @typescript-eslint/require-await -- a generator with nothing to await is still the shape under test
    async function* failing(): AsyncGenerator<Buffer> {
      yield Buffer.from('first');
      throw new Error('stdin source failed');
    }

    const failure = await spawnProcess('child', [], {
      stdin: 'pipe',
      stdinData: failing(),
      killProcessTree: true,
    }).catch((err: Error) => err);

    expect((failure as Error).message).toBe('stdin source failed');
    expect(spawnSpy).toHaveBeenCalledWith(
      'child',
      [],
      expect.objectContaining({ detached: process.platform !== 'win32' }),
    );
    expect(proc.killed).toBe(true);
  });
});

function grandchildScript(ignoreSigterm: boolean): string {
  const child = [
    ignoreSigterm ? "process.on('SIGTERM', () => {});" : '',
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
    'setInterval(() => {}, 60_000);',
  ].join(' ');
  return `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(child)}, process.argv[1]], { stdio: 'ignore' });
    setInterval(() => {}, 60_000);
  `;
}

async function waitForGrandchildPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      if (pid > 0) return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error('Fixture did not write the grandchild PID.');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await Bun.sleep(20);
  }
  return !isProcessAlive(pid);
}

describe('spawnProcessWithTimeout killProcessTree', () => {
  const spawnedPids: number[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process already exited.
      }
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createTreeFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'process-tree-test-'));
    tempDirs.push(dir);
    const pidFile = join(dir, 'grandchild.pid');
    const grandchildPid = waitForGrandchildPid(pidFile).then((pid) => {
      spawnedPids.push(pid);
      return pid;
    });
    return { pidFile, grandchildPid };
  }

  function spawnTree(
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      ignoreSigterm?: boolean;
      failStdin?: boolean;
    } = {},
  ) {
    const { pidFile, grandchildPid } = createTreeFixture();
    async function* failingInput(): AsyncGenerator<Buffer> {
      await grandchildPid;
      throw new Error('stdin source failed');
    }
    const running = spawnProcessWithTimeout(
      process.execPath,
      ['-e', grandchildScript(options.ignoreSigterm ?? false), pidFile],
      {
        killProcessTree: true,
        signal: options.signal,
        stdin: options.failStdin ? 'pipe' : undefined,
        stdinData: options.failStdin ? failingInput() : undefined,
      },
      options.timeoutMs ?? TEST_TIMEOUT_MS,
      TEST_TIMEOUT_MESSAGE,
    );
    return { grandchildPid, running };
  }

  it('terminates descendant processes on signal abort', async () => {
    const controller = new AbortController();
    const { grandchildPid, running } = spawnTree({
      signal: controller.signal,
      ignoreSigterm: process.platform !== 'win32',
    });

    const pid = await grandchildPid;
    expect(isProcessAlive(pid)).toBe(true);

    controller.abort();
    const result = await running;
    if (process.platform !== 'win32') expect(result.signal).toBe('SIGTERM');
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('escalates on stdin failure and preserves the input error', async () => {
    const { grandchildPid, running } = spawnTree({
      failStdin: true,
      ignoreSigterm: process.platform !== 'win32',
    });
    const failure = running.catch((error: unknown) => error);

    const pid = await grandchildPid;

    expect(await failure).toEqual(new Error('stdin source failed'));
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('escalates on timeout after the direct child exits and a descendant ignores SIGTERM', async () => {
    const { grandchildPid, running } = spawnTree({
      timeoutMs: 500,
      ignoreSigterm: process.platform !== 'win32',
    });
    const settled = running.catch((err: unknown) => err);
    const pid = await Promise.race([
      grandchildPid,
      settled.then((outcome) => {
        throw new Error(`Process settled before reporting grandchild pid: ${String(outcome)}`);
      }),
    ]);
    expect(isProcessAlive(pid)).toBe(true);

    const failure = await settled;
    expect(failure).toBeInstanceOf(ProcessTimedOutError);
    expect((failure as Error).message).toBe(TEST_TIMEOUT_MESSAGE);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'forwards parent SIGINT to a detached killProcessTree child without leaving orphans',
    async () => {
      const processModule = join(import.meta.dir, '../../../src/core/process/process.ts');
      const { pidFile, grandchildPid } = createTreeFixture();
      const driver = `
        import { spawnProcessWithTimeout } from ${JSON.stringify(processModule)};
        await spawnProcessWithTimeout(
          process.execPath,
          ['-e', ${JSON.stringify(grandchildScript(false))}, process.argv[1]],
          { killProcessTree: true },
          5000,
          'timeout',
        );
      `;
      const parent = childProcess.spawn(process.execPath, ['-e', driver, pidFile], {
        stdio: 'ignore',
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
        parent.once('error', reject);
        parent.once('close', (_code, sig) => resolve(sig));
      });
      const pid = await Promise.race([
        grandchildPid,
        exited.then((signal) => {
          throw new Error(`Parent exited early (${String(signal)})`);
        }),
      ]);
      expect(isProcessAlive(pid)).toBe(true);

      parent.kill('SIGINT');
      expect(await exited).toBe('SIGINT');
      expect(await waitForProcessExit(pid)).toBe(true);
    },
  );
});

describe('spawnProcessCapturingBytes', () => {
  it('keeps a character whose bytes straddle two stderr chunks intact', async () => {
    const result = await spawnProcessCapturingBytes(
      process.execPath,
      emitTo('stderr'),
      { stderr: 'pipe' },
      TEST_TIMEOUT_MS,
      TEST_TIMEOUT_MESSAGE,
    );

    expect(result.stderr).toBe(EXPECTED);
  });

  it('terminates descendant processes on signal abort when killProcessTree is true', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'process-bytes-tree-test-'));
    const pidFile = join(tempDir, 'grandchild.pid');
    let grandchildPid: number | undefined;
    try {
      const controller = new AbortController();
      const running = spawnProcessCapturingBytes(
        process.execPath,
        [
          '-e',
          "const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'inherit' }); writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 60_000);",
          pidFile,
        ],
        { stderr: 'pipe', killProcessTree: true, signal: controller.signal },
        TEST_TIMEOUT_MS,
        TEST_TIMEOUT_MESSAGE,
      );

      grandchildPid = await waitForGrandchildPid(pidFile);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      controller.abort();
      await running;
      expect(await waitForProcessExit(grandchildPid)).toBe(true);
    } finally {
      if (grandchildPid !== undefined) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
