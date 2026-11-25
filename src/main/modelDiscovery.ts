import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { OllamaCliRunner } from '@infra/ollama-cli';
import { OLLAMA_CLI_PROVIDER_ID, LLAMA_SERVER_PROVIDER_ID, CODEX_CLI_PROVIDER_ID } from '@domain/constants';
import type { ModelInfo } from '@domain/types';

/** Startup discovery of the models each local provider offers. Electron-free. */

export async function fetchCodexModels(fallback: ModelInfo[]): Promise<ModelInfo[]> {
  const fallbackModels = normalizeCodexModels(fallback);
  const homeDir = process.env.HOME;
  if (!homeDir) return fallbackModels;

  try {
    const cachePath = path.join(homeDir, '.codex', 'models_cache.json');
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const ids = new Set<string>();
    collectCodexModelIds(parsed, ids, 0);
    const discovered = normalizeCodexModels([...ids].map((id) => ({
      id,
      label: prettifyModelLabel(id),
      description: `Codex model — ${id}`,
      providerId: CODEX_CLI_PROVIDER_ID,
      supportsThinking: true,
      supportsToolUse: true,
    })));
    if (discovered.length > 0) {
      return discovered;
    }
  } catch {
    // Missing or unparseable cache — fall back to built-in defaults.
  }

  return fallbackModels;
}

export function normalizeCodexModels(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    ...model,
    providerId: CODEX_CLI_PROVIDER_ID,
    supportsThinking: true,
    supportsToolUse: true,
  }));
}

function collectCodexModelIds(value: unknown, ids: Set<string>, depth: number): void {
  if (depth > 4 || value === null || value === undefined) return;

  if (typeof value === 'string') {
    if (looksLikeModelId(value)) ids.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectCodexModelIds(item, ids, depth + 1);
    return;
  }

  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'model', 'name']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && looksLikeModelId(candidate)) {
      ids.add(candidate);
    }
  }
  for (const nested of Object.values(record)) {
    collectCodexModelIds(nested, ids, depth + 1);
  }
}

function looksLikeModelId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]*$/i.test(value) && value.includes('-');
}

function prettifyModelLabel(id: string): string {
  return id
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase() === 'GPT' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── Ollama Model Discovery ────────────────────────────────────────

function isLocalOllamaBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost');
  }
}

export async function fetchOllamaModels(ollamaBaseUrl: string, runner: OllamaCliRunner): Promise<ModelInfo[]> {
  if (isLocalOllamaBaseUrl(ollamaBaseUrl)) {
    const cliModels = await runner.listModels();
    const models: ModelInfo[] = cliModels.map((model) => ({
      id: model.name,
      label: model.name.replace(/:latest$/, ''),
      description: `Ollama model — ${model.name}`,
      providerId: OLLAMA_CLI_PROVIDER_ID,
      supportsThinking: false,
      supportsToolUse: true,
    }));

    await Promise.allSettled(models.map(async (model) => {
      model.contextWindow = await runner.showModelContext(model.id);
    }));

    return models;
  }

  try {
    const resp = await fetch(`${ollamaBaseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return [];

    const data = await resp.json() as { models?: { name: string }[] };
    const models: ModelInfo[] = (data.models ?? []).map((model) => ({
      id: model.name,
      label: model.name.replace(/:latest$/, ''),
      description: `Ollama model — ${model.name}`,
      providerId: OLLAMA_CLI_PROVIDER_ID,
      supportsThinking: false,
      supportsToolUse: true,
    }));

    await Promise.allSettled(models.map(async (model) => {
      try {
        const r = await fetch(`${ollamaBaseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model.id }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!r.ok) return;
        const d = await r.json() as Record<string, unknown>;
        const mi = d.model_info as Record<string, unknown> | undefined;
        if (!mi) return;
        for (const [k, v] of Object.entries(mi)) {
          if (k.endsWith('.context_length') && typeof v === 'number') {
            model.contextWindow = v;
            break;
          }
        }
      } catch { /* contextWindow stays undefined */ }
    }));

    return models;
  } catch {
    console.warn('[startup] Failed to fetch remote Ollama models');
    return [];
  }
}

// ── llama-server Model Discovery ─────────────────────────────────

/**
 * Fetch models from a llama-server instance via `/v1/models`.
 * llama-server typically serves a single model, but the endpoint
 * returns it in OpenAI format.
 */
export async function fetchLlamaServerModels(baseUrl: string): Promise<ModelInfo[]> {
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const models: ModelInfo[] = (data.data ?? []).map((m) => ({
      id: m.id,
      label: m.id.split('/').pop() ?? m.id,
      description: `llama-server model — ${m.id}`,
      providerId: LLAMA_SERVER_PROVIDER_ID,
      supportsThinking: true,  // assume reasoning model per user
      supportsToolUse: true,
    }));
    return models;
  } catch {
    console.warn('[startup] Failed to fetch llama-server models');
    return [];
  }
}
