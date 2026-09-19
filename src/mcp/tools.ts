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

export function resolveMcpToolTimeoutMs(options: {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly rpcRequestTimeoutMs: number;
  readonly submissionAckTimeoutMs: number;
}): number {
  const transportFloorMs = Math.max(options.rpcRequestTimeoutMs, 125_000);
  if (options.name !== 'sessionplane_code_generate') return transportFloorMs;

  const requested = options.arguments.sessionDeadlineSec;
  const deadlineSec =
    typeof requested === 'number' &&
    Number.isSafeInteger(requested) &&
    requested >= 1 &&
    requested <= 86_400
      ? requested
      : 5_400;
  return Math.max(
    transportFloorMs,
    deadlineSec * 1_000 + options.submissionAckTimeoutMs + 10_000,
  );
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
    'browser_tabs',
    'browser.tabs',
    'List core-owned browser Pages and the explicitly selected pageKey.',
    objectSchema({}, []),
    true,
  ),
  tool(
    'browser_select_tab',
    'browser.select',
    'Select an exact pageKey for later browser commands without changing browser focus.',
    objectSchema({ pageKey: stringProperty('Exact PageRegistry pageKey.') }, ['pageKey']),
    false,
  ),
  tool(
    'browser_new_tab',
    'browser.new',
    'Create a new Page and optionally navigate it to a URL.',
    objectSchema({ url: { type: 'string', format: 'uri' } }, []),
    false,
  ),
  tool(
    'browser_snapshot',
    'browser.snapshot',
    'Capture a compact snapshot with snapshot-bound @eN element refs.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey; required when no page is selected.'),
        interactive: { type: 'boolean', default: true },
        maxNodes: { type: 'integer', minimum: 1, maximum: 5_000, default: 250 },
      },
      [],
    ),
    true,
  ),
  tool(
    'browser_click_ref',
    'browser.click',
    'Click one snapshot-bound ref on an exact Page.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clickCount: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      },
      ['ref'],
    ),
    false,
  ),
  tool(
    'browser_type_ref',
    'browser.type',
    'Fill or append text in one snapshot-bound ref.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
        text: { type: 'string', maxLength: 2_000_000 },
        append: { type: 'boolean', default: false },
      },
      ['ref', 'text'],
    ),
    false,
  ),
  tool(
    'browser_navigate',
    'browser.navigate',
    'Navigate an exact Page to an HTTP, HTTPS, about, or data URL.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        url: { type: 'string', minLength: 1, maxLength: 20_000 },
      },
      ['url'],
    ),
    false,
  ),
  tool(
    'browser_screenshot',
    'browser.screenshot',
    'Write a screenshot for an exact Page to a local path.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        outputPath: stringProperty('Local screenshot output path.'),
        fullPage: { type: 'boolean', default: false },
      },
      ['outputPath'],
    ),
    true,
  ),
  tool(
    'browser_text',
    'browser.text',
    'Read visible text from the Page or one CSS selector.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        selector: stringProperty('Optional CSS selector.'),
        maxChars: { type: 'integer', minimum: 1, maximum: 2_000_000, default: 200_000 },
      },
      [],
    ),
    true,
  ),
  tool(
    'browser_observe_bundle',
    'browser.observeBundle',
    'Capture URL, title, viewport, DPR, refs, boxes, screenshot, and text as one bundle.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        screenshotPath: stringProperty('Optional local screenshot path.'),
        includeBoxes: { type: 'boolean', default: true },
        maxTextChars: { type: 'integer', minimum: 1, maximum: 2_000_000, default: 2_000 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 5_000, default: 250 },
      },
      [],
    ),
    true,
  ),
  tool(
    'browser_observe_actions',
    'browser.observeActions',
    'Rank snapshot-bound action candidates for an instruction.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        instruction: { type: 'string', minLength: 1, maxLength: 100_000 },
        topN: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        includeDisabled: { type: 'boolean', default: false },
      },
      ['instruction'],
    ),
    true,
  ),
  tool(
    'browser_close_tab',
    'browser.close',
    'Close an exact Page, or the explicitly selected Page when pageKey is omitted.',
    objectSchema({ pageKey: stringProperty('Exact pageKey.') }, []),
    false,
  ),
  tool(
    'browser_cleanup_tabs',
    'browser.cleanup',
    'Close unowned generic Pages while preserving an exact pageKey when supplied.',
    objectSchema({ keepPageKey: stringProperty('Exact pageKey to preserve.') }, []),
    false,
  ),
  ...(['reload', 'back', 'forward'] as const).map((action) =>
    tool(
      `browser_${action}`,
      `browser.${action}`,
      `${action[0]?.toUpperCase() ?? ''}${action.slice(1)} the explicitly selected or exact Page.`,
      objectSchema({ pageKey: stringProperty('Exact pageKey.') }, []),
      false,
    ),
  ),
  tool(
    'browser_resize',
    'browser.resize',
    'Resize an exact Page viewport.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        width: { type: 'integer', minimum: 200, maximum: 10_000 },
        height: { type: 'integer', minimum: 200, maximum: 10_000 },
      },
      ['width', 'height'],
    ),
    false,
  ),
  tool(
    'browser_press',
    'browser.press',
    'Press a keyboard key on the Page or one snapshot-bound ref.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
        key: { type: 'string', minLength: 1, maxLength: 200 },
      },
      ['key'],
    ),
    false,
  ),
  tool(
    'browser_hover_ref',
    'browser.hover',
    'Hover one snapshot-bound ref.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
      },
      ['ref'],
    ),
    false,
  ),
  tool(
    'browser_select_ref',
    'browser.selectOption',
    'Select one or more values in a snapshot-bound select ref.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
        values: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: { type: 'string' },
        },
      },
      ['ref', 'values'],
    ),
    false,
  ),
  ...(['check', 'uncheck'] as const).map((action) =>
    tool(
      `browser_${action}_ref`,
      `browser.${action}`,
      `${action === 'check' ? 'Check' : 'Uncheck'} one snapshot-bound ref.`,
      objectSchema(
        {
          pageKey: stringProperty('Exact pageKey.'),
          snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
          ref: { type: 'string', pattern: '^@e[0-9]+$' },
        },
        ['ref'],
      ),
      false,
    ),
  ),
  tool(
    'browser_upload_ref',
    'browser.upload',
    'Upload local files through one snapshot-bound file input.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: stringProperty('Local file path.'),
        },
      },
      ['ref', 'files'],
    ),
    false,
  ),
  tool(
    'browser_drag_ref',
    'browser.drag',
    'Drag one snapshot-bound ref to another on the same Page.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        sourceRef: { type: 'string', pattern: '^@e[0-9]+$' },
        targetRef: { type: 'string', pattern: '^@e[0-9]+$' },
      },
      ['sourceRef', 'targetRef'],
    ),
    false,
  ),
  tool(
    'browser_mouse',
    'browser.mouse',
    'Perform an explicit coordinate mouse operation on an exact Page.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        action: { type: 'string', enum: ['click', 'move', 'down', 'up'] },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
      ['action'],
    ),
    false,
  ),
  tool(
    'browser_scroll',
    'browser.scroll',
    'Scroll an exact Page by explicit deltas.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        deltaX: { type: 'number', default: 0 },
        deltaY: { type: 'number' },
      },
      ['deltaY'],
    ),
    false,
  ),
  tool(
    'browser_wait',
    'browser.wait',
    'Wait for one selector, text, snapshot-bound ref, or a timeout.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        snapshotId: stringProperty('Snapshot identity returned by browser_snapshot.'),
        selector: stringProperty('CSS selector.'),
        text: stringProperty('Visible text.'),
        ref: { type: 'string', pattern: '^@e[0-9]+$' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 600_000, default: 30_000 },
      },
      [],
    ),
    true,
  ),
  tool(
    'browser_dom',
    'browser.dom',
    'Read serialized Page HTML with an explicit character cap.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        maxChars: { type: 'integer', minimum: 1, maximum: 4_000_000, default: 500_000 },
      },
      [],
    ),
    true,
  ),
  tool(
    'browser_evaluate',
    'browser.evaluate',
    'Evaluate explicit JavaScript in one exact Page.',
    objectSchema(
      {
        pageKey: stringProperty('Exact pageKey.'),
        script: { type: 'string', minLength: 1, maxLength: 1_000_000 },
      },
      ['script'],
    ),
    false,
  ),
  ...(['console', 'network'] as const).map((surface) =>
    tool(
      `browser_${surface}`,
      `browser.${surface}`,
      `Read bounded ${surface} diagnostics for one exact Page.`,
      objectSchema(
        {
          pageKey: stringProperty('Exact pageKey.'),
          clear: { type: 'boolean', default: false },
        },
        [],
      ),
      true,
    ),
  ),
  tool(
    'sessionplane_fetch',
    'fetch.read',
    'Safely fetch one HTTP(S) URL with DNS/private-network checks, redirect validation, and bounded extraction.',
    objectSchema(
      {
        url: { type: 'string', format: 'uri', maxLength: 8_000 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 26_214_400 },
        maxRedirects: { type: 'integer', minimum: 0, maximum: 20 },
        maxExtractChars: { type: 'integer', minimum: 1, maximum: 2_000_000 },
        includeHtml: { type: 'boolean', default: false },
        includeBinary: { type: 'boolean', default: false },
      },
      ['url'],
    ),
    true,
  ),
  tool(
    'sessionplane_extract_schema',
    'extract.schema',
    'Map JSON, JSON-LD, or HTML tables to a supported JSON schema and fail closed on mismatch.',
    objectSchema(
      {
        schema: { type: 'object' },
        url: { type: 'string', format: 'uri', maxLength: 8_000 },
        html: { type: 'string', maxLength: 5_000_000 },
        json: {},
        sourceMode: { type: 'string', enum: ['auto', 'json', 'jsonld', 'table'] },
      },
      ['schema'],
      {
        anyOf: [
          { required: ['url'] },
          { required: ['html'] },
          { required: ['json'] },
        ],
      },
    ),
    true,
  ),
  tool(
    'sessionplane_search',
    'search.query',
    'Discover or accept search candidates, fetch original pages, and return scored evidence.',
    objectSchema(
      {
        query: { type: 'string', minLength: 1, maxLength: 20_000 },
        results: {},
        backend: { type: 'string', minLength: 1, maxLength: 100 },
        verifyUrl: { type: 'string', format: 'uri', maxLength: 8_000 },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        deep: { type: 'boolean', default: false },
      },
      ['query'],
    ),
    true,
  ),
  tool(
    'sessionplane_research_plan',
    'research.plan',
    'Decompose a research query into constraints, source hints, and bounded subqueries.',
    objectSchema(
      {
        query: { type: 'string', minLength: 1, maxLength: 20_000 },
        maxQueries: { type: 'integer', minimum: 1, maximum: 20 },
      },
      ['query'],
    ),
    true,
  ),
  tool(
    'sessionplane_research_normalize',
    'research.normalize',
    'Normalize provider-specific search rows into a stable candidate ledger.',
    objectSchema(
      {
        query: { type: 'string', minLength: 1, maxLength: 20_000 },
        results: {},
        backend: { type: 'string', minLength: 1, maxLength: 100 },
        maxResults: { type: 'integer', minimum: 1, maximum: 500 },
      },
      ['query', 'results'],
    ),
    true,
  ),
  tool(
    'sessionplane_research_enrich',
    'research.enrich',
    'Fetch normalized candidates and create an original-page evidence ledger.',
    objectSchema(
      {
        plan: { type: 'object' },
        results: { type: 'object' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['plan', 'results'],
    ),
    true,
  ),
  tool(
    'sessionplane_research_browse_plan',
    'research.browsePlan',
    'Turn weak or blocked evidence into explicit browser inspection actions without mutating the browser.',
    objectSchema(
      {
        plan: { type: 'object' },
        enrichment: { type: 'object' },
        maxActions: { type: 'integer', minimum: 1, maximum: 50 },
      },
      ['plan', 'enrichment'],
    ),
    true,
  ),
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
        provider: { type: 'string', enum: ['chatgpt', 'gemini', 'grok'] },
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
        provider: {
          type: 'string',
          enum: ['chatgpt', 'gemini', 'grok'],
          default: 'chatgpt',
        },
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
        effort: { type: ['string', 'null'], maxLength: 200 },
        surface: { type: ['string', 'null'], maxLength: 200 },
        files: {
          type: 'array',
          maxItems: 20,
          items: stringProperty('Local file path to upload.'),
        },
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
    'sessionplane_code_generate',
    'code.generate',
    'Generate ChatGPT code under the strict ZIP contract and retrieve verified artifacts.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        sessionId: stringProperty('Exact durable ChatGPT session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        prompt: { type: 'string', minLength: 1, maxLength: 200_000 },
        model: { type: ['string', 'null'], maxLength: 200 },
        effort: { type: ['string', 'null'], maxLength: 200 },
        files: {
          type: 'array',
          maxItems: 20,
          items: stringProperty('Local file path to upload.'),
        },
        sessionDeadlineSec: {
          type: 'integer',
          minimum: 1,
          maximum: 86_400,
          default: 5_400,
        },
        outputPath: stringProperty('Destination for one ZIP artifact.'),
        outputDir: stringProperty('Destination directory for multi-ZIP artifacts.'),
        multiZip: { type: 'boolean', default: false },
        overwrite: { type: 'boolean', default: false },
      },
      ['clientId', 'requestId', 'prompt'],
      { oneOf: selectorOneOf },
    ),
    false,
  ),
  tool(
    'sessionplane_code_extract',
    'code.extract',
    'Re-retrieve verified ChatGPT ZIP artifacts without sending a new prompt.',
    objectSchema(
      {
        ...baseIdentityProperties,
        sessionId: stringProperty('Exact durable ChatGPT session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        conversationId: stringProperty('ChatGPT conversation ID or URL.'),
        generation: { type: 'integer', minimum: 1 },
        outputPath: stringProperty('Destination for one ZIP artifact.'),
        outputDir: stringProperty('Destination directory for multi-ZIP artifacts.'),
        multiZip: { type: 'boolean', default: false },
        requirePlan: { type: 'boolean', default: false },
        overwrite: { type: 'boolean', default: false },
      },
      ['clientId'],
      {
        anyOf: [
          { required: ['sessionId'] },
          { required: ['teamId', 'roleKey'] },
          { required: ['conversationId'] },
        ],
      },
    ),
    false,
  ),
  tool(
    'sessionplane_chatgpt_project_sources_list',
    'chatgpt.projectSources.list',
    'List exact ChatGPT Project Sources from an explicit project URL.',
    objectSchema(
      {
        ...baseIdentityProperties,
        projectUrl: stringProperty('Exact https://chatgpt.com/g/... project URL.'),
      },
      ['clientId', 'projectUrl'],
    ),
    true,
  ),
  tool(
    'sessionplane_chatgpt_project_sources_add',
    'chatgpt.projectSources.add',
    'Append local files to an exact ChatGPT Project without replacing existing sources.',
    objectSchema(
      {
        ...mutationIdentityProperties,
        projectUrl: stringProperty('Exact https://chatgpt.com/g/... project URL.'),
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: stringProperty('Local project-source file path.'),
        },
        dryRun: { type: 'boolean', default: false },
      },
      ['clientId', 'requestId', 'projectUrl', 'files'],
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
    'sessionplane_session_list',
    'session.list',
    'List durable sessions owned by one client identity.',
    objectSchema(baseIdentityProperties, ['clientId']),
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
  tool(
    'sessionplane_artifact_discover',
    'artifact.discover',
    'Discover provider-created artifacts for the exact current session generation.',
    objectSchema(
      {
        ...baseIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        generation: { type: 'integer', minimum: 1 },
      },
      ['clientId'],
      { oneOf: selectorOneOf },
    ),
    true,
  ),
  tool(
    'sessionplane_artifact_capture',
    'artifact.capture',
    'Download provider-created artifacts into the durable content-addressed store.',
    objectSchema(
      {
        ...baseIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        generation: { type: 'integer', minimum: 1 },
        artifactIds: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: stringProperty('Artifact or provider-artifact identity.'),
        },
      },
      ['clientId'],
      { oneOf: selectorOneOf },
    ),
    false,
  ),
  tool(
    'sessionplane_artifact_list',
    'artifact.list',
    'List durable artifact descriptors for one exact session generation.',
    objectSchema(
      {
        ...baseIdentityProperties,
        sessionId: stringProperty('Exact durable session UUID.'),
        teamId: stringProperty('Durable team UUID.'),
        roleKey: stringProperty('Stable role key within the team.'),
        generation: { type: 'integer', minimum: 1 },
      },
      ['clientId'],
      { oneOf: selectorOneOf },
    ),
    true,
  ),
  tool(
    'sessionplane_artifact_get',
    'artifact.get',
    'Read one durable artifact descriptor.',
    objectSchema(
      {
        ...baseIdentityProperties,
        artifactId: stringProperty('Durable artifact UUID.'),
      },
      ['clientId', 'artifactId'],
    ),
    true,
  ),
  tool(
    'sessionplane_artifact_export',
    'artifact.export',
    'Materialize downloaded artifact bytes at an explicit local output path.',
    objectSchema(
      {
        ...baseIdentityProperties,
        artifactId: stringProperty('Durable artifact UUID.'),
        outputPath: stringProperty('Explicit local destination path.'),
        overwrite: { type: 'boolean', default: false },
      },
      ['clientId', 'artifactId', 'outputPath'],
    ),
    false,
  ),
  tool(
    'sessionplane_context_dry_run',
    'context.dryRun',
    'Inspect a deterministic, symlink-safe context package without writing an upload artifact.',
    contextPackageSchema(),
    true,
  ),
  tool(
    'sessionplane_context_render',
    'context.render',
    'Render a deterministic inline or upload context package and enforce the token budget.',
    contextPackageSchema(),
    false,
  ),
];

function contextPackageSchema(): Readonly<Record<string, unknown>> {
  return objectSchema(
    {
      root: stringProperty('Context root directory; defaults to the core working directory.'),
      includes: {
        type: 'array',
        maxItems: 2_000,
        uniqueItems: true,
        items: stringProperty('Root-relative file path or glob.'),
      },
      excludes: {
        type: 'array',
        maxItems: 2_000,
        uniqueItems: true,
        items: stringProperty('Root-relative exclusion glob.'),
      },
      contextFile: stringProperty('Root-relative newline-delimited selector file.'),
      prompt: { type: 'string', maxLength: 500_000 },
      transport: { type: 'string', enum: ['inline', 'upload'], default: 'upload' },
      transform: { type: 'string', enum: ['raw', 'repomix'], default: 'raw' },
      maxInputTokens: { type: 'integer', minimum: 1, maximum: 10_000_000 },
      maxFileBytes: { type: 'integer', minimum: 1, maximum: 1024 * 1024 * 1024 },
      maxTotalBytes: { type: 'integer', minimum: 1, maximum: 2 * 1024 * 1024 * 1024 },
    },
    [],
  );
}

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
