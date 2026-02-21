// Authentication command tests

import { it, expect } from 'bun:test';
import { getToken, saveToken, deleteToken, getAllCredentials, purgeAllTokens } from '../../src/lib/keychain.js';
import { createMockKeytar } from '../helpers/mock-keytar.js';

const TOKEN_COUNT = 3;

createMockKeytar().setup();

it('keychain: generate correct account key for SonarCloud', async () => {
  // This is tested indirectly through saveToken/getToken behavior
  const token1 = 'token-org1';
  const token2 = 'token-org2';

  await saveToken('https://sonarcloud.io', token1, 'my-org-1');
  await saveToken('https://sonarcloud.io', token2, 'my-org-2');

  const retrieved1 = await getToken('https://sonarcloud.io', 'my-org-1');
  const retrieved2 = await getToken('https://sonarcloud.io', 'my-org-2');

  expect(retrieved1).toBe(token1);
  expect(retrieved2).toBe(token2);

  // Different orgs should have different keys
  expect(retrieved1).not.toBe(retrieved2);

  await purgeAllTokens();
});

it('keychain: generate correct account key for SonarQube', async () => {
  const token1 = 'token-sq1';
  const token2 = 'token-sq2';

  await saveToken('https://sonarqube1.io', token1);
  await saveToken('https://sonarqube2.io', token2);

  const retrieved1 = await getToken('https://sonarqube1.io');
  const retrieved2 = await getToken('https://sonarqube2.io');

  expect(retrieved1).toBe(token1);
  expect(retrieved2).toBe(token2);

  await purgeAllTokens();
});

it('keychain: save and get token for SonarCloud with org', async () => {
  const server = 'https://sonarcloud.io';
  const org = 'my-org';
  const token = 'squ_abc123def456';

  await saveToken(server, token, org);

  const retrieved = await getToken(server, org);
  expect(retrieved).toBe(token);

  await purgeAllTokens();
});

it('keychain: save and get token for SonarQube server', async () => {
  const server = 'https://my-sonarqube.io';
  const token = 'squ_xyz789uvw012';

  await saveToken(server, token);

  const retrieved = await getToken(server);
  expect(retrieved).toBe(token);

  await purgeAllTokens();
});

it('keychain: delete token', async () => {
  const server = 'https://sonarcloud.io';
  const org = 'test-org';
  const token = 'test-token-123';

  await saveToken(server, token, org);
  expect(await getToken(server, org)).toBe(token);

  await deleteToken(server, org);
  expect(await getToken(server, org)).toBe(null);

  await purgeAllTokens();
});

it('keychain: get non-existent token returns null', async () => {
  const token = await getToken('https://nonexistent.io', 'no-org');
  expect(token).toBe(null);
});

it('keychain: getAllCredentials returns all tokens', async () => {
  await saveToken('https://sonarcloud.io', 'token1', 'org1');
  await saveToken('https://sonarcloud.io', 'token2', 'org2');
  await saveToken('https://sonarqube.io', 'token3');

  const credentials = await getAllCredentials();
  expect(credentials.length).toBe(TOKEN_COUNT);

  const accounts = credentials.map(c => c.account);
  expect(accounts).toContain('sonarcloud.io:org1');
  expect(accounts).toContain('sonarcloud.io:org2');
  expect(accounts).toContain('sonarqube.io');

  await purgeAllTokens();
});

it('keychain: getAllCredentials returns empty array when no tokens', async () => {
  const credentials = await getAllCredentials();
  expect(credentials.length).toBe(0);
});

it('keychain: purgeAllTokens removes all tokens', async () => {
  await saveToken('https://sonarcloud.io', 'token1', 'org1');
  await saveToken('https://sonarcloud.io', 'token2', 'org2');
  await saveToken('https://sonarqube.io', 'token3');

  let credentials = await getAllCredentials();
  expect(credentials.length).toBe(TOKEN_COUNT);

  await purgeAllTokens();

  credentials = await getAllCredentials();
  expect(credentials.length).toBe(0);
});

it('keychain: same server with different orgs have different keys', async () => {
  const server = 'https://sonarcloud.io';

  await saveToken(server, 'token-for-org1', 'org1');
  await saveToken(server, 'token-for-org2', 'org2');

  const token1 = await getToken(server, 'org1');
  const token2 = await getToken(server, 'org2');

  expect(token1).toBe('token-for-org1');
  expect(token2).toBe('token-for-org2');
  expect(token1).not.toBe(token2);

  await purgeAllTokens();
});

it('keychain: normalize server URLs with trailing slashes', async () => {
  const serverWithSlash = 'https://sonarqube.io/';
  const serverWithoutSlash = 'https://sonarqube.io';
  const token = 'test-token';

  // Save with trailing slash
  await saveToken(serverWithSlash, token);

  // Should be able to retrieve without trailing slash (normalized)
  const retrieved = await getToken(serverWithoutSlash);
  expect(retrieved).toBe(token);

  await purgeAllTokens();
});

it('keychain: delete only specific org token, not all', async () => {
  const server = 'https://sonarcloud.io';

  await saveToken(server, 'token-org1', 'org1');
  await saveToken(server, 'token-org2', 'org2');

  // Delete only org1
  await deleteToken(server, 'org1');

  expect(await getToken(server, 'org1')).toBe(null);
  expect(await getToken(server, 'org2')).toBe('token-org2');

  await purgeAllTokens();
});

it('keychain: handle special characters in org names', async () => {
  const server = 'https://sonarcloud.io';
  const org = 'my-org_with.special-chars';
  const token = 'token-special';

  await saveToken(server, token, org);
  const retrieved = await getToken(server, org);

  expect(retrieved).toBe(token);

  await purgeAllTokens();
});

it('keychain: multiple servers with same org key', async () => {
  const org = 'my-org';
  const token1 = 'token-sc';
  const token2 = 'token-sq';

  await saveToken('https://sonarcloud.io', token1, org);
  await saveToken('https://sonarqube.io', token2); // SonarQube doesn't use org

  const retrieved1 = await getToken('https://sonarcloud.io', org);
  const retrieved2 = await getToken('https://sonarqube.io');

  expect(retrieved1).toBe(token1);
  expect(retrieved2).toBe(token2);

  await purgeAllTokens();
});

it('keychain: org parameter is optional for SonarQube', async () => {
  const server = 'https://sonarqube.io';
  const token = 'sq-token';

  // Should be able to save without org
  await saveToken(server, token);
  await saveToken(server, token, undefined);

  const retrieved1 = await getToken(server);
  const retrieved2 = await getToken(server, undefined);

  expect(retrieved1).toBe(token);
  expect(retrieved2).toBe(token);

  await purgeAllTokens();
});

it('auth: keychain account key format for SonarCloud is "hostname:org"', async () => {
  const server = 'https://sonarcloud.io';
  const org = 'my-org';
  const token = 'token123';

  await saveToken(server, token, org);

  const credentials = await getAllCredentials();
  const sonarCloudCreds = credentials.filter(c => c.account.includes('sonarcloud.io'));

  expect(sonarCloudCreds.some(c => c.account === 'sonarcloud.io:my-org')).toBe(true);

  await purgeAllTokens();
});

it('auth: keychain account key format for SonarQube is "hostname" only', async () => {
  const server = 'https://my-sonarqube.io';
  const token = 'token123';

  await saveToken(server, token);

  const credentials = await getAllCredentials();
  const sonarQubeCreds = credentials.filter(c => c.account === 'my-sonarqube.io');

  expect(sonarQubeCreds.length).toBe(1);
  expect(sonarQubeCreds[0].account === 'my-sonarqube.io').toBe(true);

  await purgeAllTokens();
});

it('auth: multiple organizations on SonarCloud have separate tokens', async () => {
  const server = 'https://sonarcloud.io';

  await saveToken(server, 'token-for-org-alpha', 'org-alpha');
  await saveToken(server, 'token-for-org-beta', 'org-beta');
  await saveToken(server, 'token-for-org-gamma', 'org-gamma');

  const allCreds = await getAllCredentials();
  expect(allCreds.length).toBe(TOKEN_COUNT);

  expect(await getToken(server, 'org-alpha')).toBe('token-for-org-alpha');
  expect(await getToken(server, 'org-beta')).toBe('token-for-org-beta');
  expect(await getToken(server, 'org-gamma')).toBe('token-for-org-gamma');

  await purgeAllTokens();
});

it('auth: deleting one org token does not affect others', async () => {
  const server = 'https://sonarcloud.io';

  await saveToken(server, 'token-org1', 'org1');
  await saveToken(server, 'token-org2', 'org2');

  // Delete org1
  await deleteToken(server, 'org1');

  expect(await getToken(server, 'org1')).toBe(null);
  expect(await getToken(server, 'org2')).toBe('token-org2');

  const remaining = await getAllCredentials();
  expect(remaining.length).toBe(1);
  expect(remaining[0].account).toBe('sonarcloud.io:org2');

  await purgeAllTokens();
});

it('auth: can have multiple SonarQube servers with different tokens', async () => {
  const server1 = 'https://sonarqube1.io';
  const server2 = 'https://sonarqube2.io';
  const server3 = 'https://sonarqube3.io';

  await saveToken(server1, 'token-server1');
  await saveToken(server2, 'token-server2');
  await saveToken(server3, 'token-server3');

  const allCreds = await getAllCredentials();
  expect(allCreds.length).toBe(TOKEN_COUNT);

  expect(await getToken(server1)).toBe('token-server1');
  expect(await getToken(server2)).toBe('token-server2');
  expect(await getToken(server3)).toBe('token-server3');

  await purgeAllTokens();
});

it('auth: mixed SonarCloud orgs and SonarQube servers', async () => {
  const sonarcloud = 'https://sonarcloud.io';
  const sonarqube1 = 'https://sq1.io';
  const sonarqube2 = 'https://sq2.io';

  await saveToken(sonarcloud, 'sc-token-org1', 'org1');
  await saveToken(sonarcloud, 'sc-token-org2', 'org2');
  await saveToken(sonarqube1, 'sq-token-1');
  await saveToken(sonarqube2, 'sq-token-2');

  const allCreds = await getAllCredentials();
  expect(allCreds.length).toBe(4);

  // Verify all can be retrieved
  expect(await getToken(sonarcloud, 'org1')).toBe('sc-token-org1');
  expect(await getToken(sonarcloud, 'org2')).toBe('sc-token-org2');
  expect(await getToken(sonarqube1)).toBe('sq-token-1');
  expect(await getToken(sonarqube2)).toBe('sq-token-2');

  // Purge all and verify empty
  await purgeAllTokens();
  const afterPurge = await getAllCredentials();
  expect(afterPurge.length).toBe(0);
});

it('auth: purgeAllTokens with mixed credentials', async () => {
  const sonarcloud = 'https://sonarcloud.io';
  const sonarqube = 'https://sonarqube.io';

  // Add multiple tokens
  await saveToken(sonarcloud, 'sc-token-a', 'org-a');
  await saveToken(sonarcloud, 'sc-token-b', 'org-b');
  await saveToken(sonarqube, 'sq-token');

  let allCreds = await getAllCredentials();
  expect(allCreds.length).toBe(TOKEN_COUNT);

  // Purge all
  await purgeAllTokens();

  allCreds = await getAllCredentials();
  expect(allCreds.length).toBe(0);

  // Verify can't retrieve anything
  expect(await getToken(sonarcloud, 'org-a')).toBe(null);
  expect(await getToken(sonarcloud, 'org-b')).toBe(null);
  expect(await getToken(sonarqube)).toBe(null);
});

// Regression: embedded server cleanup does not hang process.
// The generateTokenViaBrowser flow must release all resources so the process exits
// gracefully. Verified manually:
//   echo "" | sonar auth login --with-token <token> -s https://sonarcloud.io -o org
//   sonar onboard-agent claude --non-interactive --skip-hooks
// Both must return to prompt immediately.
// Token delivery is tested in auth-helpers.test.ts (generateTokenViaBrowser tests).
