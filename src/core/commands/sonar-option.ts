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

import { Option } from 'commander';

import {
  ALPHA_HELP_GROUP,
  isSameLifecycle,
  type LifecycleState,
  resolveLifecycle,
  STABLE_LIFECYCLE,
  type StageDescriptor,
} from './stage.ts';

/**
 * Commander Option subclass that can be marked Alpha, Beta, or Deprecated.
 *
 * `.option()` returns the command, so `.option().stage()` cannot type-check.
 * Stage options by passing a {@link SonarOption} to `SonarCommand.addOption`:
 *
 * @example
 * .addOption(
 *   new SonarOption('--preview', 'Preview the plan without applying it')
 *     .stage(Stage.Alpha),
 * )
 */
export class SonarOption extends Option {
  private _lifecycle = STABLE_LIFECYCLE;

  /**
   * Mark this option as Stable, Alpha, Beta (optionally Private Beta via a flag
   * key), or Deprecated. Required options cannot be staged as Alpha or Beta;
   * when the caller is not entitled the option is omitted from help and treated
   * as unknown. Deprecated options stay registered and warn on every use.
   */
  stage(stage: StageDescriptor): this {
    if (this.mandatory && (stage.name === 'alpha' || stage.name === 'beta')) {
      throw new Error(`Cannot stage a required option as Alpha or Beta: '${this.flags}'`);
    }

    const next = resolveLifecycle(stage);
    if (isSameLifecycle(this._lifecycle, next)) {
      return this;
    }
    this._lifecycle = next;

    if (next.stage === 'alpha') {
      this.helpGroup(ALPHA_HELP_GROUP);
    } else {
      this.helpGroupHeading = undefined;
    }
    return this;
  }

  get lifecycle(): LifecycleState {
    return this._lifecycle;
  }
}
