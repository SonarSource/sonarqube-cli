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

import type { BunFile } from 'bun';

import type { RedactedUrl } from '../redacted-url';

export type ConfigSource = 'sonar-env' | 'stored-config' | 'generic-env';

export interface SourcedValue<T> {
  readonly value: T;
  readonly source: ConfigSource;
  readonly explicit: boolean;
}

export interface FetchNetworkOptions {
  proxy?: string;
  tls?: { ca: Array<string | BunFile> };
}

export interface ProxyGroup {
  readonly source: ConfigSource;
  readonly explicit: boolean;
  readonly proxyHttps: RedactedUrl | null;
  readonly proxyHttp: RedactedUrl | null;
  readonly noProxy: string | null;
}

export interface CaCertConfig {
  readonly source: ConfigSource;
  readonly explicit: boolean;
  readonly path: string;
}

export interface ResolvedNetworkConfig {
  readonly proxy: ProxyGroup | null;
  readonly caCert: CaCertConfig | null;
}
