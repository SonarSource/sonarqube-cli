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

import { CommandFailedError } from '@/core/command-error.ts';

import {
  partitionSqaaAnalysisFiles,
  validateSqaaAnalysisFiles,
} from '../../../../src/commands/analyze/sqaa-validation.ts';

describe('validateSqaaAnalysisFiles', () => {
  it('rejects empty files[]', () => {
    expect(() => validateSqaaAnalysisFiles([])).toThrow(CommandFailedError);
    expect(() => validateSqaaAnalysisFiles([])).toThrow(/at least one file/);
  });

  it('rejects absolute paths', () => {
    expect(() => validateSqaaAnalysisFiles([{ path: '/src/index.ts', content: 'x' }])).toThrow(
      /project-relative/,
    );
  });

  it('rejects parent-directory segments', () => {
    expect(() =>
      validateSqaaAnalysisFiles([{ path: 'src/../../etc/passwd', content: 'x' }]),
    ).toThrow(/\.\./);
  });

  it('rejects backslash paths', () => {
    expect(() => validateSqaaAnalysisFiles([{ path: 'src\\a.ts', content: 'x' }])).toThrow(
      /forward slashes/,
    );
  });

  it("rejects '.' segments", () => {
    expect(() => validateSqaaAnalysisFiles([{ path: 'src/./a.ts', content: 'x' }])).toThrow(
      /'\.' segments/,
    );
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      validateSqaaAnalysisFiles([
        { path: 'src/a.ts', content: 'a' },
        { path: 'src/a.ts', content: 'b' },
      ]),
    ).toThrow(/Duplicate file path/);
  });

  it('rejects invalid scope', () => {
    expect(() =>
      validateSqaaAnalysisFiles([{ path: 'src/a.ts', content: 'a', scope: 'INVALID' as 'MAIN' }]),
    ).toThrow(/Invalid scope/);
  });

  it('rejects invalid analysisDepth option', () => {
    expect(() =>
      validateSqaaAnalysisFiles([{ path: 'src/a.ts', content: 'a' }], {
        analysisDepth: 'QUICK' as 'DEEP',
      }),
    ).toThrow(/Invalid analysisDepth/);
  });

  it('accepts valid files', () => {
    expect(() =>
      validateSqaaAnalysisFiles(
        [
          { path: 'src/main.ts', content: 'a', scope: 'MAIN' },
          { path: 'src/main.test.ts', content: 'b', scope: 'TEST' },
        ],
        { analysisDepth: 'DEEP' },
      ),
    ).not.toThrow();
  });
});

describe('partitionSqaaAnalysisFiles', () => {
  it('keeps valid files and rejects invalid ones in the same batch', () => {
    const result = partitionSqaaAnalysisFiles([
      { path: 'src/ok.ts', content: 'ok' },
      { path: 'src\\bad.ts', content: 'bad' },
      { path: 'src/also-ok.ts', content: 'ok' },
    ]);

    expect(result.valid.map((file) => file.path)).toEqual(['src/ok.ts', 'src/also-ok.ts']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.file.path).toBe('src\\bad.ts');
    expect(result.rejected[0]?.error.message).toMatch(/forward slashes/);
  });

  it('rejects duplicate paths after the first occurrence', () => {
    const result = partitionSqaaAnalysisFiles([
      { path: 'src/a.ts', content: 'first' },
      { path: 'src/a.ts', content: 'second' },
    ]);

    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.error.message).toMatch(/Duplicate file path/);
  });
});
