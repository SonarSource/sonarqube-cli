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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { DEFAULT_ANALYSIS_TIMEOUT_SECONDS } from '@/core/commands/poll.ts';
import { fetchAnonymous } from '@/core/server/fetch.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { isAtLeast } from '@/core/server/server-info.ts';

const ENGINE_DOWNLOAD_TIMEOUT_MS = DEFAULT_ANALYSIS_TIMEOUT_SECONDS * 1000;

export class ScannerEngineApi {
  constructor(private readonly http: SonarHttpClient) {}

  async usesModernBootstrap(): Promise<boolean> {
    if (this.http.isCloud) return true;
    const status = await this.http
      .get<{ version?: unknown } | null>('/api/system/status')
      .orThrow();
    if (
      typeof status?.version !== 'string' ||
      !/^\d+\.\d+(?:\.\d+)*(?:[-.][A-Za-z][\w.-]*)?$/.test(status.version)
    ) {
      throw new CommandFailedError('SonarQube Server did not return a valid version.');
    }
    return isAtLeast(status.version, '10.6');
  }

  async download(): Promise<{ bytes: ArrayBuffer; sha256: string }> {
    const endpoint = this.http.isCloud ? '/analysis/engine' : '/api/v2/analysis/engine';
    const metadata = await this.http
      .get<{ sha256?: unknown; downloadUrl?: unknown } | null>(endpoint)
      .orThrow();
    if (
      typeof metadata?.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(metadata.sha256) ||
      (metadata.downloadUrl != null && typeof metadata.downloadUrl !== 'string')
    ) {
      throw new CommandFailedError('SonarQube returned invalid scanner engine metadata.');
    }
    const downloadUrl = metadata.downloadUrl?.trim();
    const bytes = downloadUrl
      ? await this.downloadAnonymous(downloadUrl)
      : await this.http.getBytes(endpoint, ENGINE_DOWNLOAD_TIMEOUT_MS).orThrow();
    return { bytes, sha256: metadata.sha256 };
  }

  private async downloadAnonymous(url: string): Promise<ArrayBuffer> {
    const response = await fetchAnonymous(url, {
      signal: AbortSignal.timeout(ENGINE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new CommandFailedError(`Scanner engine download failed: HTTP ${response.status}.`);
    }
    return response.arrayBuffer();
  }
}
