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
