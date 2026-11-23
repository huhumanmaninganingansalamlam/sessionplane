export type PageBindingState =
  | 'unbound'
  | 'reserved'
  | 'owned'
  | 'identity_lost'
  | 'conflict'
  | 'closed';

export interface PageBindingSnapshot {
  readonly pageKey: string;
  readonly targetId?: string | null;
  readonly bindingEpoch: number;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly conversationId: string | null;
  readonly expectedConversationId: string | null;
  readonly url: string;
  readonly state: PageBindingState;
  readonly lastSeenAt: string;
  readonly conflictOwnerPageKey: string | null;
  readonly duplicatePageKeys: readonly string[];
}

export interface BindPageInput {
  readonly sessionId: string;
  readonly generation: number | null;
  readonly conversationId: string;
}

export interface ReservePageInput {
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId?: string | null;
}
