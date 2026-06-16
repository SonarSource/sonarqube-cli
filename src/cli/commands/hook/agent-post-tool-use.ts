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

// PostToolUse callback handler — runs SQAA analysis after the agent edits or writes a file.
// Replaces the bash/PowerShell logic that was previously embedded in the hook script.

import { existsSync, readFileSync } from 'node:fs';

import { resolveAuth } from '../../../lib/auth-resolver';
import { canonicalizePath, toRelativePosixPath } from '../../../lib/fs-utils';
import logger from '../../../lib/logger';
import { SonarQubeClient } from '../../../sonarqube/client';
import { formatSqaaIssuesForHook, writePostToolUseHookOutput } from './format-sqaa-hook-context';
import { readStdinJson } from './stdin';

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

export interface AgentPostToolUseOptions {
  project?: string;
}

export async function agentPostToolUse(options: AgentPostToolUseOptions): Promise<void> {
  let payload: PostToolUsePayload;
  try {
    payload = await readStdinJson<PostToolUsePayload>();
  } catch {
    return; // unparseable stdin — non-blocking
  }

  const toolName = payload.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  const filePath = payload.tool_input?.file_path;
  if (!filePath || !existsSync(filePath)) return;

  const auth = await resolveAuth().catch(() => null);
  if (auth?.connectionType !== 'cloud' || !auth.orgKey) return;

  const projectKey = options.project;
  if (!projectKey) return;

  const canonicalPath = canonicalizePath(filePath);
  const normalizedPath = toRelativePosixPath(canonicalPath);
  if (normalizedPath == null) {
    logger.debug(`PostToolUse SQAA skipped: file outside cwd: ${filePath}`);
    return;
  }

  try {
    const fileContent = readFileSync(canonicalPath, 'utf-8');
    const client = new SonarQubeClient(auth.serverUrl, auth.token);

    const response = await client.createAnalysis({
      organizationKey: auth.orgKey,
      projectKey,
      files: [{ path: normalizedPath, content: fileContent }],
    });

    const text = formatSqaaIssuesForHook(response.issues, response.errors, normalizedPath);
    writePostToolUseHookOutput(text);
  } catch (err) {
    logger.debug(`PostToolUse SQAA analysis failed: ${(err as Error).message}`);
  }
}
