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

import { InvalidOptionError } from '@/core/commands/command-error.ts';

interface Property {
  key: string;
  value: string;
}

function parsePropertyLine(line: string): Property | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex === -1) {
    return null;
  }

  return {
    key: trimmed.slice(0, eqIndex).trim(),
    value: trimmed.slice(eqIndex + 1).trim(),
  };
}

/** Values are literal: backslashes are not escapes. */
export function parseProperties(content: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of content.split('\n')) {
    const property = parsePropertyLine(line);
    if (property) {
      properties.set(property.key, property.value);
    }
  }
  return properties;
}

function lastIndexOfProperty(lines: string[], key: string): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (parsePropertyLine(lines[index])?.key === key) {
      return index;
    }
  }
  return -1;
}

/** Rewrites only the line holding `key` (the last one, matching parse order), or appends it. */
export function setProperty(content: string, key: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new InvalidOptionError(`The value for '${key}' must not contain line breaks.`);
  }

  const entry = `${key}=${value}`;
  const lines = content.split('\n');
  const lineIndex = lastIndexOfProperty(lines, key);
  if (lineIndex !== -1) {
    lines[lineIndex] = lines[lineIndex].endsWith('\r') ? `${entry}\r` : entry;
    return lines.join('\n');
  }

  const lineBreak = content.includes('\r\n') ? '\r\n' : '\n';
  const missingLineBreak = content === '' || content.endsWith('\n') ? '' : lineBreak;
  return `${content}${missingLineBreak}${entry}${lineBreak}`;
}

/**
 * Drops every line holding `key` (not just the last — a stale earlier duplicate
 * would otherwise still resolve via {@link parseProperties}'s last-wins read).
 * No-op when the key is absent.
 */
export function removeProperty(content: string, key: string): string {
  return content
    .split('\n')
    .filter((line) => parsePropertyLine(line)?.key !== key)
    .join('\n');
}
