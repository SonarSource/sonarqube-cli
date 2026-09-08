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

// SonarQube Duplications API wrapper

import type { ResultAsync } from '../result.ts';
import type { HttpClientError } from './errors.ts';
import type { QueryParams, SonarHttpClient } from './http-client.ts';
import type { DuplicationsShowBlock, DuplicationsShowResponse } from './types.ts';

export interface DuplicationInfo {
  /** Count of this file's own occurrences flagged as duplicated, not the number of duplication groups. */
  blockCount: number;
  duplicatesWith: string[];
}

export interface GetDuplicationInfoParams {
  componentKey: string;
  branch?: string;
  pullRequest?: string;
}

export class DuplicationsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  getDuplicationInfo(
    params: GetDuplicationInfoParams,
  ): ResultAsync<DuplicationInfo, HttpClientError> {
    const queryParams: QueryParams = { key: params.componentKey };
    if (params.branch) {
      queryParams.branch = params.branch;
    }
    if (params.pullRequest) {
      queryParams.pullRequest = params.pullRequest;
    }
    return this.client
      .get<DuplicationsShowResponse>('/api/duplications/show', queryParams)
      .map((response) => toDuplicationInfo(response, params.componentKey));
  }
}

/** Resolves the self-ref by matching `files[ref].key` - `_ref` values have no fixed meaning across calls. */
function toDuplicationInfo(
  response: DuplicationsShowResponse,
  componentKey: string,
): DuplicationInfo {
  const files = response.files;
  const [selfRef] = Object.entries(files).find(([, file]) => file?.key === componentKey) ?? [];

  let thisFileBlockCount = 0;
  const peerPaths = new Set<string>();
  for (const duplication of response.duplications) {
    for (const block of duplication.blocks) {
      if (selfRef !== undefined && block._ref === selfRef) {
        thisFileBlockCount++;
      } else {
        addPeerName(files, block, peerPaths);
      }
    }
  }

  return {
    blockCount: thisFileBlockCount,
    duplicatesWith: [...peerPaths],
  };
}

function addPeerName(
  files: DuplicationsShowResponse['files'],
  block: DuplicationsShowBlock,
  peerPaths: Set<string>,
): void {
  const peerName = block._ref === undefined ? undefined : files[block._ref]?.name;
  if (peerName !== undefined) {
    peerPaths.add(peerName);
  }
}
