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

import { isNewerVersion, stripBuildNumber } from '../../../lib/version';

export class Version {
  constructor(readonly text: string) {}

  get noBuild(): Version {
    const noBuild = stripBuildNumber(this.text);
    return noBuild === this.text ? this : new Version(noBuild);
  }

  isNewerThan(other: Version): boolean {
    return isNewerVersion(other.text, this.text);
  }

  toString(): string {
    return this.text;
  }
}
