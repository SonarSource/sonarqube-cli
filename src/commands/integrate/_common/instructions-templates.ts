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

// Markers that delimit the regions integrations own inside instructions files
// they share with the user (e.g. Copilot's sonarqube.instructions.md, Codex's
// AGENTS.md), so a later CLI version can locate and replace just its own
// region without clobbering anything the user appended around it.

export function sonarBeginMarker(id: string): string {
  return `<!-- sonar:begin:${id} -->`;
}

export function sonarEndMarker(id: string): string {
  return `<!-- sonar:end:${id} -->`;
}
