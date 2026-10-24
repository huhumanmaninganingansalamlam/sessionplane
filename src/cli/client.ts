import { workflowWaitOutcome } from '../domain/workflow-wait.ts';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type { JsonRpcResponse } from '../rpc/schemas.ts';
import type { RemoteConnection } from '../config.ts';
import { connectRemote } from './remote.ts';
import { remoteArtifacts } from './remote-artifacts.ts';

export class RpcClientError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = 'RpcClientError';
    this.code = code;
    this.data = data;
  }
}

export interface RpcCallOptions {
  readonly remote?: RemoteConnection | undefined;
  readonly socketPath: string;
  readonly method: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly signal?: AbortSignal;
  readonly collectContinuation?: boolean;
}

export async function callRpc<Result>(options: RpcCallOptions): Promise<Result> {
  const params = options.params as Record<string, unknown> | undefined;
  if (options.method === 'workflow.wait' && params?.untilResult === true && Number(params.waitMs) > 0) {
    // Each core admission remains bounded for a normal handover. Keep routine
    // rounds in this existing client process, including its maintenance reconnect.
    for (;;) {
      const result = await callRpcOnce<{ results: Record<string, unknown>[] }>({ ...options,
        params: { ...params, untilResult: false }, timeoutMs: Number(params.waitMs) + 5_000 });
      if (!Array.isArray(result.results) || result.results.some(workflowWaitOutcome) || options.signal?.aborted) return result as Result;
    }
  }
  const result = await callRpcOnce<Result>(options);
  const continuation = result as Record<string, unknown>;
  if (options.collectContinuation && continuation && typeof continuation === 'object' && continuation.requestOk !== false && continuation.promptSubmitted === true && continuation.terminal !== true &&
      typeof continuation.requestRef === 'string') {
    const collection = await callRpc({ ...options, collectContinuation: false, method: 'workflow.wait',
      params: { teamId: continuation.teamId, requestRefs: [continuation.requestRef], waitMs: 600_000, untilResult: true,
        ...(typeof continuation.followupUserMessageId === 'string' ? { followupUserMessageId: continuation.followupUserMessageId } : {}),
        ...(params?.continuationApproved === true ? { continuationApproved: true } : {}) } });
    return { ...continuation, collection } as Result;
  }
  return result;
}

async function callRpcOnce<Result>(options: RpcCallOptions): Promise<Result> {
  if (options.remote) {
    const connection = { socket: connectRemote(options.remote), ready: false, error: undefined as Error | undefined };
    // Keep one encrypted stream for collection and all file chunks, then release it.
    connection.socket.on('error', error => { connection.error = error; });
    try {
      return await remoteArtifacts(options, (method, params) =>
        callTransport({ ...options, method, params }, connection)) as Result;
    } finally { connection.socket.destroy(); }
  }
  return await callTransport<Result>(options);
}

async function callTransport<Result>(options: RpcCallOptions, connection?: { socket: Duplex; ready: boolean; error: Error | undefined }): Promise<Result> {
  const readWait = ['workflow.wait', 'session.wait', 'team.wait'].includes(options.method) &&
    Number((options.params as { waitMs?: number } | undefined)?.waitMs) > 0;
  let deadline: number | undefined;
  let deferred = false;
  while (true) {
    try { return await callTransportOnce<Result>(options, connection); }
    catch (error) {
      const data = error instanceof RpcClientError ? error.data as { errorCode?: string; details?: { operationStarted?: boolean; requestDispatched?: boolean } } | undefined : undefined;
      if (data?.errorCode === 'core.maintenance' && data.details?.operationStarted === false) {
        deferred = true;
        deadline = Date.now() + (options.timeoutMs ?? 10_000);
      }
      // Commit may close a wait before the client receives maintenance. Reattach
      // only reads with their unchanged identity/cursor; never replay a mutation
      // whose response was lost. Use the existing timeout for this reconnect gap.
      else if (!((deferred || readWait) && data?.errorCode === 'core.unavailable' && data.details?.requestDispatched === false) &&
          !(readWait && data?.errorCode === 'core.connection-lost')) throw error;
      deadline ??= Date.now() + (options.timeoutMs ?? 10_000);
      if (Date.now() >= deadline) throw error;
      await delay(Math.min(250, deadline - Date.now()), undefined, { signal: options.signal });
      if (connection?.socket.destroyed && options.remote) {
        connection.socket = connectRemote(options.remote); connection.ready = false; connection.error = undefined;
        connection.socket.on('error', error => { connection.error = error; });
      }
    }
  }
}

async function callTransportOnce<Result>(options: RpcCallOptions, connection?: { socket: Duplex; ready: boolean; error: Error | undefined }): Promise<Result> {
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxLineBytes = options.maxLineBytes ?? 2 * 1024 * 1024;

  return await new Promise<Result>((resolve, reject) => {
    const socket = connection?.socket ?? net.createConnection(options.socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    let requestDispatched = false;
    const transportError = (errorCode: string, message: string, causeCode?: string) =>
      new RpcClientError(-32000, message, {
        errorCode, details: { requestDispatched, ...(causeCode === undefined ? {} : { causeCode }) },
      });

    const finish = (operation: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      if (!connection) socket.destroy();
      operation();
    };

    const onAbort = (): void => {
      finish(() => reject(new Error('RPC request was cancelled')));
    };

    const timer = setTimeout(() => {
      finish(() => reject(transportError('core.timeout',
        `Core response timed out after ${timeoutMs}ms; a dispatched request may still be running. Recover the same request identity before another mutation.`)));
    }, timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const dispatch = () => {
      requestDispatched = true;
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: options.method,
        params: options.params ?? {},
      })}\n`);
    };
    let ready = !connection || connection.ready;

    const onData = (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        finish(() => reject(new Error('RPC response line exceeded configured limit')));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }

      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!ready) {
        try {
          if (JSON.parse(line).sessionplaneRemote !== 1) throw new Error('Unsupported remote relay');
        } catch {
          finish(() => reject(transportError('core.unavailable', 'Remote did not provide a compatible SessionPlane relay')));
          return;
        }
        ready = true;
        if (connection) connection.ready = true;
        dispatch();
        return;
      }
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch (error) {
        finish(() => reject(new Error('RPC server returned malformed JSON', { cause: error })));
        return;
      }

      if (response.id !== id) {
        finish(() => reject(new Error('RPC response id did not match request id')));
        return;
      }
      if ('error' in response) {
        finish(() => reject(new RpcClientError(response.error.code, response.error.message, response.error.data)));
        return;
      }
      finish(() => resolve(response.result as Result));
    };

    const onError = (error: NodeJS.ErrnoException) => finish(() => reject(transportError(
      requestDispatched ? 'core.connection-lost' : 'core.unavailable', error.message, error.code,
    )));
    const onEnd = () => finish(() => reject(transportError(requestDispatched ? 'core.connection-lost' : 'core.unavailable',
      'Core connection closed before responding; recover the same request identity before another mutation.')));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
    if (options.signal?.aborted) onAbort();
    else if (connection?.error) onError(connection.error);
    else if (connection?.socket.destroyed) onEnd();
    else if (connection?.ready) dispatch();
    else if (!connection) socket.once('connect', dispatch);
  });
}
