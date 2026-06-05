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

// Install mode selection — runs before the main wizard steps

import { selectPrompt } from '../../../../ui';
import { dim } from '../../../../ui/colors.js';
import type { InstallMode, WizardContext } from '../types.js';

const INSTALL_MODE_OPTIONS: {
  value: InstallMode;
  icon: string;
  label: string;
  description: string;
}[] = [
  {
    value: 'recommended',
    icon: '⚡',
    label: 'Recommended',
    description: 'Onboard all organizations and repositories automatically, skip any that fail',
  },
  {
    value: 'manual',
    icon: '🔧',
    label: 'Manual',
    description: 'Choose which organizations and repositories to onboard yourself',
  },
];

export async function runInstallModeStep(ctx: WizardContext): Promise<boolean> {
  const selected = await selectPrompt(
    'How do you want to onboard?',
    INSTALL_MODE_OPTIONS.map((o) => ({
      value: o.value,
      label: `${o.icon}  ${o.label}\n       ${dim(o.description)}`,
    })),
    { hint: '↑ ↓  Navigate    ↵  Confirm    Ctrl+C  Cancel' },
  );

  if (selected === null) return false;

  ctx.installMode = selected;
  return true;
}
