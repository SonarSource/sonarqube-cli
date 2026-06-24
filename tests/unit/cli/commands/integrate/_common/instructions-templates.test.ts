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
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
  withSonarMarkers,
} from '../../../../../../src/cli/commands/integrate/_common/instructions-templates';

describe('instructions-templates', () => {
  it('withSonarMarkers wraps the body in begin/end markers, trims trailing whitespace, and ends with a newline', () => {
    const result = withSonarMarkers('my-id', 'body line\n\n  ');

    expect(result).toBe(`${sonarBeginMarker('my-id')}\nbody line\n${sonarEndMarker('my-id')}\n`);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('buildSqaaSectionBody renders the SQAA protocol body with the analyze command for the project', () => {
    const result = buildSqaaSectionBody('my-project');

    expect(result).toContain('# SonarQube Agentic Analysis protocol');
    expect(result).toContain('sonar analyze agentic --project my-project');
    expect(result).toContain('**Preferred:**');
    expect(result).toContain('--file');
    expect(result).toContain('relative to the project root');
    expect(result).toContain('**Fallback:**');
    expect(result).toContain('Per-edit hooks run faster STANDARD analysis');
    // Explicit file list appears before change-set fallback in the template
    expect(result.indexOf('--file <path/to/file1>')).toBeLessThan(result.indexOf('**Fallback:**'));
  });
});
