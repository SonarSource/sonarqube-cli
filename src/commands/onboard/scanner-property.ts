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

import { InvalidOptionError } from '@/core/commands/command-error.ts';

const MANAGED_PROPERTIES = new Set([
  'sonar.host.url',
  'sonar.region',
  'sonar.organization',
  'sonar.token',
  'sonar.login',
  'sonar.password',
  'sonar.projectKey',
  'sonar.projectName',
  'sonar.projectBaseDir',
  'sonar.working.directory',
  'sonar.scanner.metadataFilePath',
  'sonar.qualitygate.wait',
  'sonar.scanner.autoconfig.enabled',
  'sonar.scanner.proxyHost',
  'sonar.scanner.proxyPort',
  'sonar.scanner.proxyUser',
  'sonar.scanner.proxyPassword',
  'sonar.scanner.truststorePath',
  'sonar.scanner.truststorePassword',
  'sonar.scanner.keystorePath',
  'sonar.scanner.keystorePassword',
]);

export function collectOnboardScannerProperty(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function resolveOnboardScannerProperties(properties: string[] = []): string[] {
  return properties.reduce<string[]>((previous, value) => {
    const separator = value.indexOf('=');
    const key = value.slice(0, separator);
    if (separator <= 0 || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(key))
      throw new InvalidOptionError(
        '--scanner-property must use key=value, with a key starting with a letter and containing only letters, digits, dots, underscores, or hyphens.',
      );
    if (/[\u0000-\u001f\u007f]/.test(value))
      throw new InvalidOptionError('--scanner-property cannot contain control characters.');
    if (MANAGED_PROPERTIES.has(key))
      throw new InvalidOptionError(
        `Scanner property '${key}' is managed by onboard and cannot be overridden.`,
      );
    return [...previous.filter((property) => !property.startsWith(`${key}=`)), value];
  }, []);
}
