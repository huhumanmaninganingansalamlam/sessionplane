export function limitationHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
    'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    const value = headers[name]?.trim();
    if (value && value.length <= 80 && /^(?:\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+)$/.test(value)) safe[name] = value;
  }
  for (const name of ['ratelimit-scope', 'x-ratelimit-scope']) {
    const value = headers[name]?.trim().toLowerCase();
    if (value && /^(account|user|ip|endpoint|route|model|global)$/.test(value)) safe[name] = value;
  }
  return safe;
}

