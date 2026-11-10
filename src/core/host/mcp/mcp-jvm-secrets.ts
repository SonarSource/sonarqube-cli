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

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { CommandFailedError } from '../../commands/command-error.ts';
import { CLI_TMP_DIR } from '../../config-constants.ts';
import { normalizePath } from '../../io/fs-utils.ts';
import logger from '../../observability/logger.ts';

const NON_TRAVERSABLE = 0o700;
const DOCKER_READABLE = 0o644;
const ORPHAN_MIN_AGE_MS = 900_000;
const JVM_SECRETS_FILE_PATTERN = /^mcp-jvm-secrets-(\d+)-[0-9a-f-]{36}\.args$/;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeOrphanedJvmSecrets(): void {
  let names: string[];
  try {
    names = readdirSync(CLI_TMP_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const match = JVM_SECRETS_FILE_PATTERN.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || isProcessRunning(pid))
      continue;
    const path = join(CLI_TMP_DIR, name);
    try {
      if (Date.now() - statSync(path).mtimeMs >= ORPHAN_MIN_AGE_MS) rmSync(path, { force: true });
    } catch {
      // Windows may still hold the file; retry on the next run.
    }
  }
}

function quoteJavaArgument(argument: string): string {
  if (argument.includes('\0') || Buffer.from(argument, 'utf8').toString('utf8') !== argument) {
    throw new CommandFailedError('MCP JVM configuration contains an unsupported character.');
  }
  const escaped = argument
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('\t', String.raw`\t`)
    .replaceAll('\f', String.raw`\f`);
  return `"${escaped}"`;
}

export function removeJvmSecretsFile(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    logger.warn('Could not remove MCP JVM configuration file.');
  }
}

export function writeJvmSecretsFile(secretOpts: string[]): string | undefined {
  if (secretOpts.length === 0) return undefined;
  const contents = `${secretOpts.map(quoteJavaArgument).join('\n')}\n`;
  const path = join(CLI_TMP_DIR, `mcp-jvm-secrets-${process.pid}-${randomUUID()}.args`);
  let fd: number | undefined;
  try {
    mkdirSync(CLI_TMP_DIR, { recursive: true, mode: NON_TRAVERSABLE });
    chmodSync(CLI_TMP_DIR, NON_TRAVERSABLE);
    removeOrphanedJvmSecrets();
    fd = openSync(path, 'wx', DOCKER_READABLE);
    writeFileSync(fd, contents);
    fchmodSync(fd, DOCKER_READABLE);
    closeSync(fd);
    fd = undefined;
    return normalizePath(path);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Still remove the owned file when closing fails.
      }
      removeJvmSecretsFile(path);
    }
    throw new CommandFailedError('Could not prepare MCP JVM configuration.');
  }
}
