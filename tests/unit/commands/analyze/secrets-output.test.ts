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

import { parseSecretsJson } from '../../../../src/commands/analyze/secrets.ts';

describe('parseSecretsJson', () => {
  it('returns empty issues for empty string', () => {
    expect(parseSecretsJson('')).toEqual({ issues: [] });
  });

  it('returns empty issues for non-JSON string', () => {
    expect(parseSecretsJson('not json')).toEqual({ issues: [] });
  });

  it('returns empty issues when issues field is absent', () => {
    expect(parseSecretsJson(JSON.stringify({}))).toEqual({ issues: [] });
  });

  it('parses a single issue with all fields', () => {
    const stdout = JSON.stringify({
      issues: [
        {
          ruleKey: 'secrets:S6290',
          description: 'AWS Access Key detected',
          file: 'src/config.ts',
          location: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 48 },
          maskedSecret: 'AKIA****',
        },
      ],
    });

    const { issues } = parseSecretsJson(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleKey).toBe('secrets:S6290');
    expect(issues[0].description).toBe('AWS Access Key detected');
    expect(issues[0].file).toBe('src/config.ts');
    expect(issues[0].location).toEqual({
      startLine: 3,
      startColumn: 14,
      endLine: 3,
      endColumn: 48,
    });
    expect(issues[0].maskedSecret).toBe('AKIA****');
  });

  it('parses an issue without optional fields', () => {
    const stdout = JSON.stringify({
      issues: [{ ruleKey: 'secrets:S6290', description: 'Credential', file: 'a.ts' }],
    });

    const { issues } = parseSecretsJson(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].location).toBeUndefined();
    expect(issues[0].maskedSecret).toBeUndefined();
  });

  it('parses multiple issues', () => {
    const stdout = JSON.stringify({
      issues: [
        { ruleKey: 'secrets:S1', description: 'First', file: 'a.ts' },
        { ruleKey: 'secrets:S2', description: 'Second', file: 'b.ts' },
      ],
    });

    const { issues } = parseSecretsJson(stdout);

    expect(issues).toHaveLength(2);
    expect(issues[0].file).toBe('a.ts');
    expect(issues[1].file).toBe('b.ts');
  });

  it('returns errors field when present', () => {
    const stdout = JSON.stringify({ issues: [], errors: ['scan failed'] });
    const result = parseSecretsJson(stdout);
    expect(result.errors).toEqual(['scan failed']);
  });

  it('returns empty issues for JSON without issues field', () => {
    expect(parseSecretsJson(JSON.stringify({ errors: ['something went wrong'] }))).toMatchObject({
      issues: [],
    });
  });
});
