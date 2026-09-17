import assert from 'node:assert/strict';
import test from 'node:test';

import { extractHtmlDocument } from '../../src/fetch/html-extractor.ts';

test('HTML extractor returns bounded metadata, markdown, links, headings, and JSON-LD', () => {
  const document = extractHtmlDocument(
    `<!doctype html>
      <html lang="ko">
        <head>
          <title>Fallback title</title>
          <link rel="canonical" href="/canonical">
          <meta property="og:title" content="Evidence title">
          <meta name="description" content="Evidence description">
          <meta property="article:published_time" content="2026-09-17T00:00:00Z">
          <script type="application/ld+json">{"@type":"Article","headline":"Evidence title"}</script>
          <style>body { display:none }</style>
        </head>
        <body>
          <nav>navigation noise</nav>
          <article>
            <h1>Evidence title</h1>
            <p>Primary <strong>source</strong> body with enough useful words.</p>
            <a href="/source?utm_source=test#fragment">Official source</a>
            <pre>const answer = 42;</pre>
          </article>
          <footer>footer noise</footer>
        </body>
      </html>`,
    'https://example.com/article',
    { includeHtml: true },
  );

  assert.equal(document.title, 'Evidence title');
  assert.equal(document.description, 'Evidence description');
  assert.equal(document.canonicalUrl, 'https://example.com/canonical');
  assert.equal(document.language, 'ko');
  assert.equal(document.publishedAt, '2026-09-17T00:00:00Z');
  assert.match(document.markdown, /# Evidence title/);
  assert.match(document.markdown, /\*\*source\*\*/);
  assert.match(document.markdown, /```[\s\S]*const answer = 42/);
  assert.doesNotMatch(document.text, /navigation noise|footer noise|display:none/);
  assert.equal(document.headings[0]?.text, 'Evidence title');
  assert.equal(document.links[0]?.url, 'https://example.com/source?utm_source=test');
  assert.equal((document.jsonLd[0] as Record<string, unknown>).headline, 'Evidence title');
  assert.equal(document.contentHash.length, 64);
  assert.ok(document.wordCount > 5);
  assert.notEqual(document.html, null);
});

test('HTML extractor selects the largest primary content and enforces output bounds', () => {
  const document = extractHtmlDocument(
    `<html><body><main><h2>Long</h2><p>${'word '.repeat(500)}</p></main></body></html>`,
    'https://example.com/',
    { maxChars: 120 },
  );
  assert.equal(document.truncated, true);
  assert.ok(document.text.length <= 122);
  assert.ok(document.markdown.length <= 122);
});

test('HTML extractor ignores malformed JSON-LD without dropping page text', () => {
  const document = extractHtmlDocument(
    '<html><head><script type="application/ld+json">{broken</script></head><body><article>Readable body</article></body></html>',
    'https://example.com/',
  );
  assert.deepEqual(document.jsonLd, []);
  assert.equal(document.text, 'Readable body');
});
