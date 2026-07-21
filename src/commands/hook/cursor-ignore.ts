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

// Append project-relative paths to .cursorignore after secret detection blocks a file read.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { CURSOR_CONFIG_DIR, CURSOR_IGNORE_FILE } from '../../lib/config-constants.ts';
import logger from '../../lib/logger.ts';

export const CURSOR_IGNORE_MARKER = '# sonar-secrets: auto-added after secret detection';

// Best-effort append of a file path to the nearest project .cursorignore; returns false on failure.
export function appendToCursorIgnore(filePath: string): boolean {
  const absoluteFilePath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  try {
    const projectRoot = findCursorProjectRoot(absoluteFilePath);
    if (!projectRoot) {
      logger.debug(`appendToCursorIgnore: no Cursor project root for ${absoluteFilePath}`);
      return false;
    }

    const relativePath = toProjectRelativePath(projectRoot, absoluteFilePath);
    if (!relativePath) return false;

    const ignorePath = join(projectRoot, CURSOR_IGNORE_FILE);
    if (isPathAlreadyIgnored(ignorePath, relativePath)) return true;

    const entry = `${CURSOR_IGNORE_MARKER}\n${relativePath}\n`;
    if (existsSync(ignorePath)) {
      const existing = readFileSync(ignorePath, 'utf-8');
      const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
      appendFileSync(ignorePath, `${prefix}${entry}`, 'utf-8');
    } else {
      appendFileSync(ignorePath, entry, 'utf-8');
    }
    return true;
  } catch (err) {
    logger.debug(`appendToCursorIgnore: failed — ${(err as Error).message}`);
    return false;
  }
}

function findCursorProjectRoot(absoluteFilePath: string): string | undefined {
  let current = dirname(absoluteFilePath);

  for (;;) {
    if (existsSync(join(current, CURSOR_CONFIG_DIR))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function toProjectRelativePath(projectRoot: string, absoluteFilePath: string): string | undefined {
  const rel = relative(projectRoot, absoluteFilePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return undefined;
  }
  return rel.replaceAll('\\', '/');
}

function isPathAlreadyIgnored(ignorePath: string, relativePath: string): boolean {
  if (!existsSync(ignorePath)) return false;

  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .includes(relativePath);
}
