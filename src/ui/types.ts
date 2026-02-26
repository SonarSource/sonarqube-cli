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

// Shared types for the UI module

export type ColorFn = (text: string) => string;

export type StepStatus =
  | 'done' // ✓  green
  | 'running' // →  cyan
  | 'failed' // ✗  red
  | 'skipped' // ⏭  dim
  | 'warn' // ⚠  yellow
  | 'pending' // ○  dim
  | 'info'; // ℹ  cyan

export interface PhaseItem {
  text: string;
  status: StepStatus;
  detail?: string;
}

export interface NoteOptions {
  borderColor?: ColorFn;
  titleColor?: ColorFn;
  contentColor?: ColorFn;
}

export interface PhaseOptions {
  titleColor?: ColorFn;
  iconColors?: Partial<Record<StepStatus, ColorFn>>;
}

export interface LogOptions {
  color?: ColorFn;
}
