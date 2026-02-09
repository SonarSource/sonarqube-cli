// TOON formatter using official @toon-format/toon library
// https://toonformat.dev

import { encode } from '@toon-format/toon';

/**
 * Encode a value to TOON format using official @toon-format/toon library
 *
 * TOON (Token-Oriented Object Notation) is a compact, human-readable encoding
 * designed for LLM prompts. It achieves 74% accuracy (vs JSON's 70%) while
 * using ~40% fewer tokens.
 *
 * @param value - The value to encode (any JSON-compatible value)
 * @returns TOON-formatted string
 *
 * @example
 * ```typescript
 * const data = {
 *   issues: [
 *     { severity: "MAJOR", rule: "java:S1234", message: "Test issue", line: 42 }
 *   ],
 *   total: 1
 * };
 *
 * const toon = encodeToToon(data);
 * // Output:
 * // issues[1]{severity,rule,message,line}:
 * //   MAJOR,"java:S1234",Test issue,42
 * // total: 1
 * ```
 */
export function encodeToToon(value: any): string {
  return encode(value);
}

