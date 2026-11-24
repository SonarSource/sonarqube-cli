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

import { SONAR_CONTAINER_SCANNER_DIST_PREFIX } from '@/core/config-constants.ts';
import type { Console } from '@/core/ui/console.ts';

import { type BinarySpec, installBinary } from './binary.ts';
import {
  SONAR_CONTAINER_SCANNER_EXTENSIONS,
  SONAR_CONTAINER_SCANNER_SIGNATURES,
  SONAR_CONTAINER_SCANNER_VERSION,
  SONARSOURCE_PUBLIC_KEY,
} from './signatures.ts';

export const CONTAINER_SCANNER_SPEC: BinarySpec = {
  name: 'sonar-container-scanner',
  version: SONAR_CONTAINER_SCANNER_VERSION,
  distPrefix: SONAR_CONTAINER_SCANNER_DIST_PREFIX,
  signatures: SONAR_CONTAINER_SCANNER_SIGNATURES,
  publicKey: SONARSOURCE_PUBLIC_KEY,
  extensions: SONAR_CONTAINER_SCANNER_EXTENSIONS,
  platformNaming: 'x64',
};

export async function installContainerScanner(console: Console): Promise<string> {
  const { binaryPath } = await installBinary(CONTAINER_SCANNER_SPEC, {
    console,
    channel: 'stderr',
  });
  return binaryPath;
}
