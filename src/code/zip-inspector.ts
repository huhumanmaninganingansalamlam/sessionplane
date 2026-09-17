import { inflateRawSync } from 'node:zlib';

import { SessionPlaneDomainError } from '../domain/errors.ts';

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly directory: boolean;
}

export interface ZipInspection {
  readonly entries: readonly ZipEntry[];
  readonly files: readonly string[];
  readonly totalUncompressedBytes: number;
  readonly planPath: string | null;
}

export interface ZipInspectionOptions {
  readonly maxEntries?: number;
  readonly maxTotalUncompressedBytes?: number;
  readonly requireRootPlan?: boolean;
}

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

export function inspectZip(
  bytes: Uint8Array,
  options: ZipInspectionOptions = {},
): ZipInspection {
  const buffer = Buffer.from(bytes);
  const maxEntries = options.maxEntries ?? 10_000;
  const maxTotalUncompressedBytes =
    options.maxTotalUncompressedBytes ?? 2 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw invalidZip('ZIP maxEntries must be a positive integer');
  }
  if (
    !Number.isSafeInteger(maxTotalUncompressedBytes) ||
    maxTotalUncompressedBytes <= 0
  ) {
    throw invalidZip('ZIP maxTotalUncompressedBytes must be a positive integer');
  }
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
    throw invalidZip('ZIP local-file signature is missing');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralOffset === 0xffffffff ||
    centralSize === 0xffffffff
  ) {
    throw invalidZip('Multi-disk and ZIP64 archives are not supported');
  }
  if (entryCount === 0 || entryCount > maxEntries) {
    throw invalidZip(`ZIP entry count is outside the allowed range: ${entryCount}`);
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > buffer.length) {
    throw invalidZip('ZIP central directory is outside the archive bounds');
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw invalidZip(`ZIP central entry ${index} is malformed`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length || diskStart !== 0) {
      throw invalidZip(`ZIP central entry ${index} exceeds archive bounds`);
    }
    if ((flags & 0x0001) !== 0) {
      throw invalidZip('Encrypted ZIP entries are not supported');
    }
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    assertSafeZipPath(name);
    if (seen.has(name)) throw invalidZip(`Duplicate ZIP entry: ${name}`);
    seen.add(name);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw invalidZip(`Symbolic links are not allowed in code archives: ${name}`);
    }
    assertLocalEntryBounds(buffer, {
      localHeaderOffset,
      centralOffset,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      name,
    });
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > maxTotalUncompressedBytes) {
      throw invalidZip('ZIP uncompressed size exceeds the configured limit');
    }
    entries.push(Object.freeze({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      directory: name.endsWith('/'),
    }));
    cursor = end;
  }

  return finishInspection(buffer, entries, totalUncompressedBytes, options, centralOffset, centralSize, cursor);
}

export function readZipTextEntry(bytes: Uint8Array, entryName: string): string | null {
  const buffer = Buffer.from(bytes);
  const inspection = inspectZip(buffer);
  const entry = inspection.entries.find((candidate) => candidate.name === entryName);
  if (entry === undefined || entry.directory) return null;
  return readZipEntry(buffer, entry).toString('utf8');
}

function finishInspection(
  buffer: Buffer,
  entries: readonly ZipEntry[],
  totalUncompressedBytes: number,
  options: ZipInspectionOptions,
  centralOffset: number,
  centralSize: number,
  cursor: number,
): ZipInspection {
  if (cursor !== centralOffset + centralSize) {
    throw invalidZip('ZIP central directory size does not match its entries');
  }
  const files = entries.filter((entry) => !entry.directory).map((entry) => entry.name);
  const planEntry = entries.find(
    (entry) =>
      !entry.directory &&
      !entry.name.includes('/') &&
      /^(?:PLAN|00_plan)\.md$/i.test(entry.name),
  );
  if (options.requireRootPlan === true && planEntry === undefined) {
    throw new SessionPlaneDomainError(
      'code-artifact.plan-missing',
      'Code archive must contain PLAN.md or 00_plan.md at the archive root',
    );
  }
  if (planEntry !== undefined) {
    const plan = readZipEntry(buffer, planEntry);
    if (plan.toString('utf8').trim().length === 0) {
      throw new SessionPlaneDomainError(
        'code-artifact.plan-missing',
        `${planEntry.name} is empty`,
      );
    }
  }
  return Object.freeze({
    entries: Object.freeze([...entries]),
    files: Object.freeze(files),
    totalUncompressedBytes,
    planPath: planEntry?.name ?? null,
  });
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 65_535);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
  }
  throw invalidZip('ZIP end-of-central-directory record is missing');
}

function assertLocalEntryBounds(
  buffer: Buffer,
  input: {
    readonly localHeaderOffset: number;
    readonly centralOffset: number;
    readonly flags: number;
    readonly compressionMethod: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly name: string;
  },
): void {
  const {
    localHeaderOffset,
    centralOffset,
    flags,
    compressionMethod,
    compressedSize,
    uncompressedSize,
    name,
  } = input;
  if (
    localHeaderOffset >= centralOffset ||
    localHeaderOffset + 30 > buffer.length ||
    buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE
  ) {
    throw invalidZip(`ZIP local header is missing for ${name}`);
  }
  const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
  const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
  const localCompressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
  const localUncompressedSize = buffer.readUInt32LE(localHeaderOffset + 22);
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const localNameEnd = localHeaderOffset + 30 + nameLength;
  if (localNameEnd > buffer.length) {
    throw invalidZip(`ZIP local name exceeds archive bounds for ${name}`);
  }
  const localName = buffer
    .subarray(localHeaderOffset + 30, localNameEnd)
    .toString((localFlags & 0x0800) !== 0 ? 'utf8' : 'latin1');
  if (localName !== name) {
    throw invalidZip(`ZIP local and central names differ for ${name}`);
  }
  if (localCompressionMethod !== compressionMethod) {
    throw invalidZip(`ZIP local and central compression methods differ for ${name}`);
  }
  if ((localFlags & 0x0809) !== (flags & 0x0809)) {
    throw invalidZip(`ZIP local and central flags differ for ${name}`);
  }
  if (
    (flags & 0x0008) === 0 &&
    (localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)
  ) {
    throw invalidZip(`ZIP local and central sizes differ for ${name}`);
  }
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  if (dataStart + compressedSize > centralOffset || dataStart + compressedSize > buffer.length) {
    throw invalidZip(`ZIP data exceeds archive bounds for ${name}`);
  }
}

function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const payload = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  let result: Buffer;
  if (entry.compressionMethod === 0) {
    result = Buffer.from(payload);
  } else if (entry.compressionMethod === 8) {
    try {
      result = inflateRawSync(payload, {
        maxOutputLength: entry.uncompressedSize + 1,
      });
    } catch (error) {
      throw invalidZip(`ZIP entry could not be inflated: ${entry.name}`, error);
    }
  } else {
    throw invalidZip(
      `ZIP compression method ${entry.compressionMethod} is unsupported for ${entry.name}`,
    );
  }
  if (result.length !== entry.uncompressedSize) {
    throw invalidZip(`ZIP uncompressed size mismatch for ${entry.name}`);
  }
  return result;
}

function assertSafeZipPath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes('\u0000') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    throw invalidZip(`Unsafe ZIP path: ${JSON.stringify(value)}`);
  }
  const components = value.endsWith('/') ? value.slice(0, -1).split('/') : value.split('/');
  if (
    components.length === 0 ||
    components.some(
      (component) => component === '' || component === '..' || component === '.',
    )
  ) {
    throw invalidZip(`Unsafe ZIP path traversal: ${value}`);
  }
}

function invalidZip(message: string, cause?: unknown): SessionPlaneDomainError {
  return new SessionPlaneDomainError('code-artifact.invalid-zip', message, cause);
}
