import { createHash } from 'node:crypto';

export interface ExtractedLink {
  readonly url: string;
  readonly text: string;
  readonly rel: string | null;
}

export interface ExtractedHeading {
  readonly level: number;
  readonly text: string;
}

export interface ExtractedDocument {
  readonly schemaVersion: 'sessionplane-extracted-document-v1';
  readonly url: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly description: string;
  readonly siteName: string;
  readonly author: string;
  readonly publishedAt: string | null;
  readonly language: string | null;
  readonly text: string;
  readonly markdown: string;
  readonly html: string | null;
  readonly headings: readonly ExtractedHeading[];
  readonly links: readonly ExtractedLink[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly jsonLd: readonly unknown[];
  readonly wordCount: number;
  readonly contentHash: string;
  readonly truncated: boolean;
}

export interface HtmlExtractionOptions {
  readonly maxChars?: number;
  readonly maxLinks?: number;
  readonly includeHtml?: boolean;
}

const DEFAULT_MAX_CHARS = 500_000;
const DEFAULT_MAX_LINKS = 1_000;

export function extractHtmlDocument(
  html: string,
  sourceUrl: string,
  options: HtmlExtractionOptions = {},
): ExtractedDocument {
  const maxChars = positiveLimit(options.maxChars, DEFAULT_MAX_CHARS, 'maxChars');
  const maxLinks = positiveLimit(options.maxLinks, DEFAULT_MAX_LINKS, 'maxLinks');
  const metadata = extractMetadata(html);
  const primaryHtml = choosePrimaryContent(stripUnsafeBlocks(html));
  const markdownUnbounded = normalizeMarkdown(htmlToMarkdown(primaryHtml, sourceUrl));
  const textUnbounded = normalizeText(markdownToText(markdownUnbounded));
  const truncated = textUnbounded.length > maxChars || markdownUnbounded.length > maxChars;
  const text = truncateAtBoundary(textUnbounded, maxChars);
  const markdown = truncateAtBoundary(markdownUnbounded, maxChars);
  const title = firstNonEmpty(
    metadata['og:title'],
    metadata['twitter:title'],
    extractTagText(html, 'title'),
    extractTagText(primaryHtml, 'h1'),
  );
  const description = firstNonEmpty(
    metadata.description,
    metadata['og:description'],
    metadata['twitter:description'],
  );
  const siteName = firstNonEmpty(metadata['og:site_name'], hostnameLabel(sourceUrl));
  const author = firstNonEmpty(metadata.author, metadata['article:author']);
  const publishedAt = nullable(
    firstNonEmpty(
      metadata['article:published_time'],
      metadata.date,
      metadata['datepublished'],
      extractTimeValue(html),
    ),
  );
  const language = nullable(
    firstNonEmpty(extractHtmlLanguage(html), metadata['content-language'], metadata['og:locale']),
  );
  const canonicalUrl = resolveOptionalUrl(
    extractLinkHref(html, 'canonical') ?? metadata['og:url'] ?? null,
    sourceUrl,
  );
  const headings = extractHeadings(primaryHtml);
  const links = extractLinks(primaryHtml, sourceUrl, maxLinks);
  const jsonLd = extractJsonLd(html);
  const contentHash = createHash('sha256').update(text).digest('hex');

  return Object.freeze({
    schemaVersion: 'sessionplane-extracted-document-v1',
    url: sourceUrl,
    canonicalUrl,
    title,
    description,
    siteName,
    author,
    publishedAt,
    language,
    text,
    markdown,
    html: options.includeHtml === true ? truncateAtBoundary(primaryHtml, maxChars) : null,
    headings: Object.freeze(headings),
    links: Object.freeze(links),
    metadata: Object.freeze(metadata),
    jsonLd: Object.freeze(jsonLd),
    wordCount: countWords(text),
    contentHash,
    truncated,
  });
}

function extractMetadata(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  const metaPattern = /<meta\b([^>]*?)>/gi;
  for (const match of html.matchAll(metaPattern)) {
    const attributes = parseAttributes(match[1] ?? '');
    const key = (attributes.name ?? attributes.property ?? attributes['http-equiv'] ?? '')
      .trim()
      .toLowerCase();
    const value = decodeHtml(attributes.content ?? '').trim();
    if (key !== '' && value !== '' && result[key] === undefined) result[key] = value;
  }
  return result;
}

function extractJsonLd(html: string): unknown[] {
  const values: unknown[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = decodeHtml(match[1] ?? '').trim();
    if (raw === '' || raw.length > 2_000_000) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) values.push(...parsed);
      else values.push(parsed);
    } catch {
      // Invalid third-party JSON-LD is ignored; the rest of the page remains usable.
    }
  }
  return values.slice(0, 100);
}

function choosePrimaryContent(html: string): string {
  const candidates = [
    ...extractTagBlocks(html, 'article'),
    ...extractTagBlocks(html, 'main'),
    ...extractTagBlocks(html, 'body'),
  ];
  if (candidates.length === 0) return html;
  candidates.sort((left, right) => visibleLength(right) - visibleLength(left));
  const best = candidates[0] ?? html;
  return visibleLength(best) >= 80 ? best : html;
}

function extractTagBlocks(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  return [...html.matchAll(pattern)].map((match) => match[1] ?? '').filter(Boolean);
}

function stripUnsafeBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

function htmlToMarkdown(html: string, sourceUrl: string): string {
  const codeBlocks: string[] = [];
  let value = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_full, body: string) => {
    const code = normalizeText(decodeHtml(stripTags(body))).trim();
    const marker = `SESSIONPLANE_CODE_BLOCK_${codeBlocks.length}`;
    codeBlocks.push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
    return marker;
  });

  value = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_full, level: string, body: string) =>
      `\n\n${'#'.repeat(Number(level))} ${decodeHtml(stripTags(body)).trim()}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_full, body: string) =>
      `\n- ${decodeHtml(stripTags(body)).trim()}`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_full, body: string) =>
      `\n\n> ${decodeHtml(stripTags(body)).trim().replaceAll('\n', '\n> ')}\n\n`)
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_full, attributesText: string, body: string) => {
      const attributes = parseAttributes(attributesText);
      const text = decodeHtml(stripTags(body)).trim();
      const url = resolveOptionalUrl(attributes.href ?? null, sourceUrl);
      if (text === '') return '';
      return url === null ? text : `[${text}](${url})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_full, body: string) =>
      `\`${decodeHtml(stripTags(body)).trim().replaceAll('`', '\\`')}\``)
    .replace(/<(p|div|section|header|main|article|table|tr|ul|ol|dl|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|header|main|article|table|tr|ul|ol|dl|figure|figcaption)>/gi, '\n')
    .replace(/<td\b[^>]*>/gi, ' | ')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  value = decodeHtml(value);
  codeBlocks.forEach((block, index) => {
    value = value.replace(`SESSIONPLANE_CODE_BLOCK_${index}`, block);
  });
  return value;
}

function extractLinks(html: string, sourceUrl: string, limit: number): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    if (links.length >= limit) break;
    const attributes = parseAttributes(match[1] ?? '');
    const url = resolveOptionalUrl(attributes.href ?? null, sourceUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      text: normalizeText(decodeHtml(stripTags(match[2] ?? ''))).trim(),
      rel: nullable(attributes.rel ?? ''),
    });
  }
  return links;
}

function extractHeadings(html: string): ExtractedHeading[] {
  const headings: ExtractedHeading[] = [];
  const pattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const text = normalizeText(decodeHtml(stripTags(match[2] ?? ''))).trim();
    if (text !== '') headings.push({ level: Number(match[1]), text });
  }
  return headings.slice(0, 500);
}

function extractTagText(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html);
  return match === null ? '' : normalizeText(decodeHtml(stripTags(match[1] ?? ''))).trim();
}

function extractHtmlLanguage(html: string): string {
  const match = /<html\b([^>]*)>/i.exec(html);
  return match === null ? '' : parseAttributes(match[1] ?? '').lang ?? '';
}

function extractLinkHref(html: string, rel: string): string | null {
  const pattern = /<link\b([^>]*?)>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = parseAttributes(match[1] ?? '');
    if ((attributes.rel ?? '').toLowerCase().split(/\s+/).includes(rel)) {
      return attributes.href ?? null;
    }
  }
  return null;
}

function extractTimeValue(html: string): string {
  const match = /<time\b([^>]*)>([\s\S]*?)<\/time>/i.exec(html);
  if (match === null) return '';
  const attributes = parseAttributes(match[1] ?? '');
  return attributes.datetime ?? decodeHtml(stripTags(match[2] ?? '')).trim();
}

function parseAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of value.matchAll(pattern)) {
    const key = (match[1] ?? '').toLowerCase();
    if (key === '') continue;
    result[key] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? key);
  }
  return result;
}

function decodeHtml(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    rdquo: '”',
    rsquo: '’',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (_entity, token: string) => {
    if (token.startsWith('#x') || token.startsWith('#X')) {
      const codePoint = Number.parseInt(token.slice(2), 16);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : '�';
    }
    if (token.startsWith('#')) {
      const codePoint = Number.parseInt(token.slice(1), 10);
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : '�';
    }
    return named[token.toLowerCase()] ?? `&${token};`;
  });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function normalizeMarkdown(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markdownToText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```\n?|\n?```$/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '');
}

function truncateAtBoundary(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const candidate = value.slice(0, limit);
  const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('. '));
  return `${candidate.slice(0, boundary >= limit * 0.7 ? boundary + 1 : limit).trimEnd()}\n…`;
}

function resolveOptionalUrl(value: string | null, base: string): string | null {
  if (value === null || value.trim() === '') return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized !== undefined && normalized !== '') return normalized;
  }
  return '';
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function hostnameLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function visibleLength(value: string): number {
  return normalizeText(decodeHtml(stripTags(value))).length;
}

function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be positive`);
  return result;
}
