// Types for sonar-secrets binary installation

export interface GitHubRelease {
  tag_name: string;
  name: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface PlatformInfo {
  os: string;
  arch: string;
  extension: string;
}

export interface BinaryInstallResult {
  version: string;
  path: string;
  verified: boolean;
}

export interface InstalledTool {
  name: string;
  version: string;
  path: string;
  installedAt: string;
  installedByCliVersion: string;
}

export interface ToolsState {
  installed: InstalledTool[];
}

export const SONAR_SECRETS_REPO = {
  owner: 'SonarSource',
  name: 'sonar-secrets-pre-commit'
};

export const BINARY_NAME = 'sonar-secrets';
