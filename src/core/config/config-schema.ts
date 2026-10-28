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
  /** A pattern a free-form value must match, and how to name it in the error when it does not. */
  readonly valueFormat?: { readonly pattern: RegExp; readonly description: string };
}

const BOOLEAN_ALLOWED_VALUES = ['true', 'false'] as const;

// At most 15 digits keeps the value a safe JS integer that prints back as plain digits, never as `1e+21`.
const NON_NEGATIVE_INTEGER_FORMAT = {
  pattern: /^\d{1,15}$/,
  description: 'a non-negative integer of at most 15 digits',
};

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
    key: 'mcp.container.network',
    sensitive: false,
    description: 'Container network used by the SonarQube MCP server.',
  },
  {
    key: 'mcp.container.addHost',
    sensitive: false,
    description: 'Host mapping for the SonarQube MCP container (name:address).',
  },
  {
    key: 'mcp.container.serverUrl',
    sensitive: false,
    description: 'SonarQube URL used only inside the MCP container.',
  },
  {
    key: 'mcp.container.autoNetwork',
    sensitive: false,
    description:
      'Whether to route the MCP container to a loopback SonarQube URL automatically (native Linux uses host networking; Docker and Podman elsewhere use host aliases). Disabled by default; mcp.container.network/addHost/serverUrl always take precedence when set.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
  },
  {
    key: 'secrets.maxFileSize',
    sensitive: false,
    description:
      'Maximum size in bytes of a file the secrets analysis scans; larger files are skipped. 0 disables the limit. Default: 1048576 (1 MB). The git pre-push hook always skips pushed files over 1 MB.',
    valueFormat: NON_NEGATIVE_INTEGER_FORMAT,
  },
  {
    key: 'secrets.exclude',
    sensitive: false,
    description:
      'Comma-separated files and directories the secrets analysis skips (exact paths or directory prefixes, no wildcards). Relative paths resolve against the git repository root, or the current directory outside a repository.',
  },
  {
    key: 'secrets.disableTestFileDetection',
    sensitive: false,
    description:
      'Whether the secrets analysis also scans automatically detected test files, reporting their findings as low-confidence. Applies to every secrets scan, including git and agent hooks.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
  },
  {
    key: 'secrets.disableEntropyFilter',
    sensitive: false,
    description:
      'Whether the secrets analysis also reports low-entropy matches as low-confidence findings. Applies to every secrets scan, including git and agent hooks.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
  },
  {
    key: 'secrets.disableKnownFakeSecretFilter',
    sensitive: false,
    description:
      'Whether the secrets analysis also reports matches on known fake secrets (placeholders, repeated characters) as low-confidence findings. Applies to every secrets scan, including git and agent hooks.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
  },
  {
    key: 'secrets.demoMode',
    sensitive: false,
    description:
      'Whether the secrets analysis disables every filter for fake, placeholder and low-entropy secrets and scans test, documentation, sample and template files. Noisy; intended for demos and evaluations. Applies to every secrets scan, including git and agent hooks.',
    allowedValues: BOOLEAN_ALLOWED_VALUES,
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
] as const satisfies readonly ConfigKeyDefinition[];

export type ConfigKey = (typeof CONFIG_KEY_DEFINITIONS)[number]['key'];

export const CONFIG_KEY_NAMES: readonly ConfigKey[] = CONFIG_KEY_DEFINITIONS.map(({ key }) => key);

export const CONFIG_KEY_BY_NAME: ReadonlyMap<ConfigKey, ConfigKeyDefinition> = new Map(
  CONFIG_KEY_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** Whether `raw` is an accepted value for `definition` (any string when it has no constraint). */
export function isValidConfigValue(definition: ConfigKeyDefinition, raw: string): boolean {
  if (definition.allowedValues !== undefined && !definition.allowedValues.includes(raw)) {
    return false;
  }
  return definition.valueFormat === undefined || definition.valueFormat.pattern.test(raw);
}

/** The constraint `isValidConfigValue` enforces, phrased for an error message. */
export function describeAcceptedValues(definition: ConfigKeyDefinition): string {
  if (definition.allowedValues !== undefined) {
    return `Allowed values: ${definition.allowedValues.join(', ')}.`;
  }
  return `Expected ${definition.valueFormat?.description ?? 'any value'}.`;
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
