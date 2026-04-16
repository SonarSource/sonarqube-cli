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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { readStdinJson, readGitPushRefs } from '../../src/cli/commands/hook/stdin';

describe('readStdinJson', () => {
  type StdinListener = (...args: unknown[]) => void;
  const listeners: Record<string, StdinListener[]> = {};
  let onSpy: ReturnType<typeof spyOn>;

  function captureListener(event: string, fn: StdinListener) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return process.stdin;
  }

  function emitStdin(event: string, ...args: unknown[]) {
    for (const fn of listeners[event] ?? []) {
      fn(...args);
    }
  }

  beforeEach(() => {
    for (const key of Object.keys(listeners)) {
      delete listeners[key];
    }
    onSpy = spyOn(process.stdin, 'on').mockImplementation(
      captureListener as Parameters<typeof spyOn>[2],
    );
  });

  afterEach(() => {
    onSpy.mockRestore();
  });

  it('parses a JSON object from stdin', async () => {
    const payload = { tool_name: 'Read', tool_input: { file_path: '/tmp/test.ts' } };
    const promise = readStdinJson<typeof payload>();
    emitStdin('data', Buffer.from(JSON.stringify(payload)));
    emitStdin('end');
    expect(await promise).toEqual(payload);
  });

  it('assembles multiple data chunks before parsing', async () => {
    const payload = { a: 1, b: 'hello' };
    const json = JSON.stringify(payload);
    const mid = Math.floor(json.length / 2);
    const promise = readStdinJson<typeof payload>();
    emitStdin('data', Buffer.from(json.slice(0, mid)));
    emitStdin('data', Buffer.from(json.slice(mid)));
    emitStdin('end');
    expect(await promise).toEqual(payload);
  });

  it('throws when stdin contains invalid JSON', async () => {
    const promise = readStdinJson();
    emitStdin('data', Buffer.from('not-valid-json'));
    emitStdin('end');
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Failed to parse stdin as JSON');
  });

  it('throws when stdin emits an error event', async () => {
    const promise = readStdinJson();
    emitStdin('error', new Error('stdin read failed'));
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('stdin read failed');
  });

  it('throws when stdin read times out', async () => {
    let timeoutFn: (() => void) | undefined;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      timeoutFn = fn as () => void;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      const promise = readStdinJson();
      // Promise.race is set up; setTimeout callback captured — fire it now
      timeoutFn?.();
      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('stdin read timed out');
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe('readGitPushRefs', () => {
  type StdinListener = (...args: unknown[]) => void;
  const listeners: Record<string, StdinListener[]> = {};
  let onSpy: ReturnType<typeof spyOn>;

  function captureListener(event: string, fn: StdinListener) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return process.stdin;
  }

  function emitStdin(event: string, ...args: unknown[]) {
    for (const fn of listeners[event] ?? []) {
      fn(...args);
    }
  }

  beforeEach(() => {
    for (const key of Object.keys(listeners)) {
      delete listeners[key];
    }
    onSpy = spyOn(process.stdin, 'on').mockImplementation(
      captureListener as Parameters<typeof spyOn>[2],
    );
  });

  afterEach(() => {
    onSpy.mockRestore();
  });

  it('parses valid push ref lines', async () => {
    const localSha = 'abc1234abc1234abc1234abc1234abc1234abc123';
    const remoteSha = 'def5678def5678def5678def5678def5678def56';
    const promise = readGitPushRefs();
    emitStdin('data', Buffer.from(`refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`));
    emitStdin('end');
    const refs = await promise;
    expect(refs).toHaveLength(1);
    expect(refs[0].localRef).toBe('refs/heads/main');
    expect(refs[0].localSha).toBe(localSha);
    expect(refs[0].remoteRef).toBe('refs/heads/main');
    expect(refs[0].remoteSha).toBe(remoteSha);
  });

  it('filters out lines missing required fields', async () => {
    const promise = readGitPushRefs();
    emitStdin('data', Buffer.from('refs/heads/main only-two-fields\n'));
    emitStdin('end');
    const refs = await promise;
    expect(refs).toHaveLength(0);
  });

  it('returns empty array when stdin times out', async () => {
    let timeoutFn: (() => void) | undefined;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      timeoutFn = fn as () => void;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      const promise = readGitPushRefs();
      timeoutFn?.();
      expect(await promise).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('returns empty array when stdin emits an error', async () => {
    const promise = readGitPushRefs();
    emitStdin('error', new Error('pipe broken'));
    expect(await promise).toEqual([]);
  });
});
