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
 * You should have received a copy of the GNU Lesser General Public
 * License along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const property = (name: string) =>
  args.find((arg) => arg.startsWith(`-D${name}=`))?.slice(name.length + 3);
if (args.includes('--version')) {
  const home = property('scanner.home');
  const external = !home || home === process.env.ONBOARD_STUB_SCANNER_HOME;
  const version = external
    ? (process.env.ONBOARD_STUB_SCANNER_VERSION ?? '8.1.0.6389')
    : '8.1.0.6389';
  console.log(`SonarScanner CLI ${version}`);
  process.exit(
    Number(
      (!home ? process.env.ONBOARD_STUB_PATH_VERSION_EXIT_CODE : undefined) ??
        process.env.ONBOARD_STUB_VERSION_EXIT_CODE ??
        0,
    ),
  );
}
const dumpPath = property('sonar.scanner.internal.dumpToFile');
if (args.includes('-importcert')) {
  const at = args.indexOf('-keystore');
  const path = args[at + 1];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'test truststore', { mode: 0o600 });
  process.exit(0);
}
if (dumpPath) {
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  writeFileSync(
    dumpPath,
    [
      `scanner.home=${escape(process.env.ONBOARD_STUB_SCANNER_HOME ?? '')}`,
      `java.home=${escape(process.env.ONBOARD_STUB_JAVA_HOME ?? '')}`,
      `java.class.path=${escape(process.env.ONBOARD_STUB_SCANNER_CLASSPATH ?? '')}`,
    ].join('\n'),
  );
  process.exit(0);
}
if (process.env.ONBOARD_STUB_LOG_PATH) {
  appendFileSync(
    process.env.ONBOARD_STUB_LOG_PATH,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      token: process.env.SONAR_TOKEN,
      network: {
        proxyHost: process.env.SONAR_SCANNER_PROXY_HOST,
        proxyPort: process.env.SONAR_SCANNER_PROXY_PORT,
        proxyUser: process.env.SONAR_SCANNER_PROXY_USER,
        proxyPassword: process.env.SONAR_SCANNER_PROXY_PASSWORD,
        truststore: process.env.SONAR_SCANNER_TRUSTSTORE_PATH,
        keystore: process.env.SONAR_SCANNER_KEYSTORE_PATH,
      },
    }) + '\n',
  );
}
if (process.env.ONBOARD_STUB_SLEEP_MS) await Bun.sleep(Number(process.env.ONBOARD_STUB_SLEEP_MS));
if (process.env.ONBOARD_STUB_STREAMING === 'true') {
  console.log('SCANNER-FIRST');
  await Bun.sleep(400);
  const token = process.env.SONAR_TOKEN ?? '';
  process.stdout.write(token.slice(0, 8));
  await Bun.sleep(50);
  process.stdout.write(token.slice(8) + '\n');
  console.error('SCANNER-STDERR');
  await Bun.sleep(400);
  console.log('SCANNER-LAST');
}
if (process.env.ONBOARD_STUB_STDOUT) console.log(process.env.ONBOARD_STUB_STDOUT);
if (process.env.ONBOARD_STUB_STDERR) console.error(process.env.ONBOARD_STUB_STDERR);
const exitCode = Number(process.env.ONBOARD_STUB_EXIT_CODE ?? 0);
if (exitCode !== 0) process.exit(exitCode);
const reportPath = property('sonar.scanner.metadataFilePath');
if (reportPath && process.env.ONBOARD_STUB_SKIP_REPORT !== 'true') {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `projectKey=${process.env.ONBOARD_STUB_REPORT_PROJECT ?? property('sonar.projectKey')}\nceTaskId=onboard-task\n`,
  );
}
