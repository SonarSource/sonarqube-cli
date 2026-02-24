/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Core types for sonarqube-cli

export interface SonarQubeIssue {
  key: string;
  rule: string;
  severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER';
  component: string;
  project: string;
  line?: number;
  hash?: string;
  textRange?: {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
  };
  flows?: Array<{
    locations: Array<{
      component: string;
      textRange?: {
        startLine: number;
        endLine: number;
        startOffset: number;
        endOffset: number;
      };
      msg?: string;
    }>;
  }>;
  status: string;
  message: string;
  effort?: string;
  debt?: string;
  author?: string;
  tags?: string[];
  creationDate?: string;
  updateDate?: string;
  type: string;
}

export interface IssuesSearchParams {
  componentKeys?: string;
  projects?: string;
  severities?: string;
  types?: string;
  statuses?: string;
  rules?: string;
  tags?: string;
  branch?: string;
  pullRequest?: string;
  resolved?: boolean;
  s?: string;
  ps?: number;
  p?: number;
}

export interface IssuesSearchResponse {
  total: number;
  p: number;
  ps: number;
  paging: {
    pageIndex: number;
    pageSize: number;
    total: number;
  };
  issues: SonarQubeIssue[];
  components?: Array<{
    key: string;
    name: string;
    qualifier: string;
    path?: string;
  }>;
  rules?: Array<{
    key: string;
    name: string;
    lang?: string;
    langName?: string;
  }>;
}

export interface SonarQubeProject {
  key: string;
  name: string;
}

export interface ProjectsSearchParams {
  q?: string;
  ps?: number;
  p?: number;
  organization?: string;
}

export interface ProjectsSearchResponse {
  paging: {
    pageIndex: number;
    pageSize: number;
    total: number;
  };
  components: SonarQubeProject[];
}

export interface DaemonHealth {
  uptime: number;
  backendStatus: 'initializing' | 'ready' | 'error';
  lastError?: string;
}

export interface DiscoveryResult {
  projectRoot: string;
  gitRoot?: string;
  serverURL?: string;
  projectKey?: string;
  organization?: string;
  configFiles: string[];
}

export interface HealthCheckResult {
  tokenValid: boolean;
  serverAvailable: boolean;
  projectAccessible: boolean;
  hooksInstalled: boolean;
  errors: string[];
}
