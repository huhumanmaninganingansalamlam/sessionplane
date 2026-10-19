import { spawn } from 'node:child_process';
import net from 'node:net';
import { Duplex } from 'node:stream';
import type { RemoteConnection } from '../config.ts';
import type { CliIo } from './format.ts';

export function connectRemote(remote: RemoteConnection): Duplex {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(remote.host)) throw new Error('Invalid SSH host or alias');
  const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
  const command = [remote.executable, 'rpc-stdio', ...(remote.socketPath ? ['--socket', remote.socketPath] : [])]
    .map(quote).join(' ');
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', ...(remote.controlPath ? ['-o', `ControlPath=${remote.controlPath}`] : []), '--', remote.host, command],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
    final(callback) { child.stdin.end(callback); },
    destroy(error, callback) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill(); callback(error);
    },
  });
  child.stdout.on('data', chunk => { if (!stream.push(chunk)) child.stdout.pause(); });
  child.stdin.on('error', error => stream.destroy(error));
  child.stdout.on('error', error => stream.destroy(error));
  let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
  child.once('error', error => stream.destroy(error));
  child.once('exit', (code, signal) => {
    if (code !== 0) stream.destroy(new Error(`SSH remote connection failed (${code ?? signal}): ${diagnostic.trim()}`));
    else stream.push(null);
  });
  return stream;
}

/** A relay only: the existing remote core retains all state and browser ownership. */
export async function runRpcRelay(socketPath: string, io: CliIo): Promise<number> {
  return await new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      io.stdin.unpipe(socket);
      socket.unpipe(io.stdout);
      socket.destroy();
      resolve(code);
    };
    socket.once('connect', () => {
      io.stdout.write(JSON.stringify({ sessionplaneRemote: 1 }) + '\n');
      io.stdin.pipe(socket);
      socket.pipe(io.stdout, { end: false });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      io.stderr.write(`Remote core unavailable: ${error.code ?? 'connection error'}\n`);
      finish(1);
    });
    socket.once('end', () => finish(0));
    io.stdin.once('end', () => socket.end());
    io.stdin.once('close', () => finish(0));
  });
}
