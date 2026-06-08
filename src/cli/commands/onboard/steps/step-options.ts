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

// Installation options — checkboxes shown just before files are ingested.

import { blank, multiSelectPrompt, text } from '../../../../ui';
import { dim } from '../../../../ui/colors.js';
import type { InstallOptions } from '../types.js';
import type { StepperState } from './stepper.js';
import { renderStepper } from './stepper.js';

type OptionKey = keyof InstallOptions;

const OPTIONS: { key: OptionKey; label: string }[] = [
  {
    key: 'injectIntoMainBranch',
    label: 'Inject the files into the main branch instead of opening a PR',
  },
  { key: 'configureForIde', label: 'Configure repo SonarQube for IDE' },
];

// Returns the chosen options, or null if the user cancelled.
export async function runStepOptions(
  stepper: StepperState,
  stepIndex: number,
): Promise<InstallOptions | null> {
  renderStepper(stepper, stepIndex);

  blank();
  text(dim('  Choose how the SonarQube configuration is applied to each repository.'));
  blank();

  const selected = await multiSelectPrompt(
    'Select options to enable:',
    OPTIONS.map((o) => ({ value: o.key, label: o.label })),
  );

  if (selected === null) return null;

  const chosen = new Set(selected);
  return {
    injectIntoMainBranch: chosen.has('injectIntoMainBranch'),
    configureForIde: chosen.has('configureForIde'),
  };
}
