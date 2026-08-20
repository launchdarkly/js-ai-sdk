import 'dotenv/config';
import { initClient, shutdown } from '@launchdarkly/ai-node';
import * as agent from './examples/agent';
import * as claudeAgents from './examples/claude-agents';
import * as claudeMessages from './examples/claude-messages';
import * as graph from './examples/graph';
import * as history from './examples/history';
import * as judge from './examples/judge';
import * as langchain from './examples/langchain';
import * as langchainAgents from './examples/langchain-agents';
import * as langchainMessages from './examples/langchain-messages';
import * as nativeGraph from './examples/native-graph';
import * as nativeGraphLangchain from './examples/native-graph-langchain';
import * as openaiAgents from './examples/openai-agents';
import * as openaiMessages from './examples/openai-messages';
import * as openaiOnly from './examples/openai-only';
import * as streaming from './examples/streaming';

type Example =
  | 'agent'
  | 'claude-agents'
  | 'claude-messages'
  | 'graph'
  | 'history'
  | 'judge'
  | 'langchain'
  | 'langchain-agents'
  | 'langchain-messages'
  | 'native-graph'
  | 'native-graph-langchain'
  | 'openai-agents'
  | 'openai-messages'
  | 'openai-only'
  | 'streaming';

const EXAMPLES: Record<Example, { run: (key: string, userInput: string) => Promise<void> }> = {
  agent: agent,
  'claude-agents': claudeAgents,
  'claude-messages': claudeMessages,
  graph: graph,
  history: history,
  judge: judge,
  langchain: langchain,
  'langchain-agents': langchainAgents,
  'langchain-messages': langchainMessages,
  'native-graph': nativeGraph,
  'native-graph-langchain': nativeGraphLangchain,
  'openai-agents': openaiAgents,
  'openai-messages': openaiMessages,
  'openai-only': openaiOnly,
  streaming: streaming,
};

function parseArgs(): { example: Example; key: string; userInput: string } {
  const [example, key, userInput] = process.argv.slice(2);
  const trimmed = example?.trim() as Example;
  return {
    example: trimmed in EXAMPLES ? trimmed : 'agent',
    key: key?.trim() ?? 'launch-darkly-documentation-summarizer',
    userInput: userInput?.trim() ?? 'What is the launchdarkly AI SDK?',
  };
}

async function main() {
  const { example, key, userInput } = parseArgs();
  // Initialize before running an example. Lazy init would otherwise happen inside the first SDK
  // call — after `withConversationId` has already tried to bind — and the OTel context manager it
  // registers would not exist yet, so the first run's spans would carry no conversation id.
  await initClient();
  await EXAMPLES[example].run(key, userInput);
  await shutdown();
}

main().catch(async (err) => {
  process.stdout.write('\n');
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  // Flush before exiting. A failed run is exactly when its trace is most worth having, and the
  // BatchSpanProcessor drops everything it is holding if the process exits without a shutdown —
  // so error runs used to produce no telemetry at all.
  try {
    await shutdown();
  } catch {
    // Never let a shutdown failure mask the original error.
  }
  process.exit(1);
});
