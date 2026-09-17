import type { ExtractedDocument } from '../fetch/html-extractor.ts';

export type SupportedSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

export interface ExtractionSchema {
  readonly type: SupportedSchemaType;
  readonly properties?: Readonly<Record<string, ExtractionSchema>>;
  readonly required?: readonly string[];
  readonly items?: ExtractionSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly additionalProperties?: boolean;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ExtractionIssue {
  readonly path: string;
  readonly code: string;
  readonly detail: string;
}

export interface SchemaExtractionResult {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-schema-extraction-v1';
  readonly ok: boolean;
  readonly verdict: 'extracted' | 'no_mappable_structure';
  readonly data: unknown;
  readonly source: 'json' | 'jsonld' | 'table' | 'none';
  readonly candidatesConsidered: number;
  readonly issues: readonly ExtractionIssue[];
}

export interface SchemaExtractionInput {
  readonly schema: unknown;
  readonly json?: unknown;
  readonly document?: ExtractedDocument | null;
  readonly html?: string | null;
  readonly sourceMode?: 'auto' | 'json' | 'jsonld' | 'table';
}

export class SchemaExtractionError extends Error {
  readonly errorCode: string;
  readonly details: unknown;

  constructor(errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SchemaExtractionError';
    this.errorCode = errorCode;
    this.details = details;
  }
}

interface TableCandidate {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function extractBySchema(input: SchemaExtractionInput): SchemaExtractionResult {
  const schema = assertSupportedSchema(input.schema);
  const sourceMode = input.sourceMode ?? 'auto';
  const issues: ExtractionIssue[] = [];
  let candidatesConsidered = 0;

  if ((sourceMode === 'auto' || sourceMode === 'json') && input.json !== undefined) {
    candidatesConsidered += 1;
    const validated = validateSchemaValue(schema, input.json);
    if (validated.ok) return success(validated.data, 'json', candidatesConsidered);
    issues.push(...validated.issues.map((issue) => ({ ...issue, code: `json.${issue.code}` })));
  }

  if (sourceMode === 'auto' || sourceMode === 'jsonld') {
    for (const candidate of flattenJsonLd(input.document?.jsonLd ?? [])) {
      candidatesConsidered += 1;
      const validated = validateSchemaValue(schema, projectCandidate(schema, candidate));
      if (validated.ok) return success(validated.data, 'jsonld', candidatesConsidered);
      issues.push({
        path: '$',
        code: 'jsonld.rejected',
        detail: validated.issues[0]?.detail ?? 'JSON-LD candidate did not match the schema',
      });
    }
  }

  if (sourceMode === 'auto' || sourceMode === 'table') {
    for (const table of extractTables(input.html ?? input.document?.html ?? '')) {
      candidatesConsidered += 1;
      const mapped = mapTable(schema, table);
      if (mapped === null) continue;
      const validated = validateSchemaValue(schema, mapped);
      if (validated.ok) return success(validated.data, 'table', candidatesConsidered);
      issues.push({
        path: '$',
        code: 'table.rejected',
        detail: validated.issues[0]?.detail ?? 'Table candidate did not match the schema',
      });
    }
  }

  if (candidatesConsidered === 0) {
    issues.push({
      path: '$',
      code: 'structure.none',
      detail: `No ${sourceMode === 'auto' ? 'JSON, JSON-LD, or table' : sourceMode} candidate was available`,
    });
  }
  return Object.freeze({
    requestOk: true,
    schemaVersion: 'sessionplane-schema-extraction-v1',
    ok: false,
    verdict: 'no_mappable_structure',
    data: null,
    source: 'none',
    candidatesConsidered,
    issues: Object.freeze(issues.slice(0, 200)),
  });
}

export function assertSupportedSchema(value: unknown): ExtractionSchema {
  validateSchemaShape(value, '$', 0);
  return value as ExtractionSchema;
}

export function validateSchemaValue(
  schema: ExtractionSchema,
  value: unknown,
): { readonly ok: true; readonly data: unknown } | {
  readonly ok: false;
  readonly issues: readonly ExtractionIssue[];
} {
  const issues: ExtractionIssue[] = [];
  const data = validateValue(schema, value, '$', issues, 0);
  return issues.length === 0
    ? { ok: true, data }
    : { ok: false, issues: Object.freeze(issues.slice(0, 200)) };
}

function success(
  data: unknown,
  source: 'json' | 'jsonld' | 'table',
  candidatesConsidered: number,
): SchemaExtractionResult {
  return Object.freeze({
    requestOk: true,
    schemaVersion: 'sessionplane-schema-extraction-v1',
    ok: true,
    verdict: 'extracted',
    data,
    source,
    candidatesConsidered,
    issues: Object.freeze([]),
  });
}

function validateSchemaShape(value: unknown, path: string, depth: number): void {
  if (depth > 20) throw unsupported(path, 'Schema nesting exceeds 20 levels');
  if (!isRecord(value)) throw invalid(path, 'Schema must be an object');
  for (const key of Object.keys(value)) {
    if (['$ref', '$defs', 'definitions', 'oneOf', 'anyOf', 'allOf', 'not', 'patternProperties'].includes(key)) {
      throw unsupported(`${path}.${key}`, `Schema keyword ${key} is not supported`);
    }
  }
  const type = value.type;
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) {
    throw invalid(`${path}.type`, 'Schema type must be one supported scalar, object, or array type');
  }
  if (type === 'object') {
    const properties = value.properties;
    if (properties !== undefined && !isRecord(properties)) {
      throw invalid(`${path}.properties`, 'Object properties must be an object');
    }
    if (isRecord(properties)) {
      if (Object.keys(properties).length > 200) throw unsupported(path, 'Schema has more than 200 properties');
      for (const [key, child] of Object.entries(properties)) {
        validateSchemaShape(child, `${path}.properties.${key}`, depth + 1);
      }
    }
    if (value.required !== undefined && !isStringArray(value.required)) {
      throw invalid(`${path}.required`, 'required must be a string array');
    }
  }
  if (type === 'array') {
    if (value.items === undefined) throw invalid(`${path}.items`, 'Array schema requires items');
    validateSchemaShape(value.items, `${path}.items`, depth + 1);
  }
  if (value.enum !== undefined && !Array.isArray(value.enum)) {
    throw invalid(`${path}.enum`, 'enum must be an array');
  }
}

function validateValue(
  schema: ExtractionSchema,
  value: unknown,
  path: string,
  issues: ExtractionIssue[],
  depth: number,
): unknown {
  if (issues.length >= 200) return value;
  if (depth > 30) {
    issues.push({ path, code: 'depth', detail: 'Value nesting exceeds 30 levels' });
    return value;
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    issues.push({ path, code: 'const', detail: 'Value did not match const' });
    return value;
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(entry, value))) {
    issues.push({ path, code: 'enum', detail: 'Value was not one of the allowed enum values' });
    return value;
  }

  switch (schema.type) {
    case 'null':
      if (value !== null) issues.push(typeIssue(path, 'null'));
      return value;
    case 'string':
      if (typeof value !== 'string') {
        issues.push(typeIssue(path, 'string'));
        return value;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({ path, code: 'minLength', detail: `String is shorter than ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path, code: 'maxLength', detail: `String is longer than ${schema.maxLength}` });
      }
      return value;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
        issues.push(typeIssue(path, schema.type));
        return value;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path, code: 'minimum', detail: `Number is below ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path, code: 'maximum', detail: `Number is above ${schema.maximum}` });
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push(typeIssue(path, 'boolean'));
      return value;
    case 'array':
      return validateArray(schema, value, path, issues, depth);
    case 'object':
      return validateObject(schema, value, path, issues, depth);
  }
}

function validateArray(
  schema: ExtractionSchema,
  value: unknown,
  path: string,
  issues: ExtractionIssue[],
  depth: number,
): unknown {
  if (!Array.isArray(value)) {
    issues.push(typeIssue(path, 'array'));
    return value;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.push({ path, code: 'minItems', detail: `Array has fewer than ${schema.minItems} items` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.push({ path, code: 'maxItems', detail: `Array has more than ${schema.maxItems} items` });
  }
  const itemSchema = schema.items as ExtractionSchema;
  return value.map((entry, index) => validateValue(itemSchema, entry, `${path}[${index}]`, issues, depth + 1));
}

function validateObject(
  schema: ExtractionSchema,
  value: unknown,
  path: string,
  issues: ExtractionIssue[],
  depth: number,
): unknown {
  if (!isRecord(value)) {
    issues.push(typeIssue(path, 'object'));
    return value;
  }
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const result: Record<string, unknown> = {};
  for (const requiredKey of required) {
    if (!(requiredKey in value)) {
      issues.push({
        path: `${path}.${requiredKey}`,
        code: 'required',
        detail: `Required property ${requiredKey} is missing`,
      });
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    const childSchema = properties[key];
    if (childSchema === undefined) {
      if (schema.additionalProperties === false) {
        issues.push({
          path: `${path}.${key}`,
          code: 'additionalProperties',
          detail: `Unexpected property ${key}`,
        });
      } else {
        result[key] = entry;
      }
      continue;
    }
    result[key] = validateValue(childSchema, entry, `${path}.${key}`, issues, depth + 1);
  }
  return result;
}

function projectCandidate(schema: ExtractionSchema, value: unknown): unknown {
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    return value.map((entry) => projectCandidate(schema.items as ExtractionSchema, entry));
  }
  if (schema.type !== 'object' || !isRecord(value) || schema.additionalProperties !== false) {
    return value;
  }
  const projected: Record<string, unknown> = {};
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    const actualKey = Object.keys(value).find((candidate) => normalizeKey(candidate) === normalizeKey(key));
    if (actualKey !== undefined) projected[key] = projectCandidate(childSchema, value[actualKey]);
  }
  return projected;
}

function flattenJsonLd(values: readonly unknown[]): unknown[] {
  const flattened: unknown[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 15 || flattened.length >= 500) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    flattened.push(value);
    if (value['@graph'] !== undefined) visit(value['@graph'], depth + 1);
    if (value.mainEntity !== undefined) visit(value.mainEntity, depth + 1);
    if (value.itemListElement !== undefined) visit(value.itemListElement, depth + 1);
  };
  for (const value of values) visit(value, 0);
  return flattened;
}

function extractTables(html: string): TableCandidate[] {
  if (html.trim() === '') return [];
  const tables: TableCandidate[] = [];
  for (const tableMatch of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (tables.length >= 100) break;
    const rows: string[][] = [];
    let explicitHeaders: string[] = [];
    for (const rowMatch of (tableMatch[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = rowMatch[1] ?? '';
      const headers = [...rowHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) =>
        normalizeCell(match[1] ?? ''),
      );
      const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) =>
        normalizeCell(match[1] ?? ''),
      );
      if (headers.length > 0 && explicitHeaders.length === 0) explicitHeaders = headers;
      else if (cells.length > 0) rows.push(cells);
    }
    let headers = explicitHeaders;
    let dataRows = rows;
    if (headers.length === 0 && rows.length > 1) {
      headers = rows[0] ?? [];
      dataRows = rows.slice(1);
    }
    if (headers.length > 0 && dataRows.length > 0) tables.push({ headers, rows: dataRows });
  }
  return tables;
}

function mapTable(schema: ExtractionSchema, table: TableCandidate): unknown | null {
  if (schema.type === 'array' && schema.items?.type === 'object') {
    const rows = tableRowsToObjects(table, schema.items);
    return rows.length === 0 ? null : rows;
  }
  if (schema.type !== 'object') return null;
  const rows = tableRowsToObjects(table, schema);
  return rows.length === 1 ? rows[0] : null;
}

function tableRowsToObjects(
  table: TableCandidate,
  schema: ExtractionSchema,
): Array<Record<string, unknown>> {
  const mapping = new Map<number, string>();
  table.headers.forEach((header, index) => {
    const property = findProperty(schema, header);
    if (property !== null) mapping.set(index, property);
  });
  const required = schema.required ?? [];
  if (required.some((key) => ![...mapping.values()].includes(key)) || mapping.size === 0) return [];
  return table.rows.map((row) => {
    const object: Record<string, unknown> = {};
    for (const [index, key] of mapping) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema === undefined) continue;
      const value = coerceCell(row[index] ?? '', propertySchema);
      if (value !== undefined) object[key] = value;
    }
    return object;
  });
}

function findProperty(schema: ExtractionSchema, header: string): string | null {
  const normalized = normalizeKey(header);
  for (const key of Object.keys(schema.properties ?? {})) {
    if (normalizeKey(key) === normalized) return key;
  }
  return null;
}

function coerceCell(value: string, schema: ExtractionSchema): unknown {
  const text = value.trim();
  if (text === '') return undefined;
  switch (schema.type) {
    case 'string':
      return text;
    case 'number': {
      const number = Number(text.replaceAll(',', ''));
      return Number.isFinite(number) ? number : undefined;
    }
    case 'integer': {
      const number = Number(text.replaceAll(',', ''));
      return Number.isInteger(number) ? number : undefined;
    }
    case 'boolean':
      if (/^(true|yes|y|1)$/i.test(text)) return true;
      if (/^(false|no|n|0)$/i.test(text)) return false;
      return undefined;
    case 'null':
      return /^(null|none|n\/a)$/i.test(text) ? null : undefined;
    case 'array':
    case 'object':
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
  }
}

function normalizeCell(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function typeIssue(path: string, type: string): ExtractionIssue {
  return { path, code: 'type', detail: `Expected ${type}` };
}

function invalid(path: string, message: string): SchemaExtractionError {
  return new SchemaExtractionError('input.invalid-schema', message, { path });
}

function unsupported(path: string, message: string): SchemaExtractionError {
  return new SchemaExtractionError('capability.unsupported-schema', message, { path });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
