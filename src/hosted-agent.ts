import { createHash } from 'node:crypto';
import type { Model, Tool } from '@earendil-works/pi-ai';

export type CustomLlm = Pick<
  Model<'openai-completions' | 'openai-responses'>,
  'id' | 'api' | 'baseUrl' | 'headers'
>;

export interface HostedAgentSpec {
  name: string;
  instructions: string;
  tools: Tool[];
  voice: string;
  llm: string | CustomLlm;
  firstMessage?: string;
  clientToolTimeoutMs?: number;
}

export interface HostedAgent {
  agentId: string;
  specHash: string;
  publishedAt: number;
}

export interface HostedCache {
  get(key: string): HostedAgent | undefined;
  set(key: string, agent: HostedAgent): void;
}

export function memoryHostedCache(): HostedCache {
  const agents = new Map<string, HostedAgent>();
  return {
    get(key) {
      return agents.get(key);
    },
    set(key, agent) {
      agents.set(key, agent);
    },
  };
}

export function hostedCacheKey(provider: string, name: string): string {
  return `${provider}\0${name}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const next = source[key];
    if (next !== undefined) out[key] = stable(next);
  }
  return out;
}

export function hashHostedSpec(spec: HostedAgentSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(spec)))
    .digest('hex');
}
