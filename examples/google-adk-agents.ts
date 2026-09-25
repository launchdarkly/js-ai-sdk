import { googleAdkAgents } from '@launchdarkly/ai-google-adk-agents';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

/**
 * Gemini Developer API is the default (`GOOGLE_API_KEY`, `GEMINI_API_KEY`, or
 * `GOOGLE_GENAI_API_KEY`). Pass `{ useVertexai: true, project, location }` to use Vertex.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const response = await googleAdkAgents(key, userInput, newContext(), {
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
      'web-search': webSearch,
    },
  });
  writeOutput(response);
}
