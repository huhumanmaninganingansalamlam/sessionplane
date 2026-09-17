import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import net, { type Server, type Socket } from 'node:net';

import type { Logger } from '../logging.ts';
import type { RpcRouter } from './router.ts';
import { rpcError, type JsonRpcResponse } from './schemas.ts';

export interface RpcServerOptions {
  readonly socketPath: string;
  readonly maxLineBytes: number;
  readonly router: RpcRouter;
  readonly logger: Logger;
}

export class RpcServer {
  readonly #options: RpcServerOptions;
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;
  #closed = false;

  constructor(options: RpcServerOptions) {
    this.#options = options;
  }

  async listen(): Promise<void> {
    if (this.#server !== null) {
      throw new Error('RPC server is already listening');
    }
    await removeStaleSocket(this.#options.socketPath);

    const server = net.createServer((socket) => this.#handleConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#options.socketPath);
    });

    chmodSync(this.#options.socketPath, 0o600);
    this.#options.logger.info('rpc.server.listening', { socketPath: this.#options.socketPath });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      for (const socket of this.#sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    this.#sockets.clear();

    if (existsSync(this.#options.socketPath) && lstatSync(this.#options.socketPath).isSocket()) {
      unlinkSync(this.#options.socketPath);
    }
    this.#options.logger.info('rpc.server.closed');
  }

  #handleConnection(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let queued = Promise.resolve();

    const forget = (): void => {
      this.#sockets.delete(socket);
    };
    socket.once('close', forget);

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > this.#options.maxLineBytes) {
        writeResponse(socket, rpcError(null, -32600, 'Request line too large', {
          errorCode: 'input.invalid',
        }));
        socket.destroy();
        return;
      }

      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') {
          continue;
        }
        queued = queued.then(() => this.#processLine(socket, line));
      }
    });

    socket.on('error', (error) => {
      this.#options.logger.warn('rpc.connection.error', { message: error.message });
    });
  }

  async #processLine(socket: Socket, line: string): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(line) as unknown;
    } catch {
      writeResponse(socket, rpcError(null, -32700, 'Parse error', {
        errorCode: 'input.invalid',
      }));
      return;
    }

    const response = await this.#options.router.dispatch(input);
    if (response !== null) {
      writeResponse(socket, response);
    }
  }
}

function writeResponse(socket: Socket, response: JsonRpcResponse): void {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(response)}\n`);
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return;
  }
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
  }

  const live = await socketAcceptsConnections(socketPath);
  if (live) {
    throw new Error(`SessionPlane core is already listening at ${socketPath}`);
  }
  unlinkSync(socketPath);
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(!(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
    });
  });
}

