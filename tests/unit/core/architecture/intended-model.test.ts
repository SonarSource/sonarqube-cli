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

// Pure model logic: validation rules, diff and revision.

import { describe, expect, it } from 'bun:test';

import type { IntendedArchitecture } from '@/core/architecture/architecture-api.ts';
import { diffIntended } from '@/core/architecture/intended-diff.ts';
import { revisionOf } from '@/core/architecture/intended-model.ts';
import { parseIntendedFile } from '@/core/architecture/intended-validation.ts';

const MODEL: IntendedArchitecture = {
  type: 'file',
  language: 'ts',
  groups: [
    {
      label: 'src',
      patterns: ['src/**'],
      groups: [
        { label: 'api', patterns: ['src/api/**'], interface: true },
        { label: 'ui', patterns: ['src/ui/**'] },
      ],
    },
  ],
  constraints: [{ from: 'src/ui', to: 'src/api' }],
};

function problemsOf(raw: unknown): string {
  try {
    parseIntendedFile(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the file to be refused');
}

describe('parseIntendedFile', () => {
  it('accepts the get intended output and a bare array with explicit type', () => {
    expect(parseIntendedFile({ revision: 'r', models: [MODEL] })).toEqual({
      revision: 'r',
      models: [MODEL],
    });
    const { type: _type, ...untyped } = MODEL;
    expect(problemsOf([untyped])).toContain('type must be');
    expect(parseIntendedFile([MODEL]).models).toEqual([MODEL]);
  });

  it('reports every problem at once', () => {
    const message = problemsOf({
      models: [
        {
          type: 'file',
          language: 'ts',
          groups: [
            { label: 'a', patterns: [12] },
            { label: 'b', patterns: ['src**'] },
            { label: 'c', patterns: ['src/c/**'] },
            { label: 'd', patterns: ['src/c/**'] },
            { label: 'c', patterns: ['src/other/**'] },
          ],
          constraints: [
            { from: 'a', to: 'missing' },
            { from: 'a', to: 'b' },
            { from: 'a', to: 'b' },
          ],
        },
        { type: 'file', language: 'ts', groups: [], constraints: [] },
        { language: 'go' },
      ],
    });
    expect(message).toContain('nothing was changed');
    expect(message).toContain('patterns": an array of strings');
    expect(message).toContain('Group "c" (ts) is defined twice');
    expect(message).toContain('constraint a -> b is defined twice');
    expect(message).toContain('More than one model for perspective ts:file');
    expect(message).toContain('models[2].language must be one of');
  });

  it('accepts a glob as a constraint end', () => {
    const glob = { ...MODEL, constraints: [{ from: 'src/*', to: 'src/api' }] };
    expect(parseIntendedFile([glob]).models[0].constraints).toEqual(glob.constraints);
  });

  it('accepts public-schema patterns without renderer semantics', () => {
    const model = {
      ...MODEL,
      groups: [
        { label: 'Empty', patterns: [] },
        { label: 'Omitted' },
        { label: 'A', patterns: ['src**'] },
        { label: 'B', patterns: ['src**'] },
      ],
      constraints: [{ from: 'arbitrary pattern', to: 'anything**' }],
    };
    expect(parseIntendedFile([model]).models[0].constraints).toEqual(model.constraints);
    expect(parseIntendedFile([model]).models[0].groups[1].patterns).toEqual([]);
  });

  it('never drops an invalid supplied revision into an unchecked write', () => {
    for (const revision of [null, 3, {}, [], '', '  ']) {
      expect(problemsOf({ models: [MODEL], revision })).toContain(
        '"revision" must be a nonblank string',
      );
    }
    expect(parseIntendedFile({ models: [MODEL] }).revision).toBeUndefined();
  });

  it('refuses a partial view', () => {
    expect(problemsOf({ partial: true, models: [] })).toContain('partial view');
  });

  it('keeps the language of a file read with --language, and refuses other languages in it', () => {
    expect(parseIntendedFile({ language: 'ts', models: [MODEL] }).language).toBe('ts');
    expect(problemsOf({ language: 'java', models: [MODEL] })).toContain(
      'The file holds only the java model (get intended --language java), but models[0] is ts.',
    );
    expect(problemsOf({ language: 'go', models: [] })).toContain('"language" must be one of');
  });
});

describe('diffIntended', () => {
  it('lists removed, added and changed groups, patterns and constraints', () => {
    const next: IntendedArchitecture = {
      ...MODEL,
      groups: [
        {
          label: 'src',
          patterns: ['src/**', 'lib/**'],
          groups: [{ label: 'api', patterns: ['src/api/**'] }],
        },
      ],
      constraints: [],
    };
    expect(diffIntended([MODEL], [next])).toEqual({
      removed: ['group ts src/ui', 'constraint ts src/ui -> src/api'],
      added: ['pattern ts src lib/**'],
      changed: ['group ts src/api: interface true -> false'],
    });
    expect(diffIntended([], [MODEL]).added).toContain('model ts');
  });
});

describe('revisionOf', () => {
  it('matches the MCP same-language qualifier revision fixture', () => {
    const file: IntendedArchitecture = {
      language: 'java',
      type: 'file',
      groups: [],
      constraints: [],
    };
    const namespace: IntendedArchitecture = { ...file, type: 'namespace' };
    expect(revisionOf([namespace, file])).toBe(
      'c4674bae74ea8f6687b40418c8b3ffc770e3ad1bed780b71084eb44f274d1543',
    );
  });

  it('sorts same-language perspectives by type and accepts both qualifiers', () => {
    const namespace: IntendedArchitecture = { ...MODEL, type: 'namespace' };
    const file = parseIntendedFile({ models: [namespace, MODEL] });
    expect(file.models).toHaveLength(2);
    expect(revisionOf([namespace, MODEL])).toBe(revisionOf([MODEL, namespace]));
  });

  it('ignores pattern and constraint order, not group order', () => {
    const reordered: IntendedArchitecture = {
      ...MODEL,
      groups: [{ ...MODEL.groups[0], patterns: ['src/**'] }],
      constraints: [...MODEL.constraints].reverse(),
    };
    expect(revisionOf([reordered])).toBe(revisionOf([MODEL]));
    const swapped: IntendedArchitecture = {
      ...MODEL,
      groups: [{ ...MODEL.groups[0], groups: [...(MODEL.groups[0].groups ?? [])].reverse() }],
    };
    expect(revisionOf([swapped])).not.toBe(revisionOf([MODEL]));
  });

  it('is the value the SonarQube MCP server computes for the same models', () => {
    // Same models and hash as IntendedRevisionTest in sonarqube-mcp-server: keep both in sync.
    const java: IntendedArchitecture = {
      type: 'namespace',
      language: 'java',
      groups: [
        {
          label: 'Core "é" <x>',
          patterns: ['core:b.**', 'core:B.**', 'core:a.**'],
          interfaceAccess: true,
          groups: [{ label: 'Api', patterns: ['core:a.api.**'], interface: true }],
        },
        { label: 'Web', patterns: ['web:**'] },
      ],
      constraints: [
        { from: 'Web', to: 'Core "é" <x>/Api' },
        { from: 'Web', to: 'Core "é" <x>' },
      ],
    };
    expect(revisionOf([MODEL, java])).toBe(
      '3152b86662ac658fb72940b33750e23eba7dd2c7c83491c57474485e512515eb',
    );
  });
});

describe('partial export remediation', () => {
  it('offers a complete export rather than irrelevant schema rules', () => {
    try {
      parseIntendedFile({ partial: true, models: [] });
      throw new Error('Expected rejection');
    } catch (error) {
      const rejection = error as Error & { remediationHint?: string };
      expect(rejection.message).toContain('partial view');
      expect(rejection.remediationHint).toContain('sonar architecture get intended --format json');
      expect(rejection.remediationHint).not.toContain('Each model requires');
    }
  });
});
