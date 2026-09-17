export type PageBindingState =
  | 'unbound'
  | 'reserved'
  | 'owned'
  | 'identity_lost'
  | 'conflict'
  | 'closed';

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

export interface ReservePageInput {
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId?: string | null;
}

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const GEMINI_HOSTS = new Set(['gemini.google.com']);
const GROK_HOSTS = new Set(['grok.com', 'x.com']);
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

export function parseProviderConversationId(value: string): string | null {
  const chatGpt = parseChatGptConversationId(value);
  if (chatGpt !== null) {
    return chatGpt;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const segments = safeSegments(url.pathname);
  if (segments === null) {
    return null;
  }

  if (GEMINI_HOSTS.has(hostname)) {
    const marker = segments.lastIndexOf('app');
    const candidate = marker < 0 ? undefined : segments[marker + 1];
    return candidate !== undefined && CONVERSATION_ID.test(candidate) ? candidate : null;
  }

  if (GROK_HOSTS.has(hostname)) {
    for (const markerName of ['c', 'chat', 'conversation']) {
      const marker = segments.lastIndexOf(markerName);
      const candidate = marker < 0 ? undefined : segments[marker + 1];
      if (candidate !== undefined && CONVERSATION_ID.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function isProviderUrl(provider: string, value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (provider === 'chatgpt') return CHATGPT_HOSTS.has(hostname);
  if (provider === 'gemini') return GEMINI_HOSTS.has(hostname);
  if (provider === 'grok') return GROK_HOSTS.has(hostname);
  return false;
}

function safeSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

