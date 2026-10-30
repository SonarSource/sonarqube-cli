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

  it('keeps a trailing newline when trimming is turned off', async () => {
    const result = await spawnProcess(
      process.execPath,
      ['-e', 'process.stdout.write("skill\\n")'],
      { stdout: 'pipe', trimOutput: false },
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
});
