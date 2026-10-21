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

import type { IntendedArchitecture } from '@/commands/architecture/_common/architecture-api.ts';
import { viewIntended } from '@/commands/architecture/_common/intended-model.ts';
import { formatIntendedText } from '@/commands/architecture/intended/get/intended-text.ts';
import { stripAnsi } from '@/core/ui/colors.ts';

const MODEL: IntendedArchitecture = {
  type: 'namespace',
  language: 'java',
  groups: [
    {
      label: 'Domain',
      patterns: ['core:com.example.domain.**'],
      interface: true,
      groups: [{ label: 'Billing', patterns: ['core:com.example.domain.billing.**'] }],
    },
    { label: 'Web', patterns: ['app:**'] },
  ],
  constraints: [{ from: 'Web', to: 'Domain' }],
};

function format(component: string | undefined, depth: number): string {
  const view = viewIntended(MODEL, component, depth);
  return stripAnsi(formatIntendedText('p', 'abc', [MODEL], view ? [view] : []));
}

describe('formatIntendedText', () => {
  it('prints the groups tree with patterns and flags, the allowed dependencies and the revision', () => {
    expect(format(undefined, Number.POSITIVE_INFINITY)).toBe(
      [
        'p: intended architecture',
        'java (namespace): 3 group(s), 1 constraint(s)',
        '  Domain [core:com.example.domain.**] (interface)',
        '    Billing [core:com.example.domain.billing.**]',
        '  Web [app:**]',
        '  allowed:',
        '    Web -> Domain',
        'revision abc',
      ].join('\n'),
    );
  });

  it('counts both qualifiers of the same language against their own full model', () => {
    const file: IntendedArchitecture = {
      ...MODEL,
      type: 'file',
      groups: [{ label: 'Files', patterns: ['src/**'] }],
      constraints: [],
    };
    const models = [file, MODEL];
    const views = models.flatMap(
      (model) => viewIntended(model, undefined, Number.POSITIVE_INFINITY) ?? [],
    );
    const text = stripAnsi(formatIntendedText('p', 'abc', models, views));
    expect(text).toContain('java (file): 1 group(s), 0 constraint(s)');
    expect(text).toContain('java (namespace): 3 group(s), 1 constraint(s)');
    expect(text).toContain('Files [src/**]');
    expect(text).toContain('Billing [core:com.example.domain.billing.**]');
  });

  it('shows a partial view relative to its root and counts the hidden subgroups', () => {
    expect(format(undefined, 1).split('\n')[2]).toBe(
      '  Domain [core:com.example.domain.**] (interface) (+1 subgroup(s), raise --depth)',
    );
    expect(format('Domain', 1).split('\n').slice(1, 5)).toEqual([
      'java (namespace): 3 group(s), 1 constraint(s), showing below Domain',
      '  Billing [core:com.example.domain.billing.**]',
      '  allowed:',
      '    Web -> Domain',
    ]);
  });
});
