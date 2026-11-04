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

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { generateProjectProposal } from '@/commands/init/key-proposal.ts';

const directory = () => realpathSync(mkdtempSync(join(tmpdir(), 'init-key-')));

describe('generateProjectProposal', () => {
  it('gives HTTPS and SSH remotes of one repository the same key', () => {
    const root = directory();

    const https = generateProjectProposal(root, 'https://github.com/Example/My-Repo.git', 'org');
    const ssh = generateProjectProposal(root, 'git@github.com:Example/My-Repo.git', 'org');

    expect(https).toEqual(ssh);
    expect(https.projectName).toBe('My-Repo');
    expect(https.projectKey).toMatch(/^org_my-repo-[0-9a-f]{12}$/);
  });

  it('accepts an SCP-style remote without a user', () => {
    const root = directory();

    expect(generateProjectProposal(root, 'github.com:Example/My-Repo.git', 'org')).toEqual(
      generateProjectProposal(root, 'https://github.com/Example/My-Repo.git', 'org'),
    );
  });

  it('does not depend on the checkout path', () => {
    const remote = 'https://github.com/example/repo.git';

    expect(generateProjectProposal(directory(), remote, 'org')).toEqual(
      generateProjectProposal(directory(), remote, 'org'),
    );
  });

  it('separates organizations and repositories', () => {
    const root = directory();
    const key = (remote: string, org?: string) =>
      generateProjectProposal(root, remote, org).projectKey;

    expect(key('https://github.com/a/repo.git', 'one')).not.toBe(
      key('https://github.com/a/repo.git', 'two'),
    );
    expect(key('https://github.com/a/repo.git')).not.toBe(key('https://github.com/b/repo.git'));
  });

  it('falls back to the directory name without a remote, and has no prefix without an organization', () => {
    const root = directory();

    const proposal = generateProjectProposal(root, undefined, undefined);

    expect(proposal.projectName).toBe(basename(root));
    expect(proposal.projectKey).toMatch(/^init-key-.+-[0-9a-f]{12}$/);
  });
});
