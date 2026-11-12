import type { AgentName, CreativeAgentName } from '@domain/types';
import type { ReadGuidance } from '@domain/constants';
import { AGENT_READ_GUIDANCE, CHAPTER_NOTES_PATTERN, CREATIVE_AGENT_NAMES } from '@domain/constants';

/**
 * Path rules from AGENT_READ_GUIDANCE, matched against book-relative paths.
 *
 * Rule forms:
 *   - `dir/`              — directory prefix (matches everything under it)
 *   - `chapters/*\/x.md`  — `*` matches exactly one path segment
 *   - anything else       — exact path
 */
export function matchesReadRule(path: string, rule: string): boolean {
  if (rule.endsWith('/')) return path.startsWith(rule);
  if (!rule.includes('*')) return path === rule;
  const escaped = rule
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`).test(path);
}

/** Read guidance for a creative agent, or null for Wrangler/unknown agents. */
export function getReadGuidance(agentName: AgentName): ReadGuidance | null {
  if (!CREATIVE_AGENT_NAMES.includes(agentName as CreativeAgentName)) return null;
  return AGENT_READ_GUIDANCE[agentName as CreativeAgentName] ?? null;
}

/** True when the agent's guidance lists the path under `neverRead`. */
export function isNeverRead(agentName: AgentName, path: string): boolean {
  const guidance = getReadGuidance(agentName);
  if (!guidance) return false;
  return guidance.neverRead.some((rule) => matchesReadRule(path, rule));
}

/** Drop entries the agent must never read. */
export function filterNeverRead<T extends { path: string }>(files: T[], agentName: AgentName): T[] {
  return files.filter((f) => !isNeverRead(agentName, f.path));
}

/** Files the agent reads only after its main pass (`readAfter`), or [] if none. */
export function readAfterRules(agentName: AgentName): string[] {
  return getReadGuidance(agentName)?.readAfter ?? [];
}

/**
 * True when a multi-call read step must not see the path: it is on the
 * agent's `neverRead` list, or on its `readAfter` list (a read step is
 * still mid-pass, so "after the pass" has not happened yet).
 */
export function isSkippedDuringRead(agentName: AgentName, path: string): boolean {
  return isNeverRead(agentName, path) || readAfterRules(agentName).some((rule) => matchesReadRule(path, rule));
}

/** Drop entries a multi-call read step must not see (neverRead + readAfter). */
export function filterForReadStep<T extends { path: string }>(files: T[], agentName: AgentName): T[] {
  return files.filter((f) => !isSkippedDuringRead(agentName, f.path));
}

/**
 * How the agent treats per-chapter author notes:
 *   - 'read'   — listed in alwaysRead or readIfRelevant (Lumen, Sable)
 *   - 'never'  — listed in neverRead (Ghostlight)
 *   - 'unspecified' — no rule
 */
export function chapterNotesRule(agentName: AgentName): 'read' | 'never' | 'unspecified' {
  const guidance = getReadGuidance(agentName);
  if (!guidance) return 'unspecified';
  if (guidance.neverRead.includes(CHAPTER_NOTES_PATTERN)) return 'never';
  if (
    guidance.alwaysRead.includes(CHAPTER_NOTES_PATTERN) ||
    guidance.readIfRelevant.includes(CHAPTER_NOTES_PATTERN)
  ) {
    return 'read';
  }
  return 'unspecified';
}
