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
import {describe, expect, it} from 'bun:test';
import {spawnSync} from 'bun';
import {join} from 'node:path';

const rootDir = join(import.meta.dir, '../../');
const validateScript = join(rootDir, 'build-scripts/validate-commands.js');

describe('validate-commands.js', () => {
    it('should run without crashing', () => {
        const result = spawnSync(['node', validateScript], {
            cwd: rootDir,
            capture: true
        });

        expect(result.stdout).toBeDefined();
        expect(result.stderr).toBeDefined();
    });

    it('should output validation results', () => {
        const result = spawnSync(['node', validateScript], {
            cwd: rootDir,
            capture: true
        });

        const output = result.stdout.toString();
        expect(output).toContain('🔍 Validating commands');
        expect(output).toContain('Checking spec commands are registered');
        expect(output).toContain('Checking for undeclared commands');
        expect(output).toContain('Checking handler files exist');
        expect(output).toContain('Checking imports');
    });

    it('should report validation results', () => {
        const result = spawnSync(['node', validateScript], {
            cwd: rootDir,
            capture: true
        });

        const output = result.stdout.toString();
        // Should either show success message or error/warning counts
        const hasSuccessMessage = output.includes('All checks passed! Commands match specification.');
        const hasTotalMessage = /Total: \d+ error\(s\), \d+ warning\(s\)/.test(output);

        expect(hasSuccessMessage || hasTotalMessage).toBe(true);
    });

    it('should have consistent format with emojis', () => {
        const result = spawnSync(['node', validateScript], {
            cwd: rootDir,
            capture: true
        });

        const output = result.stdout.toString();
        expect(output).toContain('1️⃣');
        expect(output).toContain('2️⃣');
        expect(output).toContain('3️⃣');
        expect(output).toContain('4️⃣');
    });

    it('should exit with code 0 when implementation matches spec', () => {
        const result = spawnSync(['node', validateScript], {
            cwd: rootDir,
            capture: true
        });

        expect(result.exitCode).toBe(0);
    });
});
