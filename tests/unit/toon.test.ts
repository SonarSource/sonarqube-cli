// TOON formatter tests using official @toon-format/toon library

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { encodeToToon } from '../../src/formatter/toon.js';

test('toon: primitives', () => {
  assert.equal(encodeToToon(null), 'null');
  assert.equal(encodeToToon(true), 'true');
  assert.equal(encodeToToon(false), 'false');
  assert.equal(encodeToToon(0), '0');
  assert.equal(encodeToToon(42), '42');
  assert.equal(encodeToToon(-17), '-17');
  assert.equal(encodeToToon(3.14), '3.14');
});

test('toon: strings', () => {
  // Simple strings (no quotes needed)
  assert.equal(encodeToToon('hello'), 'hello');

  // Empty string needs quotes
  assert.equal(encodeToToon(''), '""');

  // String with spaces - official library doesn't add quotes unless necessary
  const withSpaces = encodeToToon('hello world');
  assert.ok(withSpaces.includes('hello'), 'Should contain hello');
  assert.ok(withSpaces.includes('world'), 'Should contain world');
});

test('toon: strings that look like keywords or numbers', () => {
  // Strings that look like keywords need quotes
  assert.equal(encodeToToon('true'), '"true"');
  assert.equal(encodeToToon('false'), '"false"');
  assert.equal(encodeToToon('null'), '"null"');

  // Strings that look like numbers need quotes
  assert.equal(encodeToToon('123'), '"123"');
});

test('toon: empty object and array', () => {
  // Official library returns empty string for empty objects
  const emptyObj = encodeToToon({});
  assert.ok(emptyObj === '' || emptyObj === '{}', 'Empty object should be empty string or {}');

  // Official library returns '[0]:' for empty arrays (array with 0 elements)
  const emptyArr = encodeToToon([]);
  assert.equal(emptyArr, '[0]:', 'Empty array should be [0]:');
});

test('toon: simple object', () => {
  const obj = { name: 'John', age: 30 };
  const result = encodeToToon(obj);

  // Official format: name: John\nage: 30
  assert.ok(result.includes('name:'), 'Should contain name field');
  assert.ok(result.includes('John'), 'Should contain John value');
  assert.ok(result.includes('age:'), 'Should contain age field');
  assert.ok(result.includes('30'), 'Should contain 30 value');
});

test('toon: nested object', () => {
  const obj = {
    user: {
      name: 'Alice',
      email: 'alice@example.com'
    }
  };

  const result = encodeToToon(obj);

  assert.ok(result.includes('user:'), 'Should have user field');
  assert.ok(result.includes('name:'), 'Should have nested name');
  assert.ok(result.includes('Alice'), 'Should have Alice value');
  assert.ok(result.includes('email:'), 'Should have nested email');
  assert.ok(result.includes('alice@example.com'), 'Should have email value');
});

test('toon: array of primitives (inline format)', () => {
  const arr = [1, 2, 3, 4, 5];
  const result = encodeToToon(arr);

  // Official format: [5]: 1,2,3,4,5
  assert.ok(result.includes('[5]'), 'Should have array length marker');
  assert.ok(result.includes('1'), 'Should contain first element');
  assert.ok(result.includes('5'), 'Should contain last element');
});

test('toon: array of strings (inline format)', () => {
  const arr = ['apple', 'banana', 'cherry'];
  const result = encodeToToon(arr);

  // Official format: [3]: apple,banana,cherry
  assert.ok(result.includes('[3]'), 'Should have array length marker');
  assert.ok(result.includes('apple'), 'Should contain apple');
  assert.ok(result.includes('banana'), 'Should contain banana');
  assert.ok(result.includes('cherry'), 'Should contain cherry');
});

test('toon: tabular array (uniform objects)', () => {
  const arr = [
    { name: 'Alice', age: 30 },
    { name: 'Bob', age: 25 },
    { name: 'Charlie', age: 35 }
  ];

  const result = encodeToToon(arr);

  // Official format uses tabular representation
  // [3]{name,age}:
  //   Alice,30
  //   Bob,25
  //   Charlie,35
  assert.ok(result.includes('[3]'), 'Should have array size marker');
  assert.ok(result.includes('name'), 'Should declare name field');
  assert.ok(result.includes('age'), 'Should declare age field');
  assert.ok(result.includes('Alice'), 'Should have Alice data');
  assert.ok(result.includes('30'), 'Should have Alice age');
  assert.ok(result.includes('Bob'), 'Should have Bob data');
  assert.ok(result.includes('25'), 'Should have Bob age');
  assert.ok(result.includes('Charlie'), 'Should have Charlie data');
  assert.ok(result.includes('35'), 'Should have Charlie age');
});

test('toon: complex nested structure', () => {
  const data = {
    project: 'my-project',
    issues: [
      {
        severity: 'MAJOR',
        rule: 'java:S1234',
        message: 'Issue description'
      },
      {
        severity: 'MINOR',
        rule: 'java:S5678',
        message: 'Another issue'
      }
    ],
    metadata: {
      total: 2,
      timestamp: '2024-01-01'
    }
  };

  const result = encodeToToon(data);

  // Verify all data is present
  assert.ok(result.includes('project:'), 'Should have project field');
  assert.ok(result.includes('my-project'), 'Should have project value');
  assert.ok(result.includes('issues'), 'Should have issues field');
  assert.ok(result.includes('[2]'), 'Should have issues array size');
  assert.ok(result.includes('MAJOR'), 'Should have MAJOR severity');
  assert.ok(result.includes('MINOR'), 'Should have MINOR severity');
  assert.ok(result.includes('java:S1234'), 'Should have first rule');
  assert.ok(result.includes('java:S5678'), 'Should have second rule');
  assert.ok(result.includes('metadata:'), 'Should have metadata field');
  assert.ok(result.includes('total:'), 'Should have total in metadata');
  assert.ok(result.includes('timestamp:'), 'Should have timestamp in metadata');
});

test('toon: SonarQube issues response (real-world example)', () => {
  const response = {
    total: 2,
    issues: [
      {
        key: 'AX123',
        rule: 'java:S1234',
        severity: 'MAJOR',
        component: 'com.example:MyClass.java',
        line: 42,
        message: 'Remove this unused variable',
        status: 'OPEN',
        type: 'CODE_SMELL'
      },
      {
        key: 'AX456',
        rule: 'java:S5678',
        severity: 'CRITICAL',
        component: 'com.example:AnotherClass.java',
        line: 10,
        message: 'Fix this security vulnerability',
        status: 'OPEN',
        type: 'VULNERABILITY'
      }
    ]
  };

  const result = encodeToToon(response);

  // Verify structure and data
  assert.ok(result.includes('total:'), 'Should have total field');
  assert.ok(result.includes('2'), 'Should have total value');
  assert.ok(result.includes('issues'), 'Should have issues field');
  assert.ok(result.includes('[2]'), 'Should have array size');

  // Verify first issue
  assert.ok(result.includes('AX123'), 'Should have first issue key');
  assert.ok(result.includes('java:S1234'), 'Should have first rule');
  assert.ok(result.includes('MAJOR'), 'Should have MAJOR severity');
  assert.ok(result.includes('42'), 'Should have line 42');
  assert.ok(result.includes('Remove this unused variable'), 'Should have first message');

  // Verify second issue
  assert.ok(result.includes('AX456'), 'Should have second issue key');
  assert.ok(result.includes('java:S5678'), 'Should have second rule');
  assert.ok(result.includes('CRITICAL'), 'Should have CRITICAL severity');
  assert.ok(result.includes('10'), 'Should have line 10');
  assert.ok(result.includes('Fix this security vulnerability'), 'Should have second message');
});

test('toon: numbers without trailing zeros', () => {
  // Official library should handle this automatically
  assert.equal(encodeToToon(1.0), '1');
  assert.equal(encodeToToon(2.5), '2.5');
  assert.equal(encodeToToon(100.0), '100');
});

test('toon: special characters in strings', () => {
  const obj = {
    text: 'Line 1\nLine 2\tTabbed',
    quote: 'He said "hello"',
    backslash: 'Path\\to\\file'
  };

  const result = encodeToToon(obj);

  // The official library should handle escaping
  assert.ok(result.length > 0, 'Should produce output');
  assert.ok(result.includes('text:'), 'Should have text field');
  assert.ok(result.includes('quote:'), 'Should have quote field');
  assert.ok(result.includes('backslash:'), 'Should have backslash field');
});

test('toon: encodes and produces valid output', () => {
  // Ensure basic encoding works
  const data = { foo: 'bar', baz: [1, 2, 3] };
  const result = encodeToToon(data);

  assert.ok(typeof result === 'string', 'Should return a string');
  assert.ok(result.length > 0, 'Should not be empty');
  assert.ok(result.includes('foo'), 'Should contain foo field');
  assert.ok(result.includes('bar'), 'Should contain bar value');
  assert.ok(result.includes('baz'), 'Should contain baz field');
});
