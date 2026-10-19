import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, openSync, writeSync, closeSync, linkSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { RpcCallOptions } from './client.ts';
import type { ArtifactRecord } from '../storage/artifact-repository.ts';

interface ArtifactChunk { artifact: ArtifactRecord; offset: number; data: string }
interface WaitResult { results?: Array<{ requestRef: string; files?: {
  artifacts?: ArtifactRecord[]; exports?: unknown[]; exportError?: { message: string };
} }> }
export async function remoteArtifacts(options: RpcCallOptions, rpc: (method: string, params: unknown) => Promise<unknown>): Promise<unknown> {
  const params = { ...(options.params as Record<string, unknown> ?? {}) };
  // Host paths must never silently become paths on the remote computer.
  if (Array.isArray(params.files) && params.files.length) throw new Error('Remote uploads are not supported; no request was dispatched');
  const download = async (artifactId: string, destination: string, overwrite = false) => {
    const first = await rpc('artifact.read', { clientId: params.clientId ?? 'remote-artifact-delivery', artifactId, offset: 0, length: 65536 }) as ArtifactChunk;
    const artifact = first.artifact;
    if (artifact.artifactId !== artifactId || typeof artifact.sizeBytes !== 'number' || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid remote artifact metadata');
    const outputPath = path.resolve(destination);
    if (existsSync(outputPath) && !overwrite) {
      if (createHash('sha256').update(readFileSync(outputPath)).digest('hex') !== artifact.sha256) throw new Error(`Refusing to replace existing output: ${outputPath}`);
      return { requestOk: true, artifactId, sessionId: artifact.sessionId, generation: artifact.generation, outputPath, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, reused: true };
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    const partial = `${outputPath}.sessionplane-${randomUUID()}.part`;
    const fd = openSync(partial, 'wx', 0o600);
    let closed = false;
    try {
      const hash = createHash('sha256');
      let offset = 0;
      let chunk = first;
      while (offset < artifact.sizeBytes) {
        if (chunk.offset !== offset || chunk.artifact.sha256 !== artifact.sha256 || chunk.artifact.sizeBytes !== artifact.sizeBytes) throw new Error('Remote artifact changed during transfer');
        const bytes = Buffer.from(chunk.data, 'base64');
        if (!bytes.length || bytes.length > 65536 || offset + bytes.length > artifact.sizeBytes) throw new Error('Invalid remote artifact chunk');
        let written = 0;
        while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
        hash.update(bytes); offset += bytes.length;
        if (offset < artifact.sizeBytes) chunk = await rpc('artifact.read', { clientId: params.clientId ?? 'remote-artifact-delivery', artifactId, offset, length: 65536 }) as ArtifactChunk;
      }
      if (hash.digest('hex') !== artifact.sha256) throw new Error('Remote artifact checksum mismatch');
      closeSync(fd); closed = true;
      if (overwrite) renameSync(partial, outputPath); else linkSync(partial, outputPath);
      return { requestOk: true, artifactId, sessionId: artifact.sessionId, generation: artifact.generation, outputPath, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, reused: false };
    } finally { if (!closed) closeSync(fd); rmSync(partial, { force: true }); }
  };
  if (options.method === 'artifact.export') {
    if (typeof params.artifactId !== 'string' || typeof params.outputPath !== 'string') throw new Error('Artifact export requires artifactId and outputPath');
    return await download(params.artifactId, params.outputPath, params.overwrite === true);
  }
  const outputDir = options.method === 'workflow.wait' ? params.outputDir : undefined;
  if (outputDir !== undefined && typeof outputDir !== 'string') throw new Error('outputDir must be a local directory path');
  if (outputDir !== undefined) delete params.outputDir;
  const result = await rpc(options.method, params) as WaitResult;
  if (outputDir !== undefined && Array.isArray(result.results)) {
    for (const request of result.results) {
      if (!request.files?.artifacts) continue;
      try {
        if (!/^[a-f0-9-]{36}$/i.test(request.requestRef)) throw new Error('Invalid remote request identity');
        request.files.exports = [];
        for (const artifact of request.files.artifacts) {
          if (artifact.artifactState !== 'downloaded') continue;
          if (!/^[a-f0-9-]{36}$/i.test(artifact.artifactId) || typeof artifact.name !== 'string' || !path.basename(artifact.name) || ['.', '..'].includes(path.basename(artifact.name))) throw new Error('Invalid remote artifact name');
          request.files.exports.push(await download(artifact.artifactId, path.join(outputDir, request.requestRef, artifact.artifactId, path.basename(artifact.name))));
        }
      } catch (error) { request.files.exportError = { message: error instanceof Error ? error.message : String(error) }; }
    }
  }
  return result;
}
