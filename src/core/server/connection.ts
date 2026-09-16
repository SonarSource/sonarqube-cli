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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

/**
 * Credentials for one SonarQube server and the transport bound to it.
 *
 * The two are inseparable: {@link httpClient} carries {@link auth}'s server URL and token, so it
 * addresses that server and no other — not a CDN, not the telemetry endpoint. Passing a connection
 * rather than a loose client keeps the organization key (`auth.orgKey`, Cloud-only) travelling with
 * the transport that needs it, instead of as a second parameter a caller can forget.
 */
export interface SonarConnection {
  readonly auth: ResolvedAuth;
  readonly httpClient: SonarHttpClient;
}
