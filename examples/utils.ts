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

export function writeOutput(data: unknown): void {
  const dir = join(__dirname, '..', 'output');
  mkdirSync(dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
}
