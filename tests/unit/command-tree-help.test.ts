/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import { getBanner, getCustomRootHelp } from '../../src/cli/root-help';

// Strip ANSI escape codes to get the visible character width of a string
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

describe('getBanner', () => {
  it.each([
    ['1.0.0'], // short
    ['0.8.0'], // current
    ['0.10.0'], // minor double-digit
    ['1.10.0'],
    ['10.0.0'], // major double-digit
    ['10.10.10'], // all double-digit
  ])('all three lines have equal visible width for version %s', (version) => {
    const lines = getBanner(version).split('\n');
    const [top, middle, bottom] = lines.map(visibleLength);
    expect(top).toBe(middle);
    expect(top).toBe(bottom);
  });
});

describe('getCustomRootHelp', () => {
  it('includes the box banner with version', () => {
    const help = getCustomRootHelp();
    expect(help).toContain('┌');
    expect(help).toContain('SonarQube CLI');
    expect(help).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('contains all required sections and content', () => {
    const help = getCustomRootHelp();
    expect(help).toContain('QUICKSTART');
    expect(help).toContain('sonar auth login');
    expect(help).toContain('sonar verify --file <file>');
    expect(help).toContain('COMMANDS');
    expect(help).toContain('verify --file <file>');
    expect(help).toContain('analyze <secrets|sqaa>');
    expect(help).toContain('auth');
    expect(help).toContain('integrate <claude|git>');
    expect(help).toContain('self-update');
    expect(help).toContain('OPTIONS');
    expect(help).toContain('-h, --help');
    expect(help).toContain('-v, --version');
    expect(help).toContain('https://docs.sonarsource.com/sonarqube-cli');
    expect(help).not.toContain('Usage: sonar [options] [command]');
  });
});
