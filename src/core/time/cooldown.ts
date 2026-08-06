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

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True when `isoTimestamp` is a valid past instant within `cooldownMs` of now.
 * A missing, unparseable, or future timestamp is treated as "not in cooldown"
 * so the guarded action is allowed to run.
 */
export function isWithinCooldown(isoTimestamp: string | undefined, cooldownMs: number): boolean {
  if (!isoTimestamp) {
    return false;
  }
  const elapsed = Date.now() - Date.parse(isoTimestamp);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < cooldownMs;
}
