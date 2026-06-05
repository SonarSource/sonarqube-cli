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

// Shared UI helpers for onboarding wizard steps

import { text } from '../../../../ui';
import { bold, dim } from '../../../../ui/colors.js';

export function stepHeader(step: number, total: number, title: string): void {
  const stepLabel = dim(`Step ${step} of ${total}`);
  text(`\n  ${bold(title)}  ${stepLabel}\n`);
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}
