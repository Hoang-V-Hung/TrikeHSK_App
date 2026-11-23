import { NativeModules } from 'react-native';
import { API_ORIGIN } from '../config';
import { remoteMediaUrl } from '../media';
import { getAuthSessionVersion, getToken } from '../storage';
import {
  accountScope,
  isOffline,
  notifyOffline,
  readOffline,
  removeOffline,
  writeOffline,
} from './store';

export interface OfflineFiles {
  download(
    scope: string,
    url: string,
    token: string,
  ): Promise<{ uri: string; bytes: number }>;
  removePack(scope: string): Promise<void>;
  validateFiles(uris: string[]): Promise<boolean>;
  isConnected(): Promise<boolean>;
  isUnmetered?(): Promise<boolean>;
}
export const offlineFiles = NativeModules.OfflineContent as
  OfflineFiles | undefined;
type CachedResponse = { key: string; body: unknown; at: number; size: number };
export type CachedMedia = {
  url: string;
  uri: string;
  bytes: number;
  directory: string;
};
const MAX_RESPONSES = 80;
const MAX_TEXT = 16 * 1024 * 1024;
const MAX_MEDIA = 128 * 1024 * 1024;
export const cachedResponses = () =>
  readOffline<CachedResponse[]>('responses-v2', []);
export const cachedMedia = () => readOffline<CachedMedia[]>('media-v2', []);
export const readCachedResponse = (key: string) =>
  cachedResponses().find((item) => item.key === key) ??
  readOffline<CachedResponse | null>(key, null);
export function cacheResponse(key: string, body: unknown, scope: string) {
  if (scope !== accountScope()) return;
  const size = JSON.stringify(body).length * 2;
  if (size > 2_000_000) return;
  let entries = [
    ...cachedResponses().filter((item) => item.key !== key),
    { key, body, at: Date.now(), size },
  ];
  let total = entries.reduce((sum, item) => sum + item.size, 0);
  while (entries.length > MAX_RESPONSES || total > MAX_TEXT)
    total -= entries.shift()!.size;
  writeOffline('responses-v2', entries, scope);
  // Migrate the previous per-URL cache without retaining duplicate response bodies.
  removeOffline(key, scope);
}
export function collectMedia(data: unknown): string[] {
  const urls = new Set<string>();
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (
        (/audio|image|scanUrl/i.test(key) ||
          /\.(mp3|wav|m4a|png|jpe?g|webp)(?:[?#]|$)/i.test(value)) &&
        !/^(data:|file:|content:)/i.test(value)
      ) {
        const url = remoteMediaUrl(value);
        if (url && /^https?:/i.test(url) && !/\.pdf(?:[?#]|$)/i.test(url))
          urls.add(url);
      }
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === 'object')
      Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  visit(data);
  return [...urls];
}
const waiting = new Map<string, string>();
let running = false;
let savingScope: string | null = null;
export const isSavingMedia = () => running && savingScope === accountScope();
export async function warmLessonMedia(data: unknown): Promise<void> {
  const scope = accountScope();
  if (!scope || !offlineFiles) return;
  const existing = new Set(cachedMedia().map((item) => item.url));
  // Only a screen's current lesson calls this: listing thousands of lessons never downloads them all.
  for (const url of collectMedia(data).slice(0, 100)) {
    if (!existing.has(url) && waiting.size < 150) waiting.set(url, scope);
  }
  if (
    running ||
    isOffline() ||
    !(await offlineFiles.isUnmetered?.().catch(() => false))
  )
    return;
  if (scope !== accountScope() || running) return;
  running = true;
  savingScope = scope;
  const version = getAuthSessionVersion();
  notifyOffline();
  try {
    for (const [url, owner] of waiting) {
      if (
        !(await offlineFiles.isUnmetered?.().catch(() => false)) ||
        isOffline() ||
        scope !== accountScope() ||
        version !== getAuthSessionVersion()
      )
        break;
      waiting.delete(url);
      if (owner !== scope || cachedMedia().some((item) => item.url === url))
        continue;
      const directory = `${scope}|recent|${Date.now()}|${Math.random().toString(36).slice(2)}`;
      try {
        const file = await offlineFiles.download(
          directory,
          url,
          new URL(url).origin === API_ORIGIN ? getToken() || '' : '',
        );
        if (scope !== accountScope() || version !== getAuthSessionVersion()) {
          await offlineFiles.removePack(directory);
          break;
        }
        const media = [...cachedMedia(), { url, ...file, directory }];
        let bytes = media.reduce((sum, item) => sum + item.bytes, 0);
        const expired: CachedMedia[] = [];
        while (media.length > 150 || bytes > MAX_MEDIA) {
          const item = media.shift()!;
          bytes -= item.bytes;
          expired.push(item);
        }
        writeOffline('media-v2', media, scope);
        await Promise.all(
          expired.map((item) =>
            offlineFiles.removePack(item.directory).catch(() => undefined),
          ),
        );
      } catch {
        await offlineFiles.removePack(directory).catch(() => undefined);
        // A failed prefetch must never interrupt the lesson or claim the asset is available.
      }
    }
  } finally {
    running = false;
    savingScope = null;
    notifyOffline();
    // An account switch may have queued its own lesson while the previous job was stopping.
    if (waiting.size && scope !== accountScope()) void warmLessonMedia(null);
  }
}
