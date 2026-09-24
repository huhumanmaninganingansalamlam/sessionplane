import type { ZodType } from 'zod';

import { SessionPlaneDomainError } from '../domain/errors.ts';

import {
  JsonRpcRequestSchema,
  rpcError,
  rpcSuccess,
  type JsonRpcResponse,
} from './schemas.ts';

type RpcHandler<Params> = (params: Params) => unknown | Promise<unknown>;

interface RegisteredMethod {
  readonly paramsSchema: ZodType<unknown>;
  readonly handler: RpcHandler<unknown>;
}

export class RpcMethodError extends Error {
  readonly rpcCode: number;
  readonly errorCode: string;
  readonly details: unknown;

  constructor(
    errorCode: string,
    message: string,
    options: { readonly rpcCode?: number; readonly details?: unknown } = {},
  ) {
    super(message);
    this.name = 'RpcMethodError';
    this.rpcCode = options.rpcCode ?? -32000;
    this.errorCode = errorCode;
    this.details = options.details;
  }
}

export class RpcRouter {
  readonly #methods = new Map<string, RegisteredMethod>();

  register<Params>(method: string, paramsSchema: ZodType<Params>, handler: RpcHandler<Params>): void {
    if (this.#methods.has(method)) {
      throw new Error(`RPC method already registered: ${method}`);
    }
    this.#methods.set(method, {
      paramsSchema: paramsSchema as ZodType<unknown>,
      handler: handler as RpcHandler<unknown>,
    });
  }

  async dispatch(input: unknown): Promise<JsonRpcResponse | null> {
    const requestResult = JsonRpcRequestSchema.safeParse(input);
    if (!requestResult.success) {
      return rpcError(null, -32600, 'Invalid Request', {
        errorCode: 'input.invalid',
        issues: requestResult.error.issues,
      });
    }

    const request = requestResult.data;
    const method = this.#methods.get(request.method);
    if (method === undefined) {
      return request.id === undefined
        ? null
        : rpcError(request.id, -32601, 'Method not found', {
            errorCode: 'input.invalid',
            method: request.method,
          });
    }

    const paramsResult = method.paramsSchema.safeParse(request.params ?? {});
    if (!paramsResult.success) {
      return request.id === undefined
        ? null
        : rpcError(request.id, -32602, 'Invalid params', {
            errorCode: 'input.invalid',
            issues: paramsResult.error.issues,
          });
    }

    try {
      const result = await method.handler(paramsResult.data);
      return request.id === undefined ? null : rpcSuccess(request.id, result);
    } catch (error) {
      if (request.id === undefined) {
        return null;
      }
      if (error instanceof RpcMethodError || error instanceof SessionPlaneDomainError) {
        return rpcError(
          request.id,
          error instanceof RpcMethodError ? error.rpcCode : -32000,
          error.message,
          { errorCode: error.errorCode, details: error.details },
        );
      }
      return rpcError(request.id, -32603, 'Internal error', {
        errorCode: 'internal.invariant-violation',
      });
    }
  }
}

