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

// Stdin reader used by all sonar callback handlers.
// Hook agents pipe their JSON event payload to the callback process via stdin.

const STDIN_TIMEOUT_MS = 5000;

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/**
 * Read git pre-push refs from stdin.
 * Git passes refs as raw space-separated lines: <localRef> <localSha> <remoteRef> <remoteSha>
 * Returns an empty array on timeout or error.
 */
export async function readGitPushRefs(): Promise<PushRef[]> {
  let raw: string;
  try {
    raw = await readRawStdin();
  } catch {
    return []; // timeout or read error — allow the push
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(' ');
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((r) => r.localSha && r.remoteSha);
}

/**
 * Read stdin, parse as JSON, and return the result typed as T.
 * Throws if stdin is not valid JSON or if the read times out.
 */
export async function readStdinJson<T>(): Promise<T> {
  const raw = await readRawStdin();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Failed to parse stdin as JSON');
  }
}

async function readRawStdin(): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
        process.stdin.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
        process.stdin.on('error', reject);
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`stdin read timed out after ${STDIN_TIMEOUT_MS}ms`));
        }, STDIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
