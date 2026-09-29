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

/**
 * Allowlist of every valid `sonar config` key, its sensitivity, and its
 * accepted values. Consumed by `config set`/`get`/`unset`/`list` to validate
 * a key and route its value to the right store (OS keychain when sensitive,
 * plain config file otherwise).
 */

export interface ConfigKeyDefinition {
  readonly key: string;
  readonly sensitive: boolean;
  /** Omitted when any string is accepted; otherwise the value must be one of these. */
  readonly allowedValues?: readonly string[];
}

const BOOLEAN_ALLOWED_VALUES = ['true', 'false'] as const;

export const CONFIG_KEY_ALLOWLIST = [
  { key: 'network.proxy.https', sensitive: true },
  { key: 'network.proxy.http', sensitive: true },
  { key: 'network.tls.caCert', sensitive: false },
  { key: 'network.tls.clientCert', sensitive: false },
  { key: 'network.tls.clientKey', sensitive: false },
  { key: 'network.tls.clientPassphrase', sensitive: true },
  {
    key: 'log.level',
    sensitive: false,
    allowedValues: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'],
  },
  { key: 'telemetry.enabled', sensitive: false, allowedValues: BOOLEAN_ALLOWED_VALUES },
  { key: 'stats.enabled', sensitive: false, allowedValues: BOOLEAN_ALLOWED_VALUES },
] as const satisfies readonly ConfigKeyDefinition[];

export type ConfigKey = (typeof CONFIG_KEY_ALLOWLIST)[number]['key'];

export const CONFIG_KEY_BY_NAME: ReadonlyMap<ConfigKey, ConfigKeyDefinition> = new Map(
  CONFIG_KEY_ALLOWLIST.map((definition) => [definition.key, definition]),
);

/** Whether `raw` is an accepted value for `definition` (any string when `allowedValues` is absent). */
export function isValidConfigValue(definition: ConfigKeyDefinition, raw: string): boolean {
  return definition.allowedValues === undefined || definition.allowedValues.includes(raw);
}
