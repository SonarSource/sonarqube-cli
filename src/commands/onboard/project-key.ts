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

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { getGitRemote } from '@/core/host/git/discover.ts';
import { resolveGitRepoRoot, resolveMainWorktreeRoot } from '@/core/host/git/worktree.ts';

interface RepositoryIdentity {
  name: string;
  identity: string;
}

function repositoryIdentity(remote: string): RepositoryIdentity | undefined {
  let host: string;
  let path: string;
  try {
    const url = new URL(remote);
    if (!url.hostname) return undefined;
    host = url.hostname.toLowerCase();
    if (url.port && !(url.protocol === 'ssh:' && url.port === '22')) host += `:${url.port}`;
    path = url.pathname;
  } catch {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
    if (!scp || /^[a-zA-Z]:[\\/]/.test(remote)) return undefined;
    host = scp[1].toLowerCase();
    path = scp[2];
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  path = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .normalize('NFC');
  const name = path.split('/').at(-1);
  if (!name) return undefined;
  return { name, identity: `git:${host}/${path}` };
}

function keyName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80) || 'project'
  );
}

export async function generateProjectTarget(
  invocationRoot: string,
  repoRoot: string | undefined,
  organization: string | undefined,
): Promise<{ projectKey: string; projectRoot: string; projectName: string }> {
  const gitRoot = repoRoot ? await resolveGitRepoRoot(invocationRoot) : null;
  const projectRoot = gitRoot ?? invocationRoot;
  const repository = gitRoot ? repositoryIdentity(await getGitRemote(gitRoot)) : undefined;
  const nameRoot =
    gitRoot && !repository ? ((await resolveMainWorktreeRoot(gitRoot)) ?? gitRoot) : projectRoot;
  const projectName = (repository?.name ?? basename(nameRoot)) || 'project';
  const identity = repository?.identity ?? `directory:${projectName.normalize('NFC')}`;
  const hash = createHash('sha256')
    .update(JSON.stringify([organization ?? '', identity]))
    .digest('hex')
    .slice(0, 12);
  const prefix = organization ? `${keyName(organization)}_` : '';
  return { projectRoot, projectName, projectKey: `${prefix}${keyName(projectName)}-${hash}` };
}
