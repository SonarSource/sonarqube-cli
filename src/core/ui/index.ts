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

// Public API for the UI module

export type { CliConsole } from './cli-console.ts';
export { bold, dim, stripAnsi, visibleLength } from './colors.ts';
export { note } from './components/note.ts';
export type { PhaseItem, StepStatus } from './components/phase.ts';
export { phase, phaseItem } from './components/phase.ts';
export type {
  MultiSelectOption,
  MultiSelectPromptOptions,
  SelectOption,
} from './components/prompts.ts';
export {
  confirmPrompt,
  multiSelectPrompt,
  passwordPrompt,
  pressEnterKeyPrompt,
  promptUntilValid,
  selectPrompt,
  textPrompt,
} from './components/prompts.ts';
export { intro, outro } from './components/sections.ts';
export { withSpinner } from './components/spinner.ts';
export {
  blank,
  discreetSuccess,
  error,
  getMessagesForFormattedOutput,
  info,
  isFormattedOutputMode,
  print,
  setFormattedOutputMode,
  success,
  text,
  warn,
  wrapText,
} from './messages.ts';
export type { UiCall, UiMethod } from './mock.ts';
export {
  clearMockResponses,
  clearMockUiCalls,
  findMockUiCall,
  getMockUiCalls,
  isMockActive,
  queueMockResponse,
  setMockTty,
  setMockUi,
} from './mock.ts';
export { TerminalConsole } from './terminal-console.ts';
export type { ColorFn, LogOptions, NoteOptions, OutputChannel, PhaseOptions } from './types.ts';
