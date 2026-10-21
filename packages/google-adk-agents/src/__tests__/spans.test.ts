/**
 * Span helpers. Reference: TESTING.md §2.x.3.
 */
import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { abandonOpenSpans, startModelSpan, startRootSpan, startToolSpan } from '../spans.js';

const config = {
  model: { name: 'gemini-2.5-flash' },
  provider: { name: 'Google' },
  instructions: 'Be helpful.',
};

describe('ADK spans', () => {
  it('writes framework and serving-provider identity on the root only', () => {
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
      events: string[];
      end: ReturnType<typeof vi.fn>;
    }> = [];
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: (name: string) => {
        const span = {
          name,
          attributes: {} as Record<string, unknown>,
          events: [] as string[],
          setAttribute(key: string, value: unknown) {
            this.attributes[key] = value;
          },
          addEvent(eventName: string) {
            this.events.push(eventName);
          },
          end: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
        };
        spans.push(span);
        return span;
      },
    } as never);

    const root = startRootSpan(config, {
      __ld: { configKey: 'cfg', variationKey: 'var', runId: 'run-1' },
      ldContext: { kind: 'user', key: 'user-1' },
    });
    const model = startModelSpan(config, root);
    const tool = startToolSpan('lookup', 'call-1', root);
    expect(spans[0]?.name).toBe('invoke_agent');
    expect(spans[0]?.attributes['gen_ai.system']).toBe('google_adk');
    expect(spans[0]?.attributes['gen_ai.provider.name']).toBe('gcp.gemini');
    expect(spans[0]?.events).toContain('feature_flag');
    expect(model.name).toBe('chat gemini-2.5-flash');
    expect(tool.name).toBe('execute_tool lookup');
    expect(model.attributes['launchdarkly.config.key']).toBeUndefined();

    const failSpan = vi.fn();
    abandonOpenSpans([tool], new Set());
    expect(tool.end).toHaveBeenCalled();
    expect(failSpan).not.toHaveBeenCalled();
  });
});
