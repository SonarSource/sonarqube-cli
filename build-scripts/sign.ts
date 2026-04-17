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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { createMessage, decryptKey, readPrivateKey, sign as pgpSign } from 'openpgp';

async function signFile(
  filePath: string,
  privateKeyArmored: string,
  passphrase: string,
): Promise<void> {
  const binary = new Uint8Array(readFileSync(filePath));
  const privateKey = await decryptKey({
    privateKey: await readPrivateKey({ armoredKey: privateKeyArmored }),
    passphrase,
  });
  const message = await createMessage({ binary });
  const signature = (await pgpSign({
    message,
    signingKeys: privateKey,
    detached: true,
    format: 'armored',
  })) as string;
  writeFileSync(`${filePath}.asc`, signature, 'ascii');
  console.log(`Signed: ${filePath} -> ${filePath}.asc`);
}

const privateKeyArmored = process.env.GPG_SIGNING_KEY;
const passphrase = process.env.GPG_SIGNING_PASSPHRASE;
const filePath = process.argv[2];

if (!privateKeyArmored || !passphrase) {
  console.error('Error: GPG_SIGNING_KEY and GPG_SIGNING_PASSPHRASE env vars must be set');
  process.exit(1);
}

if (!filePath) {
  console.error('Usage: bun build-scripts/sign.ts <file-path>');
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

signFile(filePath, privateKeyArmored, passphrase).catch((err: unknown) => {
  console.error(`Signing failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
