import { randomUUID } from 'node:crypto';
import net from 'node:net';

import type { JsonRpcResponse } from '../rpc/schemas.ts';

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
  readonly socketPath: string;
  readonly method: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly signal?: AbortSignal;
}

export async function callRpc<Result>(options: RpcCallOptions): Promise<Result> {
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxLineBytes = options.maxLineBytes ?? 2 * 1024 * 1024;

  return await new Promise<Result>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
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
      socket.destroy();
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
    if (options.signal?.aborted === true) {
      onAbort();
      return;
    }

    socket.once('connect', () => {
      requestDispatched = true;
      socket.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: options.method,
        params: options.params ?? {},
      })}\n`);
    });

    socket.on('data', (chunk: string) => {
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
    });

    socket.once('error', (error: NodeJS.ErrnoException) => finish(() => reject(transportError(
      requestDispatched ? 'core.connection-lost' : 'core.unavailable', error.message, error.code,
    ))));
    socket.once('end', () => finish(() => reject(transportError('core.connection-lost',
      'Core connection closed before responding; recover the same request identity before another mutation.'))));
  });
}
