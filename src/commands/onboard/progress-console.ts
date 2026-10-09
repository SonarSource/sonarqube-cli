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

import type { ColorFn } from '@/core/ui/colors.ts';
import type { Console } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

export class OnboardProgressConsole extends QuietConsole {
  readonly warnings: string[] = [];

  constructor(
    private readonly output: Console,
    private readonly format: 'text' | 'json',
  ) {
    super(output);
  }

  override info(message: string): void {
    this.output.info(message);
  }

  override success(message: string): void {
    this.output.discreetSuccess(message);
  }

  override discreetSuccess(message: string): void {
    this.output.discreetSuccess(message);
  }

  override text(message: string, color?: ColorFn): void {
    this.output.text(message, color);
  }

  override print(message: string): void {
    this.output.text(message);
  }

  override warn(message: string): void {
    this.warnings.push(message);
    if (this.format === 'text') this.output.warn(message);
  }

  override withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
    if (this.format === 'json') {
      this.output.info(message);
      return task();
    }
    return this.output.withSpinner(message, task);
  }
}
