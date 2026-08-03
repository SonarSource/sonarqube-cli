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

import { runContextPassthrough } from '../context/index.ts';
import { readRawStdin } from './stdin.ts';

export async function claudePostToolUseFailure(): Promise<void> {
  let raw: string;
  try {
    raw = await readRawStdin();
  } catch {
    return; // timeout or read error — non-blocking
  }

  await runContextPassthrough('__hook', ['Claude'], { stdinPayload: raw });
}
