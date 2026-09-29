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

import { describe, expect, it } from 'bun:test';

import {
  CONFIG_KEY_BY_NAME,
  CONFIG_KEY_DEFINITIONS,
  type ConfigKeyDefinition,
  isValidConfigValue,
} from '@/core/config/config-schema.ts';

describe('config-schema', () => {
  describe('CONFIG_KEY_DEFINITIONS invariants', () => {
    it('has no duplicate keys', () => {
      const keys = CONFIG_KEY_DEFINITIONS.map((definition) => definition.key);

      expect(new Set(keys).size).toBe(keys.length);
    });

    it('never restricts allowedValues on a sensitive key', () => {
      // Sensitive keys hold secrets (proxy creds, passphrases) which are inherently
      // free-form; a fixed allowedValues list on one would be a modeling mistake.
      const restrictedSensitiveKeys = CONFIG_KEY_DEFINITIONS.filter(
        (definition: ConfigKeyDefinition) =>
          definition.sensitive && definition.allowedValues !== undefined,
      ).map((definition) => definition.key);

      expect(restrictedSensitiveKeys).toEqual([]);
    });

    it('gives every allowedValues list at least two options', () => {
      // A single-value enum is never a real constraint - it signals a copy/paste
      // mistake rather than an intentional restriction.
      const degenerateKeys = CONFIG_KEY_DEFINITIONS.filter(
        (definition: ConfigKeyDefinition) =>
          definition.allowedValues !== undefined && definition.allowedValues.length < 2,
      ).map((definition) => definition.key);

      expect(degenerateKeys).toEqual([]);
    });
  });

  describe('CONFIG_KEY_BY_NAME', () => {
    it('indexes every allowlist entry exactly once', () => {
      expect(CONFIG_KEY_BY_NAME.size).toBe(CONFIG_KEY_DEFINITIONS.length);

      for (const definition of CONFIG_KEY_DEFINITIONS) {
        expect(CONFIG_KEY_BY_NAME.get(definition.key)).toBe(definition);
      }
    });

    it('returns undefined for a key that was never registered', () => {
      expect(CONFIG_KEY_BY_NAME.get('network.proxy.socks' as never)).toBeUndefined();
    });
  });

  describe('isValidConfigValue', () => {
    it('accepts any string, including empty, when allowedValues is omitted', () => {
      const freeform = CONFIG_KEY_BY_NAME.get('network.tls.caCert')!;

      expect(isValidConfigValue(freeform, '')).toBe(true);
      expect(isValidConfigValue(freeform, '/etc/ssl/custom-ca.pem')).toBe(true);
    });

    it('accepts every value in allowedValues and rejects one outside it, for every restricted key', () => {
      const definitions: readonly ConfigKeyDefinition[] = CONFIG_KEY_DEFINITIONS;
      const restricted = definitions.filter(
        (definition): definition is ConfigKeyDefinition & { allowedValues: readonly string[] } =>
          definition.allowedValues !== undefined,
      );

      // Guards against this test silently checking nothing if every key ever became free-form.
      expect(restricted.length).toBeGreaterThan(0);

      for (const definition of restricted) {
        for (const value of definition.allowedValues) {
          expect(isValidConfigValue(definition, value)).toBe(true);
        }
        expect(isValidConfigValue(definition, 'not-a-real-value')).toBe(false);
      }
    });
  });
});
