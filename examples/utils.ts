import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function newContext() {
  return {
    kind: 'user' as const,
    key: Math.random().toString(36).substring(2, 15),
  };
}

/**
 * A fresh conversation id per run.
 *
 * A constant would collapse every run — by every developer, and every CI pass — into one
 * ever-growing conversation in LaunchDarkly's view: a misleading demo of the very feature it is
 * demonstrating. An id should be stable across the turns of one conversation and distinct across
 * conversations.
 */
export function newConversationId(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

export function writeOutput(data: unknown): void {
  const dir = join(__dirname, '..', 'output');
  mkdirSync(dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
}
