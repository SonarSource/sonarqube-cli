import { decryptKey, readPrivateKey, createMessage, sign as pgpSign } from 'openpgp';
import { createReadStream, writeFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';

async function signFile(filePath, privateKeyArmored, passphrase) {
  const stream = Readable.toWeb(createReadStream(filePath));
  const privateKey = await decryptKey({
    privateKey: await readPrivateKey({ armoredKey: privateKeyArmored }),
    passphrase,
  });
  const message = await createMessage({ binary: stream });
  const signature = await pgpSign({ message, signingKeys: privateKey, detached: true });
  writeFileSync(`${filePath}.asc`, signature.toString(), 'ascii');
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
  console.error('Usage: node scripts/sign.mjs <file-path>');
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

signFile(filePath, privateKeyArmored, passphrase).catch(err => {
  console.error(`Signing failed: ${err.message}`);
  process.exit(1);
});
