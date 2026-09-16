import { z } from 'zod';

import { SESSIONPLANE_VERSION } from '../config.ts';

export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28';
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
] as const;

export const MCP_SERVER_INFO = Object.freeze({
  name: 'sessionplane',
  version: SESSIONPLANE_VERSION,
});

export const McpRequestIdSchema = z.union([z.string(), z.number(), z.null()]);

export const McpRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: McpRequestIdSchema.optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

export type McpRequestId = z.infer<typeof McpRequestIdSchema>;
export type McpRequest = z.infer<typeof McpRequestSchema>;

export type McpResponse =
  | {
      readonly jsonrpc: '2.0';
      readonly id: McpRequestId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: '2.0';
      readonly id: McpRequestId;
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    };

export interface ModernRequestMetadata {
  readonly protocolVersion: string;
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  readonly clientInfo: Readonly<Record<string, unknown>> | null;
}

export class McpProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    this.data = data;
  }
}

export function parseMcpRequest(input: unknown): McpRequest {
  const parsed = McpRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new McpProtocolError(-32600, 'Invalid Request', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export function requireModernMetadata(params: unknown): ModernRequestMetadata {
  if (!isRecord(params) || !isRecord(params._meta)) {
    throw new McpProtocolError(-32602, 'Missing MCP request metadata', {
      errorCode: 'input.invalid',
      required: [
        'io.modelcontextprotocol/protocolVersion',
        'io.modelcontextprotocol/clientCapabilities',
      ],
    });
  }
  const protocolVersion = params._meta['io.modelcontextprotocol/protocolVersion'];
  const clientCapabilities = params._meta['io.modelcontextprotocol/clientCapabilities'];
  const clientInfo = params._meta['io.modelcontextprotocol/clientInfo'];
  if (typeof protocolVersion !== 'string' || !isRecord(clientCapabilities)) {
    throw new McpProtocolError(-32602, 'Invalid MCP request metadata', {
      errorCode: 'input.invalid',
    });
  }
  if (protocolVersion !== MCP_MODERN_PROTOCOL_VERSION) {
    throw new McpProtocolError(-32001, 'Unsupported MCP protocol version', {
      errorCode: 'input.unsupported-protocol-version',
      requested: protocolVersion,
      supported: [MCP_MODERN_PROTOCOL_VERSION],
    });
  }
  if (clientInfo !== undefined && !isRecord(clientInfo)) {
    throw new McpProtocolError(-32602, 'Invalid MCP clientInfo metadata', {
      errorCode: 'input.invalid',
    });
  }
  return {
    protocolVersion,
    clientCapabilities,
    clientInfo: isRecord(clientInfo) ? clientInfo : null,
  };
}

export function stripProtocolMetadata(params: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(params)) {
    return {};
  }
  const { _meta: _ignored, ...rest } = params;
  return rest;
}

export function modernResult(
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    resultType: 'complete',
    ...result,
    _meta: {
      ...(isRecord(result._meta) ? result._meta : {}),
      'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO,
    },
  };
}

export function mcpSuccess(id: McpRequestId, result: unknown): McpResponse {
  return { jsonrpc: '2.0', id, result };
}

export function mcpError(
  id: McpRequestId,
  code: number,
  message: string,
  data?: unknown,
): McpResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
