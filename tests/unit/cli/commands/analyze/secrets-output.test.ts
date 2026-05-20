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

import { parseSecretsOutput } from '../../../../../src/cli/commands/analyze/secrets-output.js';

describe('parseSecretsOutput', () => {
  it('returns empty array for empty string', () => {
    expect(parseSecretsOutput('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseSecretsOutput('   \n  \n  ')).toEqual([]);
  });

  it('parses a single issue with all fields', () => {
    const stdout = [
      'Hard-coded credential detected',
      'File: src/config.ts',
      'Location: [3:14-3:48]',
      'Secret: s3cr3t_value',
    ].join('\n');

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Hard-coded credential detected');
    expect(issues[0].file).toBe('src/config.ts');
    expect(issues[0].location).toEqual({
      startLine: 3,
      startOffset: 14,
      endLine: 3,
      endOffset: 48,
    });
    expect(issues[0].secret).toBe('s3cr3t_value');
  });

  it('parses an issue with message and file only (no location, no secret)', () => {
    const stdout = ['Hard-coded credential detected', 'File: src/config.ts'].join('\n');

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Hard-coded credential detected');
    expect(issues[0].file).toBe('src/config.ts');
    expect(issues[0].location).toBeNull();
    expect(issues[0].secret).toBeNull();
  });

  it('parses multiple issues separated by blank lines', () => {
    const stdout = [
      'First secret found',
      'File: a.ts',
      'Location: [1:0-1:10]',
      'Secret: abc',
      '',
      'Second secret found',
      'File: b.ts',
      'Location: [5:2-5:12]',
      'Secret: xyz',
    ].join('\n');

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(2);
    expect(issues[0].file).toBe('a.ts');
    expect(issues[1].file).toBe('b.ts');
  });

  it('normalizes Windows line endings (CRLF)', () => {
    const stdout = [
      'Hard-coded credential detected',
      'File: src/config.ts',
      'Location: [3:14-3:48]',
      'Secret: s3cr3t_value',
    ]
      .join('\r\n')
      .concat('\r\n\r\n');

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Hard-coded credential detected');
    expect(issues[0].file).toBe('src/config.ts');
    expect(issues[0].location?.startLine).toBe(3);
  });

  it('skips blocks with fewer than 2 lines', () => {
    const stdout = 'OnlyOneLine\n\nValid message\nFile: good.ts';

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('good.ts');
  });

  it('skips blocks with empty message', () => {
    const stdout = '\nFile: config.ts\n\nReal message\nFile: real.ts';

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('real.ts');
  });

  it('skips blocks with empty file', () => {
    const stdout = 'Message without file\nFile:\n\nValid message\nFile: valid.ts';

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe('valid.ts');
  });

  it('handles location with malformed pattern gracefully', () => {
    const stdout = [
      'Found a secret',
      'File: config.ts',
      'Location: [bad-format]',
      'Secret: value',
    ].join('\n');

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].location).toBeNull();
    expect(issues[0].secret).toBe('value');
  });

  it('ignores leading and trailing blank lines around output', () => {
    const stdout = '\n\nHard-coded credential\nFile: src/app.ts\n\n';

    const issues = parseSecretsOutput(stdout);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Hard-coded credential');
    expect(issues[0].file).toBe('src/app.ts');
  });
});
