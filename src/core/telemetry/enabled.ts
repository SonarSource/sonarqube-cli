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

import { getBooleanConfigValue } from '../config/config-repository.ts';
import { ENV_DO_NOT_TRACK } from '../config-constants.ts';

/** True when DO_NOT_TRACK is set to 1 */
export function isDoNotTrackRequested(): boolean {
  return process.env[ENV_DO_NOT_TRACK]?.trim() === '1';
}

/** Whether telemetry collection and error reporting should run for this session. */
export function isTelemetryEnabled(): boolean {
  try {
    return getBooleanConfigValue('telemetry.enabled', true) && !isDoNotTrackRequested();
  } catch {
    return false;
  }
}
