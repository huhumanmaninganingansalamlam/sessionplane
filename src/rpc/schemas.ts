import { z } from 'zod';

export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema.optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse =
  | {
      readonly jsonrpc: '2.0';
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: '2.0';
      readonly id: JsonRpcId;
      readonly error: JsonRpcErrorObject;
    };

export function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcErrorObject = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}

