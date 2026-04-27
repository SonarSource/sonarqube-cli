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

import { parseAnalysisProperties } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/analysis-properties.ts';

describe('parseAnalysisProperties', () => {
  it('extracts the three categories and ignores fieldValues / inherited / unrelated keys', () => {
    const result = parseAnalysisProperties([
      { key: 'sonar.test.jira', value: 'abc', inherited: true },
      { key: 'sonar.exclusions', values: ['**/test/**', '**/dist/**'], inherited: false },
      { key: 'sonar.sca.foo', value: 'bar', inherited: true },
      { key: 'sonar.sca.list', values: ['a', 'b'], inherited: false },
      { key: 'sonar.scm.exclusions.disabled', value: 'true', inherited: false },
      {
        key: 'sonar.demo',
        fieldValues: [{ boolean: 'true', text: 'foo' }],
        inherited: false,
      },
    ]);

    expect(result).toEqual({
      scaProperties: { 'sonar.sca.foo': 'bar', 'sonar.sca.list': 'a,b' },
      exclusions: ['**/test/**', '**/dist/**'],
      includeGitIgnoredPaths: true,
    });
  });

  it('returns defaults when settings is empty', () => {
    expect(parseAnalysisProperties([])).toEqual({
      scaProperties: {},
      exclusions: [],
      includeGitIgnoredPaths: false,
    });
  });

  it('merges sonar.exclusions, sonar.global.exclusions, and sonar.test.exclusions', () => {
    const result = parseAnalysisProperties([
      { key: 'sonar.global.exclusions', values: ['**/vendor/**'] },
      { key: 'sonar.exclusions', values: ['**/dist/**'] },
      { key: 'sonar.test.exclusions', values: ['**/__tests__/**'] },
    ]);

    expect(result.exclusions).toEqual(['**/vendor/**', '**/dist/**', '**/__tests__/**']);
  });

  it('parses sonar.exclusions from either values[] or comma-joined value', () => {
    const fromValues = parseAnalysisProperties([{ key: 'sonar.exclusions', values: ['a', 'b'] }]);
    const fromValue = parseAnalysisProperties([{ key: 'sonar.exclusions', value: ' a , b ' }]);

    expect(fromValues.exclusions).toEqual(['a', 'b']);
    expect(fromValue.exclusions).toEqual(['a', 'b']);
  });

  it('treats sonar.scm.exclusions.disabled as boolean toggle on string "true"', () => {
    expect(
      parseAnalysisProperties([{ key: 'sonar.scm.exclusions.disabled', value: 'true' }])
        .includeGitIgnoredPaths,
    ).toBe(true);
    expect(
      parseAnalysisProperties([{ key: 'sonar.scm.exclusions.disabled', value: 'false' }])
        .includeGitIgnoredPaths,
    ).toBe(false);
    expect(parseAnalysisProperties([]).includeGitIgnoredPaths).toBe(false);
  });
});
