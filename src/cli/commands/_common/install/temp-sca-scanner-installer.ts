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

import { type ScaScannerInstallerLike } from './sca-scanner.ts';

// TODO(SCA wiring): remove this temporary hardcoded path and switch back to
// `DefaultScaScannerInstaller` once the binary is published.
const TEMP_SCA_SCANNER_PATH =
  'C:\\Users\\georgii.borovinskikh\\Desktop\\tmp\\SCA\\sca-scanner-windows-x86-64.exe';

export class TempScaScannerInstaller implements ScaScannerInstallerLike {
  install(): Promise<string> {
    return Promise.resolve(TEMP_SCA_SCANNER_PATH);
  }
}
