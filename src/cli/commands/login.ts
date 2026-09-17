import type { SessionPlaneConfig } from '../../config.ts';
import { callRpc } from '../client.ts';

export async function runLogin(
  config: SessionPlaneConfig,
  url?: string,
): Promise<Readonly<Record<string, unknown>>> {
  return await callRpc({
    socketPath: config.socketPath,
    method: 'browser.login',
    params: url === undefined ? {} : { url },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, config.browserLaunchTimeoutMs + 5_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
}

