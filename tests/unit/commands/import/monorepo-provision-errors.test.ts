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

import { describe, expect, it } from 'bun:test';

import {
  accountsForEveryProject,
  parseMonorepoProvisionErrors,
} from '@/commands/import/monorepo-provision-errors.ts';

const KEYS = ['a', 'b'];

describe('parseMonorepoProvisionErrors', () => {
  it('is null without the summary line, which marks a rejected request', () => {
    expect(
      parseMonorepoProvisionErrors(KEYS, ["The 'organization' parameter is missing"]),
    ).toBeNull();
    expect(parseMonorepoProvisionErrors(KEYS, [])).toBeNull();
  });

  it('reads the counts and strips the key prefix from each refusal', () => {
    const parsed = parseMonorepoProvisionErrors(KEYS, [
      'Could not provision some of the projects (1/2)',
      'a: Project key already exists',
    ]);

    expect(parsed).toEqual({
      created: 1,
      requested: 2,
      refusals: new Map([['a', 'Project key already exists']]),
      untagged: [],
    });
  });

  it('keeps a line that names no requested project, and a second line for the same project', () => {
    const parsed = parseMonorepoProvisionErrors(KEYS, [
      'Could not provision some of the projects (0/2)',
      'a: first',
      'a: second',
      'something else',
    ]);

    expect(parsed?.refusals).toEqual(new Map([['a', 'first']]));
    expect(parsed?.untagged).toEqual(['a: second', 'something else']);
  });
});

describe('accountsForEveryProject', () => {
  it('holds when the refusals are exactly the projects that were not created', () => {
    const parsed = parseMonorepoProvisionErrors(KEYS, [
      'Could not provision some of the projects (1/2)',
      'a: nope',
    ]);

    expect(accountsForEveryProject(parsed!, KEYS)).toBe(true);
  });

  it.each([
    ['a refusal is missing', ['Could not provision some of the projects (1/2)']],
    ['a line is untagged', ['Could not provision some of the projects (1/2)', 'a: nope', 'stray']],
    [
      'the server counted another number of projects',
      ['Could not provision some of the projects (1/3)', 'a: nope'],
    ],
  ])('does not hold when %s', (_name, errors) => {
    expect(accountsForEveryProject(parseMonorepoProvisionErrors(KEYS, errors)!, KEYS)).toBe(false);
  });
});
