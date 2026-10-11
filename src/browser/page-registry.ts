import { randomUUID } from 'node:crypto';

import type { BrowserContext, Frame, Page } from 'playwright-core';

import type { RuntimeMetrics } from '../telemetry/metrics.ts';

import {
  parseProviderConversationId,
  type BindPageInput,
  type PageBindingSnapshot,
  type PageBindingState,
  type ReservePageInput,
} from './page-binding.ts';

interface PageRecord {
  readonly pageKey: string;
  page: Page;
  readonly registrationOrder: number;
  targetId: string | null;
  bindingEpoch: number;
  sessionId: string | null;
  generation: number | null;
  conversationId: string | null;
  expectedConversationId: string | null;
  url: string;
  state: PageBindingState;
  lastSeenAt: string;
  conflictOwnerPageKey: string | null;
  duplicatePageKeys: string[];
  readonly onFrameNavigated: (frame: Frame) => void;
  readonly onClose: () => void;
  readonly onCrash: () => void;
  crashObservedAt: string | null;
}

export class PageRegistryError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'PageRegistryError';
    this.errorCode = errorCode;
  }
}

export class PageRegistry {
  readonly #records = new Map<string, PageRecord>();
  readonly #keysByPage = new WeakMap<Page, string>();
  readonly #listeners = new Set<(snapshot: PageBindingSnapshot) => void>();
  readonly #now: () => Date;
  readonly #metrics: RuntimeMetrics | null;
  #conflictFingerprints = new Set<string>();
  #registrationSequence = 0;
  #context: BrowserContext | null = null;
  readonly #onContextPage = (page: Page): void => {
    this.registerPage(page);
  };
  readonly #onContextClose = (): void => {
    for (const record of this.#records.values()) {
      if (record.state !== 'closed') {
        this.#markClosed(record);
      }
    }
  };

  constructor(
    options: {
      readonly now?: () => Date;
      readonly metrics?: RuntimeMetrics;
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#metrics = options.metrics ?? null;
  }

  attach(context: BrowserContext): void {
    if (this.#context === context) {
      return;
    }
    if (this.#context !== null) {
      throw new PageRegistryError(
        'internal.invariant-violation',
        'PageRegistry is already attached to another BrowserContext',
      );
    }
    this.#context = context;
    for (const page of context.pages()) {
      this.registerPage(page);
    }
    context.on('page', this.#onContextPage);
    context.on('close', this.#onContextClose);
  }

  detach(): void {
    const context = this.#context;
    if (context === null) {
      return;
    }
    context.off('page', this.#onContextPage);
    context.off('close', this.#onContextClose);
    for (const record of this.#records.values()) {
      if (record.state === 'closed' || record.page.context() !== context) {
        continue;
      }
      record.page.off('framenavigated', record.onFrameNavigated);
      record.page.off('close', record.onClose);
      record.page.off('crash', record.onCrash);
      this.#markClosed(record);
    }
    this.#context = null;
  }

  registerPage(page: Page): PageBindingSnapshot {
    const existingKey = this.#keysByPage.get(page);
    if (existingKey !== undefined) {
      return this.getBinding(existingKey);
    }

    const pageKey = `page-${randomUUID()}`;
    const now = this.#now().toISOString();
    const url = page.url();
    const record: PageRecord = {
      pageKey,
      page,
      registrationOrder: this.#registrationSequence,
      targetId: null,
      bindingEpoch: 1,
      sessionId: null,
      generation: null,
      conversationId: parseProviderConversationId(url),
      expectedConversationId: null,
      url,
      state: page.isClosed() ? 'closed' : 'unbound',
      lastSeenAt: now,
      conflictOwnerPageKey: null,
      duplicatePageKeys: [],
      crashObservedAt: null,
      onCrash: () => { record.crashObservedAt = this.#now().toISOString(); },
      onFrameNavigated: (frame: Frame) => {
        if (frame === record.page.mainFrame()) {
          this.refreshPage(pageKey);
        }
      },
      onClose: () => {
        const current = this.#records.get(pageKey);
        if (current !== undefined) {
          this.#markClosed(current);
        }
      },
    };
    this.#registrationSequence += 1;

    this.#records.set(pageKey, record);
    this.#keysByPage.set(page, pageKey);
    page.on('framenavigated', record.onFrameNavigated);
    page.on('close', record.onClose);
    page.on('crash', record.onCrash);
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  /** Only a native event on this retained Page proves crash; error text does not. */
  observedCrash(pageKey: string): string | null {
    const record = this.#requireRecord(pageKey);
    return record.state === 'closed' || record.page.isClosed() ? null : record.crashObservedAt;
  }

  /** Reassociate only the exact retained crashed target; never create or close a tab. */
  reconnectCrashedPage(pageKey: string, expected: PageBindingSnapshot, page: Page, targetId: string): void {
    const record = this.#requireRecord(pageKey);
    if (record.crashObservedAt === null || (record.state !== 'owned' && record.state !== 'reserved') || record.page.isClosed() || page.isClosed() ||
        record.targetId !== targetId || expected.targetId !== targetId || record.bindingEpoch !== expected.bindingEpoch ||
        record.sessionId !== expected.sessionId || record.generation !== expected.generation ||
        record.conversationId !== expected.conversationId || record.expectedConversationId !== expected.expectedConversationId ||
        record.url !== expected.url || page.url() !== expected.url || this.#keysByPage.has(page)) {
      throw new PageRegistryError('session.page-identity-unverified', 'Crashed target changed during controller recovery');
    }
    record.page.off('framenavigated', record.onFrameNavigated);
    record.page.off('close', record.onClose);
    record.page.off('crash', record.onCrash);
    this.#keysByPage.delete(record.page);
    record.page = page;
    this.#keysByPage.set(page, pageKey);
    record.crashObservedAt = null;
    record.bindingEpoch++;
    record.lastSeenAt = this.#now().toISOString();
    page.on('framenavigated', record.onFrameNavigated);
    page.on('close', record.onClose);
    page.on('crash', record.onCrash);
    this.#emit(record);
  }

  identifyPage(page: Page, targetId: string): PageBindingSnapshot {
    const binding = this.registerPage(page);
    const record = this.#requireRecord(binding.pageKey);
    record.targetId = targetId;
    this.#emit(record);
    return this.#snapshot(record);
  }

  refreshPage(pageKey: string): PageBindingSnapshot {
    const record = this.#requireRecord(pageKey);
    if (record.state === 'closed' || record.page.isClosed()) {
      this.#markClosed(record);
      return this.#snapshot(record);
    }

    const url = record.page.url();
    if (url !== record.url) {
      record.bindingEpoch += 1;
      record.url = url;
    }
    record.conversationId = parseProviderConversationId(url);
    record.lastSeenAt = this.#now().toISOString();
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  bindPage(pageKey: string, input: BindPageInput): PageBindingSnapshot {
    const record = this.#requireRecord(pageKey);
    this.refreshPage(pageKey);
    if (record.state === 'closed' || record.page.isClosed()) {
      throw new PageRegistryError('browser.unavailable', `Page ${pageKey} is closed`);
    }
    if (record.state === 'conflict') {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} is quarantined by a duplicate conversation conflict`,
      );
    }
    if (record.sessionId !== null && record.sessionId !== input.sessionId) {
      this.#metrics?.increment('wrong_session_total');
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} is reserved by another session`,
      );
    }
    if (record.generation !== null && record.generation !== input.generation) {
      this.#metrics?.increment('wrong_generation_total');
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} is reserved for another generation`,
      );
    }
    if (
      record.expectedConversationId !== null &&
      record.expectedConversationId !== input.conversationId
    ) {
      throw new PageRegistryError(
        'session.conversation-mismatch',
        `Page ${pageKey} is reserved for conversation ${record.expectedConversationId}`,
      );
    }
    if (record.conversationId !== input.conversationId) {
      throw new PageRegistryError(
        'session.conversation-mismatch',
        `Page ${pageKey} is not at conversation ${input.conversationId}`,
      );
    }
    record.sessionId = input.sessionId;
    record.generation = input.generation;
    record.expectedConversationId = input.conversationId;
    record.lastSeenAt = this.#now().toISOString();
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  bindVerifiedRedirect(
    pageKey: string,
    input: BindPageInput & { readonly previousConversationId: string },
  ): PageBindingSnapshot {
    const record = this.#requireRecord(pageKey);
    this.refreshPage(pageKey);
    if (
      !input.previousConversationId.startsWith('WEB:') ||
      input.conversationId.startsWith('WEB:') ||
      record.state !== 'identity_lost' ||
      record.sessionId !== input.sessionId ||
      record.generation !== input.generation ||
      (record.expectedConversationId !== input.previousConversationId &&
        record.expectedConversationId !== null) ||
      record.conversationId !== input.conversationId
    ) {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} cannot accept a redirected conversation identity`,
      );
    }
    record.expectedConversationId = input.conversationId;
    record.lastSeenAt = this.#now().toISOString();
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  reserveRedirectCandidate(
    pageKey: string,
    input: BindPageInput & { readonly previousConversationId: string },
  ): PageBindingSnapshot {
    const record = this.#requireRecord(pageKey);
    this.refreshPage(pageKey);
    if (
      record.state !== 'unbound' ||
      record.sessionId !== null ||
      record.conversationId !== input.conversationId ||
      !input.previousConversationId.startsWith('WEB:') ||
      input.conversationId.startsWith('WEB:')
    ) {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} cannot be reserved for redirect verification`,
      );
    }
    record.sessionId = input.sessionId;
    record.generation = input.generation;
    record.expectedConversationId = input.previousConversationId;
    record.lastSeenAt = this.#now().toISOString();
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  reservePage(pageKey: string, input: ReservePageInput): PageBindingSnapshot {
    const record = this.#requireRecord(pageKey);
    this.refreshPage(pageKey);
    if (record.state === 'closed' || record.page.isClosed()) {
      throw new PageRegistryError('browser.unavailable', `Page ${pageKey} is closed`);
    }
    if (record.state === 'conflict') {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} is quarantined by a duplicate conversation conflict`,
      );
    }
    if (record.sessionId !== null && record.sessionId !== input.sessionId) {
      this.#metrics?.increment('wrong_session_total');
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} is reserved by another session`,
      );
    }

    const expectedConversationId = input.conversationId ?? null;
    if (expectedConversationId === null && record.conversationId !== null) {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} already has a provider conversation identity`,
      );
    }
    if (
      expectedConversationId !== null &&
      record.conversationId !== expectedConversationId
    ) {
      throw new PageRegistryError(
        'session.conversation-mismatch',
        `Page ${pageKey} is not at conversation ${expectedConversationId}`,
      );
    }

    record.sessionId = input.sessionId;
    record.generation = input.generation;
    record.expectedConversationId = expectedConversationId;
    record.lastSeenAt = this.#now().toISOString();
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  unbindPage(pageKey: string): PageBindingSnapshot {
    const record = this.#requireRecord(pageKey);
    record.sessionId = null;
    record.generation = null;
    record.expectedConversationId = null;
    record.lastSeenAt = this.#now().toISOString();
    this.#reconcileConflicts();
    this.#emit(record);
    return this.#snapshot(record);
  }

  getBinding(pageKey: string): PageBindingSnapshot {
    return this.#snapshot(this.#requireRecord(pageKey));
  }

  listBindings(options: { readonly includeClosed?: boolean } = {}): readonly PageBindingSnapshot[] {
    const includeClosed = options.includeClosed ?? true;
    return [...this.#records.values()]
      .filter((record) => includeClosed || record.state !== 'closed')
      .map((record) => this.#snapshot(record));
  }

  findByConversation(conversationId: string): readonly PageBindingSnapshot[] {
    return [...this.#records.values()]
      .filter((record) => record.state !== 'closed' && record.conversationId === conversationId)
      .map((record) => this.#snapshot(record));
  }

  pageForObservation(pageKey: string, expectedEpoch?: number): Page {
    const record = this.#requireRecord(pageKey);
    if (record.state === 'closed' || record.page.isClosed()) {
      throw new PageRegistryError('browser.unavailable', `Page ${pageKey} is closed`);
    }
    if (expectedEpoch !== undefined && record.bindingEpoch !== expectedEpoch) {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} binding epoch changed`,
      );
    }
    return record.page;
  }

  requireOwnedPage(
    pageKey: string,
    expected: { readonly sessionId: string; readonly conversationId: string; readonly generation?: number },
  ): Page {
    const record = this.#requireRecord(pageKey);
    this.refreshPage(pageKey);
    if (record.state === 'conflict') {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} is quarantined by a duplicate conversation conflict`,
      );
    }
    if (
      record.state !== 'owned' ||
      record.sessionId !== expected.sessionId ||
      record.conversationId !== expected.conversationId ||
      (expected.generation !== undefined && record.generation !== expected.generation)
    ) {
      if (record.sessionId !== expected.sessionId) {
        this.#metrics?.increment('wrong_session_total');
      }
      if (expected.generation !== undefined && record.generation !== expected.generation) {
        this.#metrics?.increment('wrong_generation_total');
      }
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} ownership does not match the requested session identity`,
      );
    }
    return record.page;
  }

  requireSessionPage(
    pageKey: string,
    expected: {
      readonly sessionId: string;
      readonly generation?: number;
      readonly conversationId?: string | null;
    },
  ): Page {
    const record = this.#requireRecord(pageKey);
    this.refreshPage(pageKey);
    if (record.state === 'closed' || record.page.isClosed()) {
      throw new PageRegistryError('browser.unavailable', `Page ${pageKey} is closed`);
    }
    if (record.state === 'conflict' || record.state === 'identity_lost') {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} does not have verifiable session ownership`,
      );
    }
    if (
      record.sessionId !== expected.sessionId ||
      (expected.generation !== undefined && record.generation !== expected.generation)
    ) {
      if (record.sessionId !== expected.sessionId) {
        this.#metrics?.increment('wrong_session_total');
      }
      if (expected.generation !== undefined && record.generation !== expected.generation) {
        this.#metrics?.increment('wrong_generation_total');
      }
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} ownership does not match the requested session`,
      );
    }
    const expectedConversationId = expected.conversationId ?? null;
    const exactConversation =
      expectedConversationId === null
        ? record.state === 'reserved'
        : record.state === 'owned' && record.conversationId === expectedConversationId;
    if (!exactConversation) {
      throw new PageRegistryError(
        'session.page-identity-unverified',
        `Page ${pageKey} conversation ownership is not exact`,
      );
    }
    return record.page;
  }

  subscribe(listener: (snapshot: PageBindingSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #markClosed(record: PageRecord): void {
    if (record.state === 'closed') {
      return;
    }
    record.state = 'closed';
    record.lastSeenAt = this.#now().toISOString();
    record.conflictOwnerPageKey = null;
    record.duplicatePageKeys = [];
    this.#reconcileConflicts();
    this.#emit(record);
  }

  #reconcileConflicts(): void {
    const active = [...this.#records.values()].filter((record) => record.state !== 'closed');
    for (const record of active) {
      record.state = this.#baseState(record);
      record.conflictOwnerPageKey = null;
      record.duplicatePageKeys = [];
    }

    const groups = new Map<string, PageRecord[]>();
    for (const record of active) {
      if (record.conversationId === null) {
        continue;
      }
      const group = groups.get(record.conversationId) ?? [];
      group.push(record);
      groups.set(record.conversationId, group);
    }

    const nextConflictFingerprints = new Set<string>();
    for (const [conversationId, group] of groups) {
      if (group.length < 2) {
        continue;
      }
      group.sort((left, right) => {
        const leftBound = left.expectedConversationId === left.conversationId ? 0 : 1;
        const rightBound = right.expectedConversationId === right.conversationId ? 0 : 1;
        return leftBound - rightBound || left.registrationOrder - right.registrationOrder;
      });
      const owner = group[0];
      if (owner === undefined) {
        continue;
      }
      const allKeys = group.map((record) => record.pageKey);
      const fingerprint = `${conversationId}\u0000${[...allKeys].sort().join('\u0000')}`;
      nextConflictFingerprints.add(fingerprint);
      if (!this.#conflictFingerprints.has(fingerprint)) {
        this.#metrics?.increment('page_binding_conflict_total');
      }
      for (const record of group) {
        record.state = 'conflict';
        record.conflictOwnerPageKey = owner.pageKey;
        record.duplicatePageKeys = allKeys.filter((pageKey) => pageKey !== record.pageKey);
      }
    }
    this.#conflictFingerprints = nextConflictFingerprints;
  }

  #baseState(record: PageRecord): PageBindingState {
    if (record.expectedConversationId === null) {
      if (record.sessionId === null) {
        return 'unbound';
      }
      return record.conversationId === null ? 'reserved' : 'identity_lost';
    }
    return record.conversationId === record.expectedConversationId ? 'owned' : 'identity_lost';
  }

  #requireRecord(pageKey: string): PageRecord {
    const record = this.#records.get(pageKey);
    if (record === undefined) {
      throw new PageRegistryError('browser.unavailable', `Unknown pageKey: ${pageKey}`);
    }
    return record;
  }

  #snapshot(record: PageRecord): PageBindingSnapshot {
    return Object.freeze({
      pageKey: record.pageKey,
      targetId: record.targetId,
      bindingEpoch: record.bindingEpoch,
      sessionId: record.sessionId,
      generation: record.generation,
      conversationId: record.conversationId,
      expectedConversationId: record.expectedConversationId,
      url: record.url,
      state: record.state,
      lastSeenAt: record.lastSeenAt,
      conflictOwnerPageKey: record.conflictOwnerPageKey,
      duplicatePageKeys: Object.freeze([...record.duplicatePageKeys]),
    });
  }

  #emit(record: PageRecord): void {
    const snapshot = this.#snapshot(record);
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
