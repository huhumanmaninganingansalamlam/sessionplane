import { createHash } from 'node:crypto';

import {
  normalizeSearchResults,
  SearchService,
  type SearchCandidate,
  type SearchEvidence,
} from '../search/search-service.ts';

export interface ResearchPlan {
  readonly schemaVersion: 'sessionplane-research-plan-v1';
  readonly query: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly sourceHints: readonly string[];
  readonly subqueries: readonly string[];
  readonly createdAt: string;
}

export interface NormalizedResearchCandidate extends SearchCandidate {
  readonly candidateId: string;
}

export interface ResearchCandidateList {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-search-results-v1';
  readonly query: string;
  readonly backend: string;
  readonly candidates: readonly NormalizedResearchCandidate[];
}

export interface ResearchFetchLedgerEntry {
  readonly candidateId: string;
  readonly candidate: NormalizedResearchCandidate;
  readonly evidence: SearchEvidence | null;
  readonly status: 'verified' | 'weak' | 'blocked' | 'failed';
}

export interface ResearchFetchEnrichment {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-research-fetch-enrichment-v1';
  readonly plan: ResearchPlan;
  readonly entries: readonly ResearchFetchLedgerEntry[];
  readonly verifiedCount: number;
  readonly weakCount: number;
  readonly failedCount: number;
}

export interface ResearchBrowseAction {
  readonly candidateId: string;
  readonly url: string;
  readonly reason: string;
  readonly command: string;
  readonly priority: number;
}

export interface ResearchBrowsePlan {
  readonly requestOk: true;
  readonly schemaVersion: 'sessionplane-research-browse-plan-v1';
  readonly query: string;
  readonly actions: readonly ResearchBrowseAction[];
  readonly complete: boolean;
}

export interface ResearchServiceOptions {
  readonly search: SearchService;
  readonly now?: () => Date;
}

export class ResearchService {
  readonly #search: SearchService;
  readonly #now: () => Date;

  constructor(options: ResearchServiceOptions) {
    this.#search = options.search;
    this.#now = options.now ?? (() => new Date());
  }

  plan(queryValue: string, options: { readonly maxQueries?: number } = {}): ResearchPlan {
    const query = nonempty(queryValue, 'query');
    const maxQueries = Math.min(positiveInteger(options.maxQueries, 6, 'maxQueries'), 20);
    const quoted = [...query.matchAll(/["“]([^"”]+)["”]/g)].map((match) => match[1] ?? '').filter(Boolean);
    const years = query.match(/\b(?:19|20)\d{2}\b/g) ?? [];
    const siteHints = [...query.matchAll(/\bsite:([^\s]+)/gi)].map((match) => match[1] ?? '').filter(Boolean);
    const constraints = [...new Set([
      ...quoted.map((value) => `exact phrase: ${value}`),
      ...years.map((value) => `time: ${value}`),
      ...siteHints.map((value) => `site: ${value}`),
    ])];
    const sourceHints = inferSourceHints(query, siteHints);
    const subqueries = buildSubqueries(query, sourceHints, maxQueries);
    return Object.freeze({
      schemaVersion: 'sessionplane-research-plan-v1',
      query,
      objective: `Collect original-source evidence sufficient to answer: ${query}`,
      constraints: Object.freeze(constraints),
      sourceHints: Object.freeze(sourceHints),
      subqueries: Object.freeze(subqueries),
      createdAt: this.#now().toISOString(),
    });
  }

  normalizeResults(input: {
    readonly query: string;
    readonly results: unknown;
    readonly backend?: string;
    readonly maxResults?: number;
  }): ResearchCandidateList {
    const query = nonempty(input.query, 'query');
    const backend = nonempty(input.backend ?? 'external', 'backend');
    const maxResults = Math.min(positiveInteger(input.maxResults, 100, 'maxResults'), 500);
    const normalized = normalizeSearchResults(input.results, backend, query).slice(0, maxResults);
    const candidates = normalized.map((candidate) => Object.freeze({
      ...candidate,
      candidateId: candidateId(candidate.url),
    }));
    return Object.freeze({
      requestOk: true,
      schemaVersion: 'sessionplane-search-results-v1',
      query,
      backend,
      candidates: Object.freeze(candidates),
    });
  }

  async enrichFetch(input: {
    readonly plan: ResearchPlan;
    readonly results: ResearchCandidateList;
    readonly maxResults?: number;
  }): Promise<ResearchFetchEnrichment> {
    assertPlan(input.plan);
    assertCandidateList(input.results);
    const maxResults = Math.min(
      positiveInteger(input.maxResults, input.results.candidates.length || 1, 'maxResults'),
      100,
    );
    const selected = input.results.candidates.slice(0, maxResults);
    const result = await this.#search.query({
      query: input.plan.query,
      results: selected,
      backend: input.results.backend,
      maxResults,
    });
    const evidenceByUrl = new Map(result.evidence.map((entry) => [entry.candidate.url, entry]));
    const entries = selected.map((candidate) => {
      const evidence = evidenceByUrl.get(candidate.url) ?? null;
      return Object.freeze({
        candidateId: candidate.candidateId,
        candidate,
        evidence,
        status: evidence?.verdict ?? 'failed',
      });
    });
    return Object.freeze({
      requestOk: true,
      schemaVersion: 'sessionplane-research-fetch-enrichment-v1',
      plan: input.plan,
      entries: Object.freeze(entries),
      verifiedCount: entries.filter((entry) => entry.status === 'verified').length,
      weakCount: entries.filter((entry) => entry.status === 'weak').length,
      failedCount: entries.filter((entry) => entry.status === 'blocked' || entry.status === 'failed').length,
    });
  }

  browsePlan(input: {
    readonly plan: ResearchPlan;
    readonly enrichment: ResearchFetchEnrichment;
    readonly maxActions?: number;
  }): ResearchBrowsePlan {
    assertPlan(input.plan);
    assertEnrichment(input.enrichment);
    const maxActions = Math.min(positiveInteger(input.maxActions, 10, 'maxActions'), 50);
    const actions = input.enrichment.entries
      .filter((entry) => entry.status !== 'verified')
      .sort((left, right) => candidatePriority(right) - candidatePriority(left))
      .slice(0, maxActions)
      .map((entry, index) => Object.freeze({
        candidateId: entry.candidateId,
        url: entry.candidate.url,
        reason: browseReason(entry),
        command: `sessplane browser-open ${shellQuote(entry.candidate.url)} --json`,
        priority: index + 1,
      }));
    return Object.freeze({
      requestOk: true,
      schemaVersion: 'sessionplane-research-browse-plan-v1',
      query: input.plan.query,
      actions: Object.freeze(actions),
      complete: actions.length === 0 && input.enrichment.verifiedCount > 0,
    });
  }
}

function buildSubqueries(
  query: string,
  sourceHints: readonly string[],
  limit: number,
): string[] {
  const queries = [query];
  const withoutSite = query.replace(/\bsite:[^\s]+/gi, '').replace(/\s+/g, ' ').trim();
  if (withoutSite !== query) queries.push(withoutSite);
  for (const hint of sourceHints) {
    queries.push(`${withoutSite} ${hint}`.trim());
  }
  queries.push(`${withoutSite} official documentation`.trim());
  queries.push(`${withoutSite} primary source`.trim());
  return [...new Set(queries.filter(Boolean))].slice(0, limit);
}

function inferSourceHints(query: string, explicitSites: readonly string[]): string[] {
  const lower = query.toLowerCase();
  const hints = [...explicitSites];
  if (/law|regulation|policy|government|지원금|법|정책/.test(lower)) hints.push('official government source');
  if (/paper|research|study|논문|연구/.test(lower)) hints.push('peer-reviewed paper', 'official dataset');
  if (/api|library|framework|software|version|migration|docs|문서/.test(lower)) {
    hints.push('official documentation', 'release notes');
  }
  if (/price|product|spec|가격|제품|사양/.test(lower)) hints.push('manufacturer specification');
  if (/news|latest|today|최근|뉴스/.test(lower)) hints.push('dated primary report');
  return [...new Set(hints)].slice(0, 10);
}

function candidateId(url: string): string {
  return `candidate-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
}

function candidatePriority(entry: ResearchFetchLedgerEntry): number {
  const rankScore = Math.max(0, 100 - entry.candidate.rank);
  const evidenceScore = entry.evidence?.score ?? 0;
  const statusScore = entry.status === 'weak' ? 30 : entry.status === 'blocked' ? 10 : 0;
  return rankScore + evidenceScore + statusScore;
}

function browseReason(entry: ResearchFetchLedgerEntry): string {
  if (entry.status === 'blocked') return 'Direct fetch encountered an interstitial; inspect the explicit page.';
  if (entry.status === 'weak') return 'Direct fetch returned weak or thin evidence; inspect rendered content.';
  return 'Direct fetch failed; inspect the candidate only if its source ranking justifies escalation.';
}

function assertPlan(value: ResearchPlan): void {
  if (
    value.schemaVersion !== 'sessionplane-research-plan-v1' ||
    typeof value.query !== 'string' ||
    !Array.isArray(value.subqueries)
  ) {
    throw new Error('Invalid research plan');
  }
}

function assertCandidateList(value: ResearchCandidateList): void {
  if (
    value.schemaVersion !== 'sessionplane-search-results-v1' ||
    !Array.isArray(value.candidates)
  ) {
    throw new Error('Invalid normalized research result list');
  }
}

function assertEnrichment(value: ResearchFetchEnrichment): void {
  if (
    value.schemaVersion !== 'sessionplane-research-fetch-enrichment-v1' ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('Invalid research fetch enrichment');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be positive`);
  return result;
}

function nonempty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${name} must not be empty`);
  return normalized;
}
