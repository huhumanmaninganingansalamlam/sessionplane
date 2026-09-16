export type PageBindingState = 'unbound' | 'owned' | 'identity_lost' | 'conflict' | 'closed';

export interface PageBindingSnapshot {
  readonly pageKey: string;
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

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,}$/;

export function parseChatGptConversationId(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (!CHATGPT_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  let segments: string[];
  try {
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const conversationMarker = segments.lastIndexOf('c');
  if (conversationMarker < 0) {
    return null;
  }
  const candidate = segments[conversationMarker + 1];
  return candidate !== undefined && CONVERSATION_ID.test(candidate) ? candidate : null;
}

export function isChatGptUrl(value: string): boolean {
  try {
    return CHATGPT_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

