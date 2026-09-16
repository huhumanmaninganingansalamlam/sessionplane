import { RpcClientError } from './client.ts';

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export interface CliErrorShape {
  readonly requestOk: false;
  readonly errorCode: string;
  readonly message: string;
  readonly details?: unknown;
}

export function writeCliResult(io: CliIo, json: boolean, result: unknown): void {
  io.stdout.write(
    json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`,
  );
}

export function writeCliError(io: CliIo, json: boolean, error: unknown): CliErrorShape {
  const shape = normalizeCliError(error);
  io.stderr.write(
    json
      ? `${JSON.stringify(shape)}\n`
      : `${shape.errorCode}: ${shape.message}${
          shape.details === undefined ? '' : `\n${JSON.stringify(shape.details, null, 2)}`
        }\n`,
  );
  return shape;
}

export function normalizeCliError(error: unknown): CliErrorShape {
  if (error instanceof RpcClientError) {
    const data = isRecord(error.data) ? error.data : {};
    return {
      requestOk: false,
      errorCode:
        typeof data.errorCode === 'string'
          ? data.errorCode
          : 'internal.invariant-violation',
      message: error.message,
      ...(data.details === undefined ? {} : { details: data.details }),
    };
  }
  return {
    requestOk: false,
    errorCode: 'input.invalid',
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
