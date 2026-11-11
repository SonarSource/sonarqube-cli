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

import { afterEach, describe, expect, it } from 'bun:test';

import {
  collectProjectKeyOption,
  resolveMonorepoImport,
} from '@/commands/import/monorepo-projects.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';

const dirs: string[] = [];

function projectsFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'monorepo-projects-'));
  dirs.push(dir);
  const path = join(dir, 'projects.json');
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function failure(options: Parameters<typeof resolveMonorepoImport>[0]): InvalidOptionError {
  try {
    resolveMonorepoImport(options);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidOptionError);
    return error as InvalidOptionError;
  }
  throw new Error('expected resolveMonorepoImport to throw');
}

describe('collectProjectKeyOption', () => {
  it('splits comma-separated keys', () => {
    expect(collectProjectKeyOption('frontend,backend', [])).toEqual(['frontend', 'backend']);
  });

  it('splits comma-separated key=name pairs', () => {
    expect(collectProjectKeyOption('frontend=Name 1,backend=Name 2', [])).toEqual([
      'frontend=Name 1',
      'backend=Name 2',
    ]);
  });

  it('accumulates across repeated flags', () => {
    const once = collectProjectKeyOption('org_api,org_web=Web', []);
    expect(collectProjectKeyOption('org_cli', once)).toEqual(['org_api', 'org_web=Web', 'org_cli']);
  });

  it('trims entries and drops empty ones', () => {
    expect(collectProjectKeyOption(' a , ,b,', ['c'])).toEqual(['c', 'a', 'b']);
  });

  it('ignores blank input', () => {
    expect(collectProjectKeyOption('   ', ['org_api'])).toEqual(['org_api']);
  });

  it('keeps duplicates so validation can report them', () => {
    expect(collectProjectKeyOption('a=One,a=Two', [])).toEqual(['a=One', 'a=Two']);
  });
});

describe('resolveMonorepoImport', () => {
  const base = { monorepo: 'owner/repo' };

  it('is a no-op without --monorepo', () => {
    expect(resolveMonorepoImport({ repo: ['owner/repo'] })).toBeUndefined();
  });

  it('rejects project flags without --monorepo', () => {
    expect(failure({ project: ['org_api'] }).message).toContain('require --monorepo');
    expect(failure({ projectsFile: 'projects.json' }).message).toContain('require --monorepo');
  });

  it('rejects --repo, --all and --regex', () => {
    const project = ['org_api'];
    expect(failure({ ...base, repo: ['a/b'], project }).message).toContain('--repo');
    expect(failure({ ...base, all: true, project }).message).toContain('--all');
    expect(failure({ ...base, regex: '^a', project }).message).toContain('--regex');
  });

  it('takes exactly one repository slug', () => {
    expect(failure({ monorepo: '  ', project: ['org_api'] }).message).toContain('exactly one');
    expect(failure({ monorepo: 'a/b,c/d', project: ['org_api'] }).message).toContain('exactly one');
  });

  it('requires at least one project', () => {
    expect(failure(base).message).toContain('at least one project');
  });

  it('defaults the name to the key and honours key=name', () => {
    expect(resolveMonorepoImport({ ...base, project: ['org_api', 'org_web=Web UI'] })).toEqual({
      repo: 'owner/repo',
      projects: [
        { projectKey: 'org_api', projectName: 'org_api' },
        { projectKey: 'org_web', projectName: 'Web UI' },
      ],
    });
  });

  it('reads the UI JSON format and combines it with flags', () => {
    const path = projectsFile(
      JSON.stringify([{ projectKey: 'org_api', projectName: 'API' }, { projectKey: 'org_web' }]),
    );
    expect(resolveMonorepoImport({ ...base, projectsFile: path, project: ['org_cli'] })).toEqual({
      repo: 'owner/repo',
      projects: [
        { projectKey: 'org_cli', projectName: 'org_cli' },
        { projectKey: 'org_api', projectName: 'API' },
        { projectKey: 'org_web', projectName: 'org_web' },
      ],
    });
  });

  it('rejects an unreadable, malformed or mis-shaped file', () => {
    expect(failure({ ...base, projectsFile: '/does/not/exist.json' }).message).toContain(
      'Could not read',
    );
    expect(failure({ ...base, projectsFile: projectsFile('not json') }).message).toContain(
      'Could not read',
    );
    expect(failure({ ...base, projectsFile: projectsFile('{}') }).message).toContain('JSON array');
    expect(
      failure({ ...base, projectsFile: projectsFile('[{"projectName":"x"}]') }).message,
    ).toContain('no "projectKey"');
    expect(
      failure({ ...base, projectsFile: projectsFile('[{"projectKey":"a_b","projectName":3}]') })
        .message,
    ).toContain('must be a string');
  });

  it('rejects invalid and duplicate keys', () => {
    expect(failure({ ...base, project: ['bad key'] }).message).toContain('not a valid');
    expect(failure({ ...base, project: ['12345'] }).message).toContain('not a valid');
    expect(failure({ ...base, project: ['org_api', 'org_api=Again'] }).message).toContain(
      'more than once',
    );
  });

  it('rejects a display name over 255 characters', () => {
    expect(failure({ ...base, project: [`org_api=${'n'.repeat(256)}`] }).message).toContain('255');
  });
});
