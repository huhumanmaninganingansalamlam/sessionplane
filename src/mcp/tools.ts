import { callRpc, RpcClientError } from '../cli/client.ts';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly rpcMethod: string;
}

export interface McpToolInvocationResult {
  readonly isError: boolean;
  readonly structuredContent: Readonly<Record<string, unknown>>;
}

export class McpToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown SessionPlane MCP tool: ${name}`);
    this.name = 'McpToolNotFoundError';
  }
}

const stringProperty = (description: string): Readonly<Record<string, unknown>> => ({
  type: 'string',
  minLength: 1,
  description,
});

const baseIdentityProperties = {
  clientId: stringProperty('Stable caller identity used by the core idempotency contract.'),
};

const mutationIdentityProperties = {
  ...baseIdentityProperties,
  requestId: stringProperty('Stable mutation request identity. Reuse only for an exact retry.'),
};

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...extra,
  };
}

function tool(
  name: string,
  rpcMethod: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  readOnly: boolean,
): McpToolDefinition {
  return {
    name,
    rpcMethod,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

const selectorOneOf = [
  { required: ['sessionId'] },
  { required: ['teamId', 'roleKey'] },
] as const;

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  tool(
    'sessionplane_team_create',
    'team.create',
    'Create a durable team and its primary role.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        name: { type: ['string', 'null'], maxLength: 500 },
        objective: { type: ['string', 'null'], maxLength: 20_000 },
        primaryRoleKey: stringProperty('Stable primary role key; defaults to main.'),
        externalRef: { type: ['string', 'null'], maxLength: 500 },
      },
      ['clientId', 'requestId'],
    ),
    false,
  ),
  tool(
    'sessionplane_team_get',
    'team.get',
    'Read one team and all role/current-session summaries.',
    objectSchema(
      { ...baseIdentityProperties, teamId: stringProperty('Durable team UUID.') },
      ['clientId', 'teamId'],
    ),
    true,
  ),
  tool(
    'sessionplane_team_list',
    'team.list',
    'List teams owned by a client identity.',
    objectSchema(baseIdentityProperties, ['clientId']),
    true,
  ),
  tool(
    'sessionplane_role_create',
    'team.role.create',
    'Create an explicitly addressed expert, reviewer, or custom role.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        roleType: { type: 'string', enum: ['expert', 'reviewer', 'custom'] },
        displayName: { type: ['string', 'null'], maxLength: 500 },
        reportsToRoleKey: stringProperty('Primary role key this role reports to.'),
        provider: { type: 'string', const: 'chatgpt' },
      },
      ['clientId', 'requestId', 'teamId', 'roleKey', 'roleType'],
    ),
    false,
  ),
  tool(
    'sessionplane_role_retire',
    'team.role.retire',
    'Retire an explicitly addressed non-primary role.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
      },
      ['clientId', 'requestId', 'teamId', 'roleKey'],
    ),
    false,
  ),
  tool(
    'sessionplane_brief_update',
    'team.brief.update',
    'Create a new immutable team brief version.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        teamId: stringProperty('Durable team UUID.'),
        objective: { type: ['string', 'null'], maxLength: 20_000 },
        briefText: { type: 'string', minLength: 1, maxLength: 200_000 },
      },
      ['clientId', 'requestId', 'teamId', 'briefText'],
    ),
    false,
  ),
  tool(
    'sessionplane_session_create',
    'session.create',
    'Create or replace the current provider session for an exact team role.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        provider: { type: 'string', const: 'chatgpt', default: 'chatgpt' },
      },
      ['clientId', 'requestId', 'teamId', 'roleKey'],
    ),
    false,
  ),
  tool(
    'sessionplane_send',
    'session.send',
    'Submit one exact generation to a session. Ambiguous acknowledgement is never retried.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        prompt: { type: 'string', minLength: 1, maxLength: 200_000 },
        model: { type: ['string', 'null'], maxLength: 200 },
        sessionDeadlineSec: {
          type: 'integer',
          minimum: 1,
          maximum: 86_400,
          default: 5_400,
        },
      },
      ['clientId', 'requestId', 'prompt'],
      { oneOf: selectorOneOf },
    ),
    false,
  ),
  tool(
    'sessionplane_status',
    'session.get',
    'Read the durable current snapshot for an exact session or team role.',
    objectSchema(
      {
        ...baseIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
      },
      ['clientId'],
      { oneOf: selectorOneOf },
    ),
    true,
  ),
  tool(
    'sessionplane_wait',
    'session.wait',
    'Wait for a durable session change or client deadline without changing provider lifecycle.',
    objectSchema(
      {
        ...baseIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        generation: { type: 'integer', minimum: 0 },
        afterEventSequence: { type: 'integer', minimum: 0 },
        waitMs: { type: 'integer', minimum: 0, maximum: 120_000, default: 30_000 },
      },
      ['clientId'],
      { oneOf: selectorOneOf },
    ),
    true,
  ),
  tool(
    'sessionplane_team_wait',
    'team.wait',
    'Wait on existing role actors in one team; this never creates polling or coordination prompts.',
    objectSchema(
      {
        ...baseIdentityProperties,
        teamId: stringProperty('Durable team UUID.'),
        roleKeys: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: stringProperty('Stable role key within the team.'),
        },
        until: {
          type: 'string',
          enum: ['any_change', 'primary_terminal', 'all_selected_terminal'],
        },
        afterEventSequence: { type: 'integer', minimum: 0 },
        waitMs: { type: 'integer', minimum: 0, maximum: 120_000, default: 30_000 },
      },
      ['clientId', 'teamId', 'until'],
    ),
    true,
  ),
  tool(
    'sessionplane_stop',
    'session.stop',
    'Request one explicit provider stop for an exact session generation.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
      },
      ['clientId', 'requestId'],
      { oneOf: selectorOneOf },
    ),
    false,
  ),
  tool(
    'sessionplane_events',
    'session.events',
    'Read durable team/session events after a sequence cursor.',
    objectSchema(
      {
        ...baseIdentityProperties,
        teamId: stringProperty('Durable team UUID.'),
        afterSequence: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 1_000, default: 200 },
      },
      ['clientId', 'teamId'],
    ),
    true,
  ),
];

export function getMcpTool(name: string): McpToolDefinition | null {
  return MCP_TOOLS.find((candidate) => candidate.name === name) ?? null;
}

export async function invokeMcpTool(options: {
  readonly name: string;
  readonly arguments: unknown;
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly signal?: AbortSignal;
}): Promise<McpToolInvocationResult> {
  const definition = getMcpTool(options.name);
  if (definition === null) {
    throw new McpToolNotFoundError(options.name);
  }

  try {
    const result = await callRpc<unknown>({
      socketPath: options.socketPath,
      method: definition.rpcMethod,
      params: options.arguments,
      timeoutMs: options.timeoutMs,
      maxLineBytes: options.maxLineBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      isError: false,
      structuredContent: normalizeStructuredContent(result),
    };
  } catch (error) {
    if (!(error instanceof RpcClientError)) {
      throw error;
    }
    const data = isRecord(error.data) ? error.data : {};
    return {
      isError: true,
      structuredContent: {
        requestOk: false,
        errorCode:
          typeof data.errorCode === 'string'
            ? data.errorCode
            : 'internal.invariant-violation',
        message: error.message,
        ...(data.details === undefined ? {} : { details: data.details }),
      },
    };
  }
}

function normalizeStructuredContent(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  return { value };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
