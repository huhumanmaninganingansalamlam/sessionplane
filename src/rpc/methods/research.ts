import { z } from 'zod';

import type { SessionPlaneConfig } from '../../config.ts';
import {
  AdaptiveFetchError,
  adaptiveFetch,
  type AdaptiveFetchOptions,
} from '../../fetch/adaptive-fetch.ts';
import { extractHtmlDocument } from '../../fetch/html-extractor.ts';
import {
  extractBySchema,
  SchemaExtractionError,
} from '../../extract/schema-extractor.ts';
import type {
  ResearchCandidateList,
  ResearchFetchEnrichment,
  ResearchPlan,
  ResearchService,
} from '../../research/research-service.ts';
import type { SearchService } from '../../search/search-service.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const HttpUrl = z.string().url().max(8_000);
const PositiveInt = z.number().int().positive();
const FetchOptionsSchema = z.object({
  url: HttpUrl,
  timeoutMs: PositiveInt.max(120_000).optional(),
  maxBytes: PositiveInt.max(25 * 1024 * 1024).optional(),
  maxRedirects: z.number().int().min(0).max(20).optional(),
  maxExtractChars: PositiveInt.max(2_000_000).optional(),
  includeHtml: z.boolean().optional(),
  includeBinary: z.boolean().optional(),
}).strict();

export function registerResearchMethods(
  router: RpcRouter,
  options: {
    readonly config: SessionPlaneConfig;
    readonly search: SearchService;
    readonly research: ResearchService;
  },
): void {
  const baseFetchOptions = configFetchOptions(options.config);
  router.register('fetch.read', FetchOptionsSchema, async (params) =>
    await wrapErrors(async () =>
      await adaptiveFetch(params.url, {
        ...baseFetchOptions,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
        ...(params.maxRedirects === undefined ? {} : { maxRedirects: params.maxRedirects }),
        ...(params.maxExtractChars === undefined
          ? {}
          : { maxExtractChars: params.maxExtractChars }),
        ...(params.includeHtml === undefined ? {} : { includeHtml: params.includeHtml }),
        ...(params.includeBinary === undefined ? {} : { includeBinary: params.includeBinary }),
      }),
    ),
  );

  router.register(
    'extract.schema',
    z
      .object({
        schema: z.unknown(),
        url: HttpUrl.optional(),
        html: z.string().max(5_000_000).optional(),
        json: z.unknown().optional(),
        sourceMode: z.enum(['auto', 'json', 'jsonld', 'table']).optional(),
      })
      .strict()
      .refine(
        (value) => value.url !== undefined || value.html !== undefined || value.json !== undefined,
        { message: 'extract.schema requires url, html, or json' },
      ),
    async (params) =>
      await wrapErrors(async () => {
        if (params.url !== undefined) {
          const fetched = await adaptiveFetch(params.url, {
            ...baseFetchOptions,
            includeHtml: true,
          });
          return extractBySchema({
            schema: params.schema,
            document: fetched.document,
            ...(fetched.document?.html === undefined
              ? {}
              : { html: fetched.document.html }),
            ...(fetched.json === null ? {} : { json: fetched.json }),
            ...(params.sourceMode === undefined ? {} : { sourceMode: params.sourceMode }),
          });
        }
        if (params.html !== undefined) {
          const document = extractHtmlDocument(params.html, 'https://local.sessionplane.invalid/', {
            includeHtml: true,
            maxChars: 2_000_000,
          });
          return extractBySchema({
            schema: params.schema,
            document,
            html: params.html,
            ...(params.sourceMode === undefined ? {} : { sourceMode: params.sourceMode }),
          });
        }
        return extractBySchema({
          schema: params.schema,
          json: params.json,
          ...(params.sourceMode === undefined ? {} : { sourceMode: params.sourceMode }),
        });
      }),
  );

  router.register(
    'search.query',
    z.object({
      query: z.string().trim().min(1).max(20_000),
      results: z.unknown().optional(),
      backend: z.string().trim().min(1).max(100).optional(),
      verifyUrl: HttpUrl.optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
      deep: z.boolean().optional(),
    }).strict(),
    async (params) =>
      await wrapErrors(async () =>
        await options.search.query({
          query: params.query,
          ...(params.results === undefined ? {} : { results: params.results }),
          ...(params.backend === undefined ? {} : { backend: params.backend }),
          ...(params.verifyUrl === undefined ? {} : { verifyUrl: params.verifyUrl }),
          ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
          ...(params.deep === undefined ? {} : { deep: params.deep }),
        }),
      ),
  );

  registerResearchPipeline(router, options.research);
}

function configFetchOptions(config: SessionPlaneConfig): AdaptiveFetchOptions {
  return {
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.fetchMaxBytes,
    maxRedirects: config.fetchMaxRedirects,
    allowPrivateNetworks: config.fetchAllowPrivateNetworks,
  };
}

function registerResearchPipeline(router: RpcRouter, research: ResearchService): void {
  router.register(
    'research.plan',
    z.object({
      query: z.string().trim().min(1).max(20_000),
      maxQueries: z.number().int().min(1).max(20).optional(),
    }).strict(),
    (params) => wrapErrorsSync(() => research.plan(params.query, {
      ...(params.maxQueries === undefined ? {} : { maxQueries: params.maxQueries }),
    })),
  );

  router.register(
    'research.normalize',
    z.object({
      query: z.string().trim().min(1).max(20_000),
      results: z.unknown(),
      backend: z.string().trim().min(1).max(100).optional(),
      maxResults: z.number().int().min(1).max(500).optional(),
    }).strict(),
    (params) => wrapErrorsSync(() => research.normalizeResults({
      query: params.query,
      results: params.results,
      ...(params.backend === undefined ? {} : { backend: params.backend }),
      ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
    })),
  );

  router.register(
    'research.enrich',
    z.object({
      plan: z.unknown(),
      results: z.unknown(),
      maxResults: z.number().int().min(1).max(100).optional(),
    }).strict(),
    async (params) =>
      await wrapErrors(async () =>
        await research.enrichFetch({
          plan: params.plan as ResearchPlan,
          results: params.results as ResearchCandidateList,
          ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
        }),
      ),
  );

  router.register(
    'research.browsePlan',
    z.object({
      plan: z.unknown(),
      enrichment: z.unknown(),
      maxActions: z.number().int().min(1).max(50).optional(),
    }).strict(),
    (params) => wrapErrorsSync(() => research.browsePlan({
      plan: params.plan as ResearchPlan,
      enrichment: params.enrichment as ResearchFetchEnrichment,
      ...(params.maxActions === undefined ? {} : { maxActions: params.maxActions }),
    })),
  );
}

async function wrapErrors<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw asRpcError(error);
  }
}

function wrapErrorsSync<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    throw asRpcError(error);
  }
}

function asRpcError(error: unknown): unknown {
  if (error instanceof AdaptiveFetchError || error instanceof SchemaExtractionError) {
    return new RpcMethodError(error.errorCode, error.message, { details: error.details });
  }
  if (error instanceof Error) {
    return new RpcMethodError('input.invalid', error.message);
  }
  return error;
}
