// Keychain operations wrapper for keytar

const SERVICE_NAME = 'sonar-cli';

interface Credential {
  account: string;
  password: string;
}

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Credential[]>;
}

let keytar: KeytarModule | null = null;
let mockKeytar: KeytarModule | null = null;

export function setMockKeytar(mock: KeytarModule | null) {
  mockKeytar = mock;
}

async function getKeytar() {
  if (mockKeytar !== null) {
    return mockKeytar;
  }
  keytar ??= (await import('keytar')).default;
  return keytar;
}

/**
 * Generate keychain account key
 * SonarCloud: "sonarcloud.io:org-key"
 * SonarQube: "hostname"
 */
function generateKeychainAccount(serverURL: string, org?: string): string {
  try {
    const url = new URL(serverURL);
    const hostname = url.hostname;

    // SonarCloud with organization
    if (org) {
      return `${hostname}:${org}`;
    }
    // SonarQube or hostname without organization
    return hostname;
  } catch {
    return serverURL;
  }
}

/**
 * Get token from system keychain
 * For SonarCloud: pass org parameter
 * For SonarQube: org parameter is ignored
 */
export async function getToken(serverURL: string, org?: string): Promise<string | null> {
  const account = generateKeychainAccount(serverURL, org);
  const kt = await getKeytar();
  return await kt.getPassword(SERVICE_NAME, account);
}

/**
 * Save token to system keychain
 * For SonarCloud: pass org parameter
 * For SonarQube: org parameter is ignored
 */
export async function saveToken(serverURL: string, token: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  const kt = await getKeytar();
  await kt.setPassword(SERVICE_NAME, account, token);
}

/**
 * Delete token from system keychain
 * For SonarCloud: pass org parameter
 * For SonarQube: org parameter is ignored
 */
export async function deleteToken(serverURL: string, org?: string): Promise<void> {
  const account = generateKeychainAccount(serverURL, org);
  const kt = await getKeytar();
  await kt.deletePassword(SERVICE_NAME, account);
}

/**
 * Get all credentials for this service
 */
export async function getAllCredentials(): Promise<Array<{ account: string; password: string }>> {
  const kt = await getKeytar();
  return await kt.findCredentials(SERVICE_NAME);
}

/**
 * Clear all tokens for this service
 */
export async function purgeAllTokens(): Promise<void> {
  const credentials = await getAllCredentials();
  const kt = await getKeytar();
  for (const cred of credentials) {
    await kt.deletePassword(SERVICE_NAME, cred.account);
  }
}
