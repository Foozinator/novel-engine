import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ShadowReport } from '@app/ShadowPipelineService';

/** Where shadow mode's reports go, under the data folder. */
export const SHADOW_LOG_PATH = path.join('logs', 'run-log-shadow.jsonl');

/**
 * Report sink for the run log's shadow mode (#87, PR 1). Each report goes
 * to the console and, as one JSON line with a time, to
 * `{dataFolder}/logs/run-log-shadow.jsonl`, so a packaged build keeps a
 * record. Writes are queued in order; a failed write is logged and dropped.
 */
export function makeShadowReporter(
  userDataPath: string,
  clock: () => string = () => new Date().toISOString(),
): { report: (report: ShadowReport) => void; flush: () => Promise<void> } {
  const file = path.join(userDataPath, SHADOW_LOG_PATH);
  let queue: Promise<void> = Promise.resolve();

  const report = (entry: ShadowReport): void => {
    const level = entry.kind === 'migrated' ? console.log : console.warn;
    level(`[run-log] ${entry.kind} ${entry.bookSlug}`, entry);
    const line = `${JSON.stringify({ at: clock(), ...entry })}\n`;
    queue = queue
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, line, 'utf-8');
      })
      .catch((err: unknown) => {
        console.warn('[run-log] could not write the shadow log:', err);
      });
  };

  return { report, flush: () => queue };
}
