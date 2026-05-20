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

// UserPromptSubmit callback handler for Codex.
//
// Codex's UserPromptSubmit stdin payload exposes the user prompt at the same
// top-level `prompt` field as Claude, and Codex accepts the same
// `{ decision: "block", reason: "..." }` block-output shape. The agnostic
// `agentPromptSubmit` handler therefore works as-is. This file exists to give
// Codex a named entry point that can diverge later if the wire format ever
// changes.

import { agentPromptSubmit } from './agent-prompt-submit';

export function codexPromptSubmit(): Promise<void> {
  return agentPromptSubmit();
}
