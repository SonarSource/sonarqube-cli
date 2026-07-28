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

// Legacy telemetry sink/queue migration, consumed by the post-update mechanism
// that runs automatically after CLI upgrades.

import * as fs from 'node:fs';
import { join } from 'node:path';

import { appendTelemetryEvent } from '@/core/telemetry/telemetry-events.ts';

import { getTelemetryDir } from '../config-constants.ts';
import logger from '../observability/logger.ts';
import { loadState, saveState } from '../state/state-repository.ts';

/** Migrates legacy telemetry events to the new pipeline (telemetry-events.ndjson). */
export function migrateLegacyTelemetryEvents(): void {
  migrateSinkFile();
  migrateStateQueue();
}

/** Moves any events left in `state.telemetry.events` to `telemetry-events.ndjson`. */
function migrateStateQueue(): void {
  const state = loadState();
  const legacyEvents = state.telemetry.events ?? [];
  if (legacyEvents.length === 0) {
    return;
  }

  // Clear the queue first, then drain: a crash mid-way loses a rare
  // best-effort event instead of re-appending duplicates on the next launch.
  delete state.telemetry.events;
  saveState(state);

  for (const event of legacyEvents) {
    appendTelemetryEvent(event);
  }

  logger.debug(
    `Migrated ${legacyEvents.length} legacy telemetry event(s) to telemetry-events.ndjson`,
  );
}

/** Migrates the previous telemetry file `findings.ndjson` to `telemetry-events.ndjson`. */
function migrateSinkFile(): void {
  const telemetryDir = getTelemetryDir();
  const oldPath = join(telemetryDir, 'findings.ndjson');
  const newPath = join(telemetryDir, 'telemetry-events.ndjson');
  if (!fs.existsSync(oldPath)) {
    return;
  }

  try {
    if (fs.existsSync(newPath)) {
      // Remove the old sink first, then append: a crash mid-way loses a rare
      // best-effort event instead of re-appending duplicates on the next launch.
      const oldContents = fs.readFileSync(oldPath, 'utf-8');
      fs.rmSync(oldPath);
      fs.appendFileSync(newPath, oldContents);
    } else {
      fs.renameSync(oldPath, newPath);
    }
    logger.debug('Migrated telemetry file findings.ndjson to telemetry-events.ndjson');
  } catch (error) {
    logger.debug(`Failed to migrate telemetry sink file: ${(error as Error).message}`);
  }
}
