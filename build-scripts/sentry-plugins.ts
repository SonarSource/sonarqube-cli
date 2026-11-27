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

import { sentryBunPlugin } from '@sentry/bun/plugin';

/**
 * Sentry build plugin shared by the binary build and the source-map build, so both emit the
 * same bundle layout and the uploaded source maps line up with the shipped binary.
 *
 * Without build-time instrumentation Sentry warns on every run, because Bun cannot patch
 * modules at runtime. Uploads happen in `sentry:upload-sourcemaps`, so the plugin must not
 * upload, create releases or send its own telemetry.
 */
export function createSentryPlugins(): Bun.BunPlugin[] {
  // The package types its return value as `any`.
  const plugin = sentryBunPlugin({
    telemetry: false,
    sourcemaps: { disable: true },
    release: { create: false, finalize: false, inject: false },
  }) as Bun.BunPlugin;
  return [plugin];
}
