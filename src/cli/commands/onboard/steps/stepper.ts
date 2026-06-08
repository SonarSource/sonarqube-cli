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

// Step tracker + framed "stepper" panel for the onboarding wizard.
//
// Terminals are append-only, so we cannot redraw steps that have scrolled away.
// Instead, every step reprints this compact panel at the top: completed steps
// collapse to a ✓ and their recorded outcome, the current step is highlighted
// with →, and pending steps are dim ○. The active step's full content renders
// below the panel.

import { getColumns } from '@clack/core';

import { print } from '../../../../ui';
import { bold, cyan, dim, green, isTTY } from '../../../../ui/colors.js';

export interface StepDef {
  key: string;
  title: string;
}

export interface StepperState {
  steps: StepDef[];
  outcomes: Map<string, string>;
}

const MIN_WIDTH = 40;
const MAX_WIDTH = 80;
const TITLE = '✨ SonarQube Onboarding';

export function createStepper(steps: StepDef[]): StepperState {
  return { steps, outcomes: new Map() };
}

// Record a one-line outcome for a completed step; shown next to ✓ on later renders.
export function setOutcome(state: StepperState, key: string, outcome: string): void {
  state.outcomes.set(key, outcome);
}

function panelWidth(): number {
  const cols = isTTY ? getColumns(process.stdout) : MIN_WIDTH;
  return Math.min(Math.max(cols - 4, MIN_WIDTH), MAX_WIDTH);
}

// Visible length of a string, ignoring ANSI color escapes, so padding aligns.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, 'g');
function visibleLength(s: string): number {
  return s.replace(ANSI_ESCAPE, '').length;
}

function padTo(content: string, width: number): string {
  return content + ' '.repeat(Math.max(0, width - visibleLength(content)));
}

// Build the inner text for a single step row (no border), already colored.
function stepRow(state: StepperState, def: StepDef, index: number, currentIndex: number): string {
  const num = dim(`${String(index + 1)}.`);

  if (index < currentIndex) {
    const outcome = state.outcomes.get(def.key);
    const tail = outcome ? `  ${cyan(outcome)}` : '';
    return `${green('✓')} ${num} ${dim(def.title)}${tail}`;
  }
  if (index === currentIndex) {
    return `${cyan('→')} ${num} ${bold(def.title)}  ${dim('in progress')}`;
  }
  return `${dim('○')} ${num} ${dim(def.title)}`;
}

function renderPlain(state: StepperState, currentIndex: number): void {
  const current = state.steps[currentIndex];
  const n = String(currentIndex + 1);
  const total = String(state.steps.length);
  print(`\n=== Step ${n}/${total}: ${current.title} ===\n`);
}

/**
 * Print the framed stepper panel for the step at `currentIndex` (0-based).
 * Earlier steps render as done (with their outcome), the current step is
 * highlighted, and later steps are pending.
 */
export function renderStepper(state: StepperState, currentIndex: number): void {
  if (!isTTY) {
    renderPlain(state, currentIndex);
    return;
  }

  const width = panelWidth();
  const inner = width - 2; // space inside the two vertical borders

  const titlePad = '─'.repeat(Math.max(0, inner - visibleLength(TITLE) - 2));
  const top = dim('┌─ ') + bold(TITLE) + dim(` ${titlePad}┐`);
  const bottom = dim('└' + '─'.repeat(width) + '┘');
  const divider = dim('├' + '─'.repeat(width) + '┤');

  const lines = [`\n  ${top}`, `  ${divider}`];
  for (let i = 0; i < state.steps.length; i++) {
    const row = padTo(stepRow(state, state.steps[i], i, currentIndex), inner);
    lines.push(`  ${dim('│')} ${row} ${dim('│')}`);
  }
  lines.push(`  ${bottom}\n`);

  print(lines.join('\n'));
}
