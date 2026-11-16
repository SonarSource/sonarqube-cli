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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';

const MAX_MODULE_DEPTH = 100;
const JAVA_TRIM_MAX_CODE_POINT = 0x20;
const RESTRICTED =
  /(?:^|\.)sonar\.scanner\.(?:proxy(?:Host|Port|User|Password)|truststore(?:Path|Password)|keystore(?:Path|Password)|internal\.dumpToFile)$/;

function decode(value: string): string {
  return value.replace(/\\(u[\da-fA-F]{4}|[\s\S])/g, (_, escape: string) => {
    if (escape.startsWith('u')) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    return ({ t: '\t', r: '\r', n: '\n', f: '\f' } as Record<string, string>)[escape] ?? escape;
  });
}

/** Scanner paths use Java String.trim(), which preserves non-ASCII whitespace. */
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (
    start < end &&
    (value.codePointAt(start) ?? Number.POSITIVE_INFINITY) <= JAVA_TRIM_MAX_CODE_POINT
  )
    start++;
  while (
    end > start &&
    (value.codePointAt(end - 1) ?? Number.POSITIVE_INFINITY) <= JAVA_TRIM_MAX_CODE_POINT
  )
    end--;
  return value.slice(start, end);
}

function propertyEntry(line: string): [string, string] {
  let end = 0;
  while (end < line.length && !/[=:\t\f ]/.test(line[end])) {
    end += line[end] === '\\' ? 2 : 1;
  }
  let start = end;
  while (/[ \t\f]/.test(line[start] ?? '') && start < line.length) start++;
  if (line[start] === '=' || line[start] === ':') start++;
  while (/[ \t\f]/.test(line[start] ?? '') && start < line.length) start++;
  return [decode(line.slice(0, end)), javaTrim(decode(line.slice(start)))];
}

function continues(line: string): boolean {
  let start = line.length;
  while (start > 0 && line[start - 1] === '\\') start--;
  return (line.length - start) % 2 !== 0;
}

/** Java properties support escaped separators, Unicode keys and continued logical lines. */
function properties(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const result = new Map<string, string>();
  const content = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
  let pending = '';
  for (const physical of content.split('\n')) {
    const line = pending + physical.replace(/^[ \t\f]+/, '');
    if (!pending && (!line || /^[#!]/.test(line))) continue;
    if (continues(line)) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = '';
    const [key, value] = propertyEntry(line);
    result.set(key, value);
  }
  if (pending) throw new CommandFailedError('Cannot inspect an incomplete scanner property.');
  return result;
}

function assertSafe(values: Map<string, string>, prefix = ''): void {
  for (const key of values.keys()) {
    if (RESTRICTED.test(`${prefix}${key}`)) {
      throw new CommandFailedError(
        'Repository scanner proxy, TLS and diagnostic-dump settings are not allowed.',
        {
          remediationHint:
            'Remove these settings from scanner property files. Configure proxy and TLS through the CLI network settings.',
        },
      );
    }
  }
}

function sameDirectory(left: string, right: string): boolean {
  const identity = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  return identity(left) === identity(right);
}

function inspectModules(
  values: Map<string, string>,
  base: string,
  parentPrefix = '',
  depth = 0,
): void {
  if (depth >= MAX_MODULE_DEPTH) {
    throw new CommandFailedError('Cannot inspect cyclic or deeply nested scanner modules.');
  }
  const modules = (values.get('sonar.modules') ?? '').split(',').map(javaTrim).filter(Boolean);
  for (const id of modules) {
    const prefix = `${id}.`;
    const child = new Map(
      [...values]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
    const baseOverride = child.get('sonar.projectBaseDir');
    const configOverride = child.get('sonar.projectConfigFile');
    let directory = resolve(base, javaTrim(baseOverride ?? id));
    let path = join(directory, 'sonar-project.properties');
    if (baseOverride === undefined && configOverride !== undefined) {
      path = resolve(base, javaTrim(configOverride));
      directory = dirname(path);
    }
    // The scanner skips the parent's file when an explicit module base is the same directory.
    const loaded =
      baseOverride !== undefined && sameDirectory(base, directory)
        ? new Map<string, string>()
        : properties(path);
    const modulePrefix = `${parentPrefix}${prefix}`;
    assertSafe(loaded, modulePrefix);
    for (const [key, value] of loaded) child.set(key, value);
    directory = resolve(directory, javaTrim(loaded.get('sonar.projectBaseDir') ?? '.'));
    assertSafe(child, modulePrefix);
    inspectModules(child, directory, modulePrefix, depth + 1);
  }
}

export function assertScannerConfigurationSafe(
  projectRoot: string,
  scannerHome: string,
  overrides: Map<string, string>,
): void {
  const global = properties(join(scannerHome, 'conf', 'sonar-scanner.properties'));
  const root = properties(join(projectRoot, 'sonar-project.properties'));
  assertSafe(global);
  assertSafe(root);
  const values = new Map([...root, ...overrides]);
  assertSafe(values);
  inspectModules(values, projectRoot);
}
