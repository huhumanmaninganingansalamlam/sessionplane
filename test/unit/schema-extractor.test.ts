import assert from 'node:assert/strict';
import test from 'node:test';

import { extractHtmlDocument } from '../../src/fetch/html-extractor.ts';
import {
  assertSupportedSchema,
  extractBySchema,
  SchemaExtractionError,
  validateSchemaValue,
} from '../../src/extract/schema-extractor.ts';

const articleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'year'],
  properties: {
    headline: { type: 'string', minLength: 1 },
    year: { type: 'integer', minimum: 2000 },
  },
} as const;

test('schema extractor accepts exact JSON and rejects missing or extra fields', () => {
  const success = extractBySchema({
    schema: articleSchema,
    json: { headline: 'Primary evidence', year: 2026 },
  });
  assert.equal(success.ok, true);
  assert.equal(success.source, 'json');
  assert.deepEqual(success.data, { headline: 'Primary evidence', year: 2026 });

  const failed = validateSchemaValue(articleSchema, {
    headline: 'Missing year',
    extra: true,
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.ok(failed.issues.some((issue) => issue.code === 'required'));
    assert.ok(failed.issues.some((issue) => issue.code === 'additionalProperties'));
  }
});

test('schema extractor maps JSON-LD and table candidates using the same validator', () => {
  const jsonLdDocument = extractHtmlDocument(
    `<html><head><script type="application/ld+json">
      {"@type":"Article","headline":"JSON-LD evidence","year":2026}
    </script></head><body>body</body></html>`,
    'https://example.com/',
  );
  const jsonLd = extractBySchema({ schema: articleSchema, document: jsonLdDocument });
  assert.equal(jsonLd.ok, true);
  assert.equal(jsonLd.source, 'jsonld');

  const table = extractBySchema({
    schema: {
      type: 'array',
      minItems: 1,
      items: articleSchema,
    },
    html: `<table>
      <tr><th>headline</th><th>year</th></tr>
      <tr><td>Table evidence</td><td>2026</td></tr>
    </table>`,
  });
  assert.equal(table.ok, true);
  assert.equal(table.source, 'table');
  assert.deepEqual(table.data, [{ headline: 'Table evidence', year: 2026 }]);
});

test('schema extraction fails closed when structures cannot satisfy required fields', () => {
  const result = extractBySchema({
    schema: articleSchema,
    html: '<table><tr><th>headline</th></tr><tr><td>No year</td></tr></table>',
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'no_mappable_structure');
  assert.equal(result.data, null);
});

test('unsupported recursive/combinator schema features fail before extraction', () => {
  assert.throws(
    () => assertSupportedSchema({ type: 'object', $ref: '#/$defs/Thing' }),
    (error: unknown) =>
      error instanceof SchemaExtractionError &&
      error.errorCode === 'capability.unsupported-schema',
  );
  assert.throws(
    () => assertSupportedSchema({ type: 'string', anyOf: [{ type: 'string' }] }),
    (error: unknown) =>
      error instanceof SchemaExtractionError &&
      error.errorCode === 'capability.unsupported-schema',
  );
});
