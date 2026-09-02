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

const identity = (s: string) => s;

const base = {
  bold: identity,
  dim: identity,
  underline: identity,
  green: identity,
  red: identity,
  cyan: identity,
  yellow: identity,
  gray: identity,
  white: identity,
  blue: identity,
  softBlue: identity,
  stripAnsi: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ''),
  visibleLength: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length,
  STATUS_COLORS: {
    done: identity,
    running: identity,
    failed: identity,
    skipped: identity,
    warn: identity,
    pending: identity,
    info: identity,
  },
  STATUS_ICONS: {
    done: '✓',
    running: '→',
    failed: '✗',
    skipped: '⏭',
    warn: '⚠',
    pending: '○',
    info: 'ℹ',
  },
  NOTE_STYLES: {
    success: { borderColor: identity, titleColor: identity, contentColor: identity },
    error: { borderColor: identity, titleColor: identity, contentColor: identity },
    warn: { borderColor: identity, titleColor: identity, contentColor: identity },
  },
};

export const mockColorsNonTTY = () => ({ ...base, isTTY: false });
export const mockColorsTTY = () => ({ ...base, isTTY: true });
