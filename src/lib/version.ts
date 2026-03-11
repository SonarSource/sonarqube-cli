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

/**
 * Strips the build number (4th segment) from a version string.
 * The install script version may include a build number (e.g. "0.5.0.241") while
 * the CLI version from package.json only has three segments ("0.5.0").
 */
export function stripBuildNumber(version: string): string {
  const SEMVER_SEGMENTS = 3;
  return version.split('.').slice(0, SEMVER_SEGMENTS).join('.');
}

/** Returns true when `candidate` is strictly newer than `current` (semver, numeric comparison). */
export function isNewerVersion(current: string, candidate: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(Number);
  const curr = parse(current);
  const cand = parse(candidate);
  for (let i = 0; i < Math.max(curr.length, cand.length); i++) {
    const c = curr[i] ?? 0;
    const f = cand[i] ?? 0;
    if (f > c) return true;
    if (f < c) return false;
  }
  return false;
}
