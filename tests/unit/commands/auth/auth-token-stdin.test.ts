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

import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'bun:test';

import { MAX_TOKEN_INPUT_BYTES, readTokenFromStdin } from '@/core/auth/token.ts';

async function expectFailure(promise: Promise<unknown>, message?: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (message) expect((error as Error).message).toContain(message);
}

describe('readTokenFromStdin', () => {
  it('reads all chunks and trims surrounding whitespace and CRLF', async () => {
    const input = Readable.from(['  existing-', 'token\r\n']);

    expect(await readTokenFromStdin(input)).toBe('existing-token');
  });

  it('rejects empty input', async () => {
    await expectFailure(
      readTokenFromStdin(Readable.from([' \r\n '])),
      'No token was provided on standard input.',
    );
  });

  it('rejects input larger than the limit without including its contents', async () => {
    const input = Readable.from(['x'.repeat(MAX_TOKEN_INPUT_BYTES + 1)]);

    await expectFailure(
      readTokenFromStdin(input),
      `Token input exceeds the ${MAX_TOKEN_INPUT_BYTES}-byte limit.`,
    );
  });

  it('reports stream errors without exposing the underlying error', async () => {
    const input = new PassThrough();
    const tokenPromise = readTokenFromStdin(input);

    input.emit('error', new Error('sensitive stream detail'));

    await expectFailure(tokenPromise, 'Failed to read token from standard input.');
  });

  it('removes stream listeners after a successful read', async () => {
    const input = new PassThrough();
    const tokenPromise = readTokenFromStdin(input);

    input.end('existing-token');
    await tokenPromise;

    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });

  it('removes stream listeners after a failed read', async () => {
    const input = new PassThrough();
    const tokenPromise = readTokenFromStdin(input);

    input.end('');
    await expectFailure(tokenPromise);

    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });
});
