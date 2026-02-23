// Types for sonar-secrets binary installation

export interface PlatformInfo {
  os: string;
  arch: string;
  extension: string;
}

export const SECRETS_BINARY_NAME = 'sonar-secrets';
