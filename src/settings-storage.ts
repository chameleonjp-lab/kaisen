/** One bounded pre-save journal makes a failed rollback recoverable without touching legacy v1. */
export const SETTINGS_RECOVERY_KEY = 'kaisen-controls-recovery-v1';
const ALLOWED_KEYS = new Set(['kaisen-controls-v2', 'kaisen-controls-easy-v2', 'kaisen-keyboard-v1']);
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Snapshot = Array<{ key: string; value: string | null; next: string }>;
function readJournal(storage: Pick<Storage, 'getItem'>): Snapshot | null {
  const raw = storage.getItem(SETTINGS_RECOVERY_KEY);
  if (raw === null) return null;
  if (raw.length > 65536) throw new Error('Recovery journal is too large');
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.previous) || data.previous.length > 3 || data.previous.some((entry: any) => !ALLOWED_KEYS.has(entry?.key) || !(entry.value === null || typeof entry.value === 'string') || typeof entry.next !== 'string')) throw new Error('Unknown recovery journal');
  if (new Set(data.previous.map((entry: { key: string }) => entry.key)).size !== data.previous.length) throw new Error('Duplicate recovery keys');
  return data.previous;
}
/** Read-only: a partial failed save must not become the next page's active settings. */
export function readSettingsValue(key: string, storage: Pick<Storage, 'getItem'>): string | null {
  const previous = readJournal(storage)?.find(entry => entry.key === key);
  return previous ? previous.value : storage.getItem(key);
}
/** Presence only; opening settings never repairs or deletes storage. */
export function hasSettingsRecovery(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(SETTINGS_RECOVERY_KEY) !== null; } catch { return false; }
}
function restore(previous: Snapshot, storage: StorageAccess): boolean {
  if (previous.some(({ key, value, next }) => {
    const current = storage.getItem(key);
    if (current !== value && current !== next) return true;
    try { const data = current && JSON.parse(current); if (typeof data?.version === 'number' && data.version > (key === 'kaisen-keyboard-v1' ? 1 : 2)) return true; } catch { /* Restore malformed raw only if it exactly matches this batch. */ }
    return false;
  })) return false;
  let success = true;
  for (const { key, value } of previous) {
    try {
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      if (storage.getItem(key) !== value) success = false;
    } catch { success = false; }
  }
  return success;
}
export function persistSettingsBatch(entries: Array<{ key: string; value: string; maxVersion?: number; legacyKey?: string }>, storage: StorageAccess): boolean {
  try {
    const pending = readJournal(storage);
    if (pending) {
      if (!restore(pending, storage)) return false;
      storage.removeItem(SETTINGS_RECOVERY_KEY);
      if (storage.getItem(SETTINGS_RECOVERY_KEY) !== null) return false;
    }
    if (new Set(entries.map(entry => entry.key)).size !== entries.length || entries.length > ALLOWED_KEYS.size) return false;
    const previous: Snapshot = [];
    for (const { key, value, maxVersion = 1, legacyKey } of entries) {
      if (!ALLOWED_KEYS.has(key)) return false;
      const raw = storage.getItem(key);
      previous.push({ key, value: raw, next: value });
      for (const [value, maximum] of [[raw, maxVersion], ...(raw === null && legacyKey ? [[storage.getItem(legacyKey), 1]] : [])] as Array<[string | null, number]>) {
        if (!value) continue;
        try { const parsed = JSON.parse(value); if (typeof parsed?.version === 'number' && parsed.version > maximum) return false; } catch { /* Explicit Save may replace malformed current data. */ }
      }
    }
    if (!entries.length) return true;
    const journal = JSON.stringify({ version: 1, previous });
    if (journal.length > 65536) return false;
    storage.setItem(SETTINGS_RECOVERY_KEY, journal);
    if (storage.getItem(SETTINGS_RECOVERY_KEY) !== journal) return false;
    try {
      for (const { key, value, next } of previous) {
        if (storage.getItem(key) !== value) throw new Error('Settings changed during Save');
        storage.setItem(key, next);
        if (storage.getItem(key) !== next) throw new Error('Settings write did not persist');
      }
      if (previous.some(({ key, next }) => storage.getItem(key) !== next)) throw new Error('Settings changed during Save');
      storage.removeItem(SETTINGS_RECOVERY_KEY);
      if (storage.getItem(SETTINGS_RECOVERY_KEY) !== null) throw new Error('Recovery cleanup did not persist');
      return true;
    } catch {
      if (restore(previous, storage)) {
        try { storage.removeItem(SETTINGS_RECOVERY_KEY); } catch { /* Retain readable backup. */ }
      }
      return false;
    }
  } catch { return false; }
}
