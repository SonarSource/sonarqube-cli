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
import { basename, relative } from 'node:path';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { parseGitRemote } from '@/core/host/git/remote-parse.ts';
import { normalizePath } from '@/core/io/fs-utils.ts';
import { isValidProjectKey } from '@/core/project-key.ts';
import type { ProjectVisibility } from '@/core/server/projects.ts';

const MAX_NAME_LENGTH = 255;
const MAX_SEGMENT_LENGTH = 80;
const HASH_LENGTH = 12;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

interface RepositoryIdentity {
  name: string;
  identity: string;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function repositoryIdentity(remote: string): RepositoryIdentity | undefined {
  const parsed = parseGitRemote(remote);
  if (!parsed) return undefined;
  const path = trimSlashes(parsed.path).normalize('NFC');
  const name = path.split('/').at(-1);
  return name ? { name, identity: `git:${parsed.host}/${path}` } : undefined;
}

function keySegment(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return slug.replace(/^[._-]+|[._-]+$/g, '').slice(0, MAX_SEGMENT_LENGTH) || 'project';
}

export interface ProjectProposal {
  projectKey: string;
  projectName: string;
}

/**
 * Deterministic key `<organization_><name>-<12-char sha256>`. The hash covers the organization and
 * the repository identity (never a local path), so clones and worktrees of one repository agree.
 * A sub-directory of a repository adds its relative path, which keeps monorepo folders apart.
 */
export function generateProjectProposal(
  projectRoot: string,
  remote: string | undefined,
  organization: string | undefined,
): ProjectProposal {
  const { gitRoot, isGit } = findGitRoot(projectRoot);
  const repository = remote ? repositoryIdentity(remote) : undefined;
  const subdirectory =
    isGit && repository ? normalizePath(relative(gitRoot, projectRoot)).normalize('NFC') : '';
  const directoryName = basename(projectRoot) || 'project';
  const projectName = subdirectory ? directoryName : (repository?.name ?? directoryName);
  const baseIdentity = repository?.identity ?? `directory:${directoryName.normalize('NFC')}`;
  const identity = subdirectory ? JSON.stringify([baseIdentity, subdirectory]) : baseIdentity;
  const hash = createHash('sha256')
    .update(JSON.stringify([organization ?? '', identity]))
    .digest('hex')
    .slice(0, HASH_LENGTH);
  const prefix = organization ? `${keySegment(organization)}_` : '';
  return { projectKey: `${prefix}${keySegment(projectName)}-${hash}`, projectName };
}

export function validateProjectKey(key: string): string {
  const trimmed = key.trim();
  if (!isValidProjectKey(trimmed)) {
    throw new InvalidOptionError(
      '--project-key must contain only letters, digits, "-", "_", "." and ":", with at least one non-digit.',
    );
  }
  return trimmed;
}

export function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidOptionError(
      `--name must be non-empty, at most ${MAX_NAME_LENGTH} characters, and free of control characters.`,
    );
  }
  return trimmed;
}

export function validateVisibility(visibility: string): ProjectVisibility {
  if (visibility === 'private' || visibility === 'public') {
    return visibility;
  }
  throw new InvalidOptionError('--visibility must be private or public.');
}
