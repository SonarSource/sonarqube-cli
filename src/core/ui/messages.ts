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

// Inline terminal output — non-interactive, static messages.
// I/O is owned by TerminalConsole; these functions delegate to the process default.

import { getDefaultConsole } from './default-console.ts';
import type { ColorFn, OutputChannel } from './types.ts';

export function setFormattedOutputMode(active: boolean): void {
  getDefaultConsole().setFormattedOutputMode(active);
}

export function isFormattedOutputMode(): boolean {
  return getDefaultConsole().isFormattedOutputMode();
}

export function getMessagesForFormattedOutput(): string[] {
  return getDefaultConsole().getMessagesForFormattedOutput();
}

export function info(message: string, channel: OutputChannel = 'stdout'): void {
  getDefaultConsole().info(message, channel);
}

export function success(message: string): void {
  getDefaultConsole().success(message);
}

export function discreetSuccess(message: string, channel: OutputChannel = 'stdout'): void {
  getDefaultConsole().discreetSuccess(message, channel);
}

export function warn(message: string): void {
  getDefaultConsole().warn(message);
}

export function error(message: string): void {
  getDefaultConsole().error(message);
}

export function text(message: string, color?: ColorFn, channel: OutputChannel = 'stdout'): void {
  getDefaultConsole().text(message, color, channel);
}

export function print(message: string, channel: OutputChannel = 'stdout'): void {
  getDefaultConsole().print(message, channel);
}

export function blank(): void {
  getDefaultConsole().blank();
}

/**
 * Greedy word wrap: packs whitespace-separated words into lines no longer than
 * `width`. A single word longer than `width` is left on its own over-long line
 * rather than split mid-word.
 */
export function wrapText(content: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of content.split(/\s+/)) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines;
}
