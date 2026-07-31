import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Retrieve stored preferences for a user from user_preferences.json. */
export async function getPreferences({ user_id }: { user_id: string }): Promise<string> {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'user_preferences.json'), 'utf-8'));
    const prefs = data[user_id];
    if (!prefs) return `No preferences found for user "${user_id}".`;
    return JSON.stringify(prefs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error reading preferences: ${msg}`;
  }
}

/** Perform a web search for the given query (stub — wire up a real provider). */
export async function webSearch({ query }: { query: string }): Promise<string> {
  return `Search results for '${query}': (stub - wire up a real search provider)`;
}

const LLMS_TXT_URL = 'https://launchdarkly.com/docs/llms.txt';
let llmsTxtCache: string | null = null;

async function getLlmsTxt(): Promise<string> {
  if (llmsTxtCache) return llmsTxtCache;
  const response = await fetch(LLMS_TXT_URL, { headers: { 'User-Agent': 'LD-Docs-Agent/1.0' } });
  if (!response.ok) throw new Error(`Failed to fetch llms.txt: HTTP ${response.status}`);
  llmsTxtCache = await response.text();
  return llmsTxtCache;
}

/** Search LD docs by filtering the llms.txt index and returning matching page URLs. */
export async function searchLdDocumentation({ query }: { query: string }): Promise<string> {
  try {
    const index = await getLlmsTxt();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const results = index
      .split('\n')
      .filter((line) => line.startsWith('- ['))
      .filter((line) => terms.every((term) => line.toLowerCase().includes(term)))
      .slice(0, 10);

    if (results.length === 0) {
      return `No documentation results found for "${query}".`;
    }

    return results.join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Search error: ${msg}`;
  }
}

/**
 * Fetch a LaunchDarkly documentation page.
 * Appends `.md` to get clean Markdown output where available.
 */
export async function fetchLaunchDarklyDocumentation({ url }: { url: string }): Promise<string> {
  try {
    const normalizedUrl = url.replace(/\/$/, '');
    const mdUrl = normalizedUrl.endsWith('.md') ? normalizedUrl : `${normalizedUrl}.md`;

    const response = await fetch(mdUrl, {
      headers: {
        Accept: 'text/markdown,text/plain,*/*',
        'User-Agent': 'LD-Docs-Agent/1.0',
      },
    });

    if (!response.ok) {
      const fallback = await fetch(normalizedUrl, {
        headers: { 'User-Agent': 'LD-Docs-Agent/1.0' },
      });
      if (!fallback.ok) {
        return `Failed to fetch "${url}": HTTP ${response.status}`;
      }
      const html = await fallback.text();
      return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
    }

    const text = await response.text();
    return text.length > 10000 ? `${text.slice(0, 10000)}\n\n[…content truncated…]` : text;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Fetch error: ${msg}`;
  }
}
