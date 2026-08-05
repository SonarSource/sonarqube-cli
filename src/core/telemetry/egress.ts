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
 * Whether telemetry and error reporting may leave this process.
 *
 * Deliberately separate from consent (`isTelemetryEnabled`): the two are independent, so
 * events can be collected without being transmitted.
 */

export const ENV_TELEMETRY_EGRESS = '__SQ_CLI_TELEMETRY_EGRESS';

export const TELEMETRY_EGRESS_OFF = 'off';

export type TelemetryEgress = { kind: 'production' } | { kind: 'off' };

const PRODUCTION: TelemetryEgress = { kind: 'production' };
const OFF: TelemetryEgress = { kind: 'off' };

/**
 * Unset or empty resolves to production; **any** other value resolves to off, so a
 * misspelled or truncated override fails closed instead of transmitting.
 */
export function resolveTelemetryEgress(): TelemetryEgress {
  const raw = process.env[ENV_TELEMETRY_EGRESS]?.trim();
  return raw === undefined || raw === '' ? PRODUCTION : OFF;
}
