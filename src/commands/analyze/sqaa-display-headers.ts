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

// Section headers for a text report grouped by project.

import { bold, yellow } from '@/core/ui/colors.ts';

/** Colored like the run summary footer: yellow number, bold label. */
function formatCount(count: number, noun: string, colored: boolean): string {
  const word = count === 1 ? noun : noun + 's';
  return colored ? `${yellow(String(count))} ${bold(word)}` : `${count} ${word}`;
}

function formatHeader(title: string, counts: string[], colored: boolean): string {
  return `${colored ? bold(title) : title} · ${counts.join(' · ')}`;
}

export function formatProjectHeader(
  projectKey: string,
  fileCount: number,
  issueCount: number,
  colored: boolean,
): string {
  return formatHeader(
    projectKey,
    [formatCount(fileCount, 'file', colored), formatCount(issueCount, 'issue', colored)],
    colored,
  );
}

/** Header of the section holding files that belong to no project. */
export function formatIgnoredHeader(count: number, colored: boolean): string {
  return formatHeader('Not analyzed', [formatCount(count, 'file', colored)], colored);
}
