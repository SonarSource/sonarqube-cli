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

// Append workspace-relative paths to .cursorignore after secret detection blocks a file read.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { CURSOR_IGNORE_FILE } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

export const CURSOR_IGNORE_MARKER = '# sonar-secrets: auto-added after secret detection';

/**
 * Cursor reports `workspace_roots` as URI path components, which always start with `/`, so a
 * Windows drive path arrives as `/c:/Users/...`, a form Win32 rejects and Node misreads as
 * "root of the current drive". The drive-letter lookahead leaves POSIX (`/home/...`)
 * roots untouched, since Node already handles those as given.
 */
export function workspaceRootToPath(workspaceRoot: string): string {
  return workspaceRoot.replace(/^\/(?=[A-Za-z]:)/, '');
}

/**
 * Best-effort append of `filePath` to the `.cursorignore` of the workspace.
 * Returns false when nothing was recorded.
 */
export function appendToCursorIgnore(filePath: string, workspaceRoots: string[]): boolean {
  if (workspaceRoots.length === 0) {
    logger.debug('appendToCursorIgnore: hook payload carried no workspace roots');
    return false;
  }
  const absoluteFilePath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  try {
    const workspaceRoot = selectWorkspaceRoot(workspaceRoots, absoluteFilePath);
    if (!workspaceRoot) {
      logger.debug(`appendToCursorIgnore: no workspace root contains ${absoluteFilePath}`);
      return false;
    }

    const relativePath = toWorkspaceRelativePath(workspaceRoot, absoluteFilePath);
    if (!relativePath) return false;

    const ignorePath = join(workspaceRoot, CURSOR_IGNORE_FILE);
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

/**
 * Pick the workspace root containing `absoluteFilePath`. With nested roots the deepest one wins,
 * since it yields the shortest relative path and owns the `.cursorignore` closest to the file.
 */
function selectWorkspaceRoot(
  workspaceRoots: string[],
  absoluteFilePath: string,
): string | undefined {
  let best: string | undefined;
  let bestDepth = Infinity;
  for (const rawRoot of workspaceRoots) {
    if (!rawRoot) continue;

    const workspaceRoot = workspaceRootToPath(rawRoot);
    if (!existsSync(workspaceRoot)) {
      logger.debug(`appendToCursorIgnore: workspace root does not exist: ${workspaceRoot}`);
      continue;
    }

    const relativePath = toWorkspaceRelativePath(workspaceRoot, absoluteFilePath);
    if (relativePath && relativePath.length < bestDepth) {
      best = workspaceRoot;
      bestDepth = relativePath.length;
    }
  }
  return best;
}

function toWorkspaceRelativePath(
  workspaceRoot: string,
  absoluteFilePath: string,
): string | undefined {
  const rel = relative(workspaceRoot, absoluteFilePath);
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
