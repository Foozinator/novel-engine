import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Lock file: an exclusive SQLite transaction is held on it for the process lifetime. */
export const LOCK_FILENAME = 'instance.lock';
/** Advisory details about the holder. Read only to build the "folder in use" message. */
export const LOCK_INFO_FILENAME = 'instance.lock.json';

export type LockHolderInfo = {
  app: string;
  host: string;
  pid: number;
  startedAt: string;
};

export type AcquireResult =
  | { acquired: true; release: () => void }
  | { acquired: false; holder: LockHolderInfo | null };

/**
 * Take an exclusive lock on a data folder (#75).
 *
 * The lock is an open exclusive transaction on a small SQLite file. The OS
 * drops it when the process dies, so a crash or a force-removed container never
 * leaves a stale lock. The info file beside it is for messages only and is never
 * used to decide whether the folder is free (PID and hostname checks fail when a
 * container is recreated).
 *
 * Limits: processes that don't take this lock (upstream builds) are not
 * stopped, and file locks may not work across VM or network file shares.
 */
export function acquireDataFolderLock(dir: string, appName: string): AcquireResult {
  const db = new Database(path.join(dir, LOCK_FILENAME), { timeout: 0 });
  try {
    db.pragma('journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    const code = (err as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return { acquired: false, holder: readHolderInfo(dir) };
    }
    throw err;
  }

  const info: LockHolderInfo = { app: appName, host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(dir, LOCK_INFO_FILENAME), JSON.stringify(info));
  } catch {
    // Advisory only; the lock itself is what counts.
  }

  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

export function readHolderInfo(dir: string): LockHolderInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LOCK_INFO_FILENAME), 'utf8'));
    if (raw && typeof raw.app === 'string' && typeof raw.host === 'string') return raw as LockHolderInfo;
  } catch {
    // missing or unreadable
  }
  return null;
}

/** One-line description of the holder for messages. */
export function describeHolder(holder: LockHolderInfo | null): string {
  if (!holder) return 'another Novel Engine process';
  return `${holder.app} on ${holder.host} (started ${holder.startedAt})`;
}
