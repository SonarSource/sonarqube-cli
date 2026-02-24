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

// Public API for the UI module

export { info, success, warn, error, text, print, blank } from './messages.js';
export { note } from './components/note.js';
export { phase, phaseItem } from './components/phase.js';
export type { PhaseItem, StepStatus } from './components/phase.js';
export { intro, outro } from './components/sections.js';
export { setMockUi, isMockActive, getMockUiCalls, clearMockUiCalls, queueMockResponse, clearMockResponses } from './mock.js';
export type { UiCall } from './mock.js';
export type { NoteOptions, PhaseOptions, LogOptions, ColorFn } from './types.js';
export { withSpinner } from './components/spinner.js';
export { textPrompt, confirmPrompt, pressAnyKeyPrompt } from './components/prompts.js';
