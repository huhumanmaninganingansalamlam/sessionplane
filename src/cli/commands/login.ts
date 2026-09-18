import type { SessionPlaneConfig } from '../../config.ts';
import { callRpc } from '../client.ts';

export type LoginMode = 'automated' | 'manual' | 'resume';

export async function runLogin(
  config: SessionPlaneConfig,
  options: {
    readonly url?: string;
    readonly mode?: LoginMode;
  } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const mode = options.mode ?? 'automated';
  return await callRpc({
    socketPath: config.socketPath,
    method: 'browser.login',
    params: {
      mode,
      ...(options.url === undefined ? {} : { url: options.url }),
    },
    timeoutMs: Math.max(
      config.rpcRequestTimeoutMs,
      config.browserLaunchTimeoutMs * 2 + 10_000,
    ),
    maxLineBytes: config.rpcMaxLineBytes,
  });
}

