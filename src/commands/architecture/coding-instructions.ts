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

// Body of the CLAUDE.md and AGENTS.md block. Kept out of the skill file: that file is the skill document.

/** Stable id of the managed region, so a later install replaces this block and leaves the rest. */
export const ARCHITECTURE_INSTRUCTIONS_MARKER = 'sonarqube-architecture-coding';

export const ARCHITECTURE_CODING_INSTRUCTIONS = `# Architecture while coding

These instructions were installed by \`sonar architecture install-skill\`. This repository has an intended architecture in SonarQube that says which parts of the code may depend on which.

1. Before you add a dependency between folders, packages or modules, or create a new one, read the intended architecture with \`sonar architecture intended get\` and follow its constraints. A dependency that no constraint allows is a deviation. The constraints come after the groups, so do not cut the output short; run \`sonar architecture intended get --component <group>\` for each group you change to get only the constraints that involve it.
2. Before you finish a code change, compare every dependency you added with those constraints and fix any that are not allowed.

Do not change the intended architecture unless the user asks.
`;
