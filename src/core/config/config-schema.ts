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
  readonly description: string;
  /** Omitted when any string is accepted; otherwise the value must be one of these. */
  readonly allowedValues?: readonly string[];
  /** Alternative to `allowedValues` for open-ended values, e.g. numbers. */
  readonly allowedPattern?: { readonly regex: RegExp; readonly description: string };
}

const BOOLEAN_ALLOWED_VALUES = ['true', 'false'] as const;
const NON_NEGATIVE_INTEGER_PATTERN = { regex: /^\d+$/, description: 'a non-negative integer' };

export const CONFIG_KEY_DEFINITIONS = [
  {
    key: 'network.proxy.http',
    sensitive: true,
    description: 'HTTP proxy URL used for outbound HTTP requests.',
  },
  {
    key: 'network.proxy.https',
    sensitive: true,
    description: 'HTTPS proxy URL used for outbound HTTPS requests.',
  },
  {
    key: 'network.proxy.noProxy',
    sensitive: false,
    description: 'Comma-separated hosts to bypass the configured proxy.',
  },
  {
    key: 'network.tls.caCert',
    sensitive: false,
    description: 'Path to a custom CA certificate bundle to trust.',
  },
  {
    key: 'network.tls.clientCert',
    sensitive: false,
    description: 'Path to the client TLS certificate for mutual TLS.',
  },
  {
    key: 'network.tls.clientKey',
    sensitive: false,
    description: 'Path to the client TLS private key for mutual TLS.',
  },
  {
    key: 'network.tls.clientPassphrase',
    sensitive: true,
    description: 'Passphrase for the client TLS private key.',
  },
  {
    key: 'log.level',
    sensitive: false,
    description: 'CLI log verbosity.',
    allowedValues: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'],
  },
  {
    key: 'telemetry.enabled',
    sensitive: false,
    description: 'Whether anonymous usage telemetry is collected.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
  },
  {
    key: 'stats.enabled',
    sensitive: false,
    description: 'Whether local usage stats are collected.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
  },
  {
    key: 'context.projectListLimit',
    sensitive: false,
    description:
      "Most projects the agent session-start context lists in a multi-project workspace (default 50); larger workspaces point at 'sonar link list' instead.",
    allowedPattern: NON_NEGATIVE_INTEGER_PATTERN,
  },
] as const satisfies readonly ConfigKeyDefinition[];

export type ConfigKey = (typeof CONFIG_KEY_DEFINITIONS)[number]['key'];

export const CONFIG_KEY_NAMES: readonly ConfigKey[] = CONFIG_KEY_DEFINITIONS.map(({ key }) => key);

export const CONFIG_KEY_BY_NAME: ReadonlyMap<ConfigKey, ConfigKeyDefinition> = new Map(
  CONFIG_KEY_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** Whether `raw` is an accepted value for `definition` (any string when it declares no constraint). */
export function isValidConfigValue(definition: ConfigKeyDefinition, raw: string): boolean {
  if (definition.allowedPattern !== undefined) {
    return definition.allowedPattern.regex.test(raw);
  }
  return definition.allowedValues === undefined || definition.allowedValues.includes(raw);
}

/** The "Allowed values: …" / "Expected …" part of an invalid-value error. */
export function describeAllowedConfigValues(definition: ConfigKeyDefinition): string {
  if (definition.allowedPattern !== undefined) {
    return `Expected ${definition.allowedPattern.description}.`;
  }
  return `Allowed values: ${definition.allowedValues?.join(', ')}.`;
}

/** `--format json` shape for one config entry, shared by `config get` and `config list`. */
export interface ConfigEntryJson {
  key: string;
  sensitive: boolean;
  set: boolean;
  value?: string;
}

export const NOT_SET_MESSAGE = '(not set)';
export const MASKED_VALUE = '***';
