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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { validateOnboardCiGitlabOptions } from '@/commands/admin/onboard-ci/gitlab/index.ts';
import {
  filterReposByEntries,
  parseReposOption,
  resolveSelectedRepoEntries,
} from '@/commands/admin/onboard-ci/gitlab/repos-filter.ts';
import type { OnboardCiGitlabOptions } from '@/commands/admin/onboard-ci/gitlab/types.ts';
import { TriggerOn } from '@/commands/admin/onboard-ci/gitlab/types.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { GitLabRepo } from '@/core/gitlab/client.ts';

import { FakeConsole } from '../../../../../_common/fake-console.ts';

function options(overrides: Partial<OnboardCiGitlabOptions> = {}): OnboardCiGitlabOptions {
  return {
    group: 'acme',
    sonarTokenVarName: 'SONAR_TOKEN',
    triggerOn: TriggerOn.Both,
    allowFailure: false,
    dryRun: false,
    scannerProperty: [],
    ...overrides,
  };
}

function repo(path: string, overrides: Partial<GitLabRepo> = {}): GitLabRepo {
  return {
    id: 1,
    name: path.split('/').at(-1) ?? path,
    path_with_namespace: path,
    default_branch: 'main',
    marked_for_deletion_at: null,
    ...overrides,
  };
}

describe('parseReposOption', () => {
  it('splits on commas and trims each entry', () => {
    expect(parseReposOption('team-a/svc1, svc2 ,team-b/svc3')).toEqual([
      'team-a/svc1',
      'svc2',
      'team-b/svc3',
    ]);
  });

  it('accepts a single entry', () => {
    expect(parseReposOption('svc1')).toEqual(['svc1']);
  });

  it.each(['', ' ', 'a,,b', 'a,', ',a', 'a, ,b'])('rejects empty entries in %j', (value) => {
    expect(() => parseReposOption(value)).toThrow(InvalidOptionError);
  });
});

describe('validateOnboardCiGitlabOptions --repos', () => {
  it('accepts --repos', () => {
    expect(() => validateOnboardCiGitlabOptions(options({ repos: 'a,b' }))).not.toThrow();
  });

  it('rejects empty --repos entries with an InvalidOptionError', () => {
    expect(() => validateOnboardCiGitlabOptions(options({ repos: 'a,,b' }))).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects --repos together with --repos-file', () => {
    const invalid = options({ repos: 'a', reposFile: 'repos.txt' });
    expect(() => validateOnboardCiGitlabOptions(invalid)).toThrow(InvalidOptionError);
    expect(() => validateOnboardCiGitlabOptions(invalid)).toThrow('mutually exclusive');
  });

  it('rejects --client-side together with --server-side', () => {
    const invalid = options({ clientSide: true, serverSide: true });
    expect(() => validateOnboardCiGitlabOptions(invalid)).toThrow(InvalidOptionError);
  });
});

describe('resolveSelectedRepoEntries', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onboard-ci-repos-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when no selection is given', () => {
    expect(resolveSelectedRepoEntries(options())).toBeUndefined();
  });

  it('resolves --repos', () => {
    expect(resolveSelectedRepoEntries(options({ repos: 'a, b' }))).toEqual({
      entries: new Set(['a', 'b']),
      source: '--repos',
    });
  });

  it('resolves --repos-file, ignoring blanks and comments', () => {
    const reposFile = join(dir, 'repos.txt');
    writeFileSync(reposFile, '# header\na\n\n  b  \n');
    expect(resolveSelectedRepoEntries(options({ reposFile }))).toEqual({
      entries: new Set(['a', 'b']),
      source: '--repos-file',
    });
  });
});

describe('filterReposByEntries', () => {
  const eligible = [repo('acme/svc1'), repo('acme/team/svc2'), repo('acme/svc3')];
  const all = [...eligible, repo('acme/empty', { default_branch: null })];

  it('keeps only the listed repositories, relative to the group', () => {
    const console = new FakeConsole();

    const kept = filterReposByEntries(
      all,
      eligible,
      new Set(['svc1', 'team/svc2']),
      '--repos',
      'acme',
      console,
    );

    expect(kept.map((r) => r.path_with_namespace)).toEqual(['acme/svc1', 'acme/team/svc2']);
    expect(console.findCall('warn', '')).toBeUndefined();
  });

  it('warns about entries that are missing or not eligible, naming the flag used', () => {
    const console = new FakeConsole();

    const entries = new Set(['svc1', 'ghost', 'empty']);
    filterReposByEntries(all, eligible, entries, '--repos', 'acme', console);

    expect(console.findCall('warn', "'ghost' from --repos not found in group")).toBeDefined();
    expect(console.findCall('warn', "'empty' from --repos is not eligible")).toBeDefined();
  });

  it('keeps the --repos-file wording for file entries', () => {
    const console = new FakeConsole();

    filterReposByEntries(all, eligible, new Set(['ghost']), '--repos-file', 'acme', console);

    expect(
      console.findCall('warn', "→ 'ghost' from --repos-file not found in group, skipped"),
    ).toBeDefined();
  });
});
