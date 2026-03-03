import { describe, expect, it } from 'bun:test';
import { parseInteger } from '../../src/cli/commands/common/parsing';
import { InvalidArgumentError } from 'commander';

describe('CLI option parsing', () => {
  it('should throw if not a valid number', () => {
    expect(() => parseInteger('x')).toThrow(new InvalidArgumentError('Not a number.'));
  });

  it('should successfully parse a valid number', () => {
    expect(parseInteger('42')).toBe(42);
  });
});
