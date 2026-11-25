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
  parseProjectFinding,
  type ProjectFinding,
} from '@/commands/architecture/_common/findings.ts';

const assertion: ProjectFinding = {
  type: 'assertionDeviation',
  category: 'deviation',
  language: 'java',
  details: {
    assertionName: 'web-not-db',
    fromNodeKey: 'app:web',
    toNodeKey: 'app:db',
    dependencyCount: 1,
  },
  files: ['Web.java'],
};

describe('assertion deviation findings', () => {
  it('reads the assertion name, dependency and count', () => {
    expect(parseProjectFinding(assertion)).toEqual(assertion);
  });

  it.each([
    { assertionName: undefined },
    { assertionName: 7 },
    { fromNodeKey: undefined },
    { toNodeKey: null },
    { dependencyCount: undefined },
    { dependencyCount: null },
    { dependencyCount: 0 },
    { dependencyCount: -1 },
    { dependencyCount: 1.5 },
    { dependencyCount: '2' },
    { dependencyCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid details %j', (change) => {
    expect(() =>
      parseProjectFinding({ ...assertion, details: { ...assertion.details, ...change } }),
    ).toThrow('Invalid public finding response');
  });

  it('rejects an assertion deviation outside the deviation category', () => {
    expect(() => parseProjectFinding({ ...assertion, category: 'flaw' })).toThrow(
      'Invalid public finding response: invalid category for type',
    );
  });
});
