import { NativeModules } from 'react-native';
import { API_ORIGIN } from '../config';
import { remoteMediaUrl } from '../media';
import { getAuthSessionVersion, getToken } from '../storage';
import {
  accountScope,
  isOffline,
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
  isConnected(): Promise<boolean>;
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
const MAX_LESSONS = 40;
const MAX_LESSON_TEXT = 24 * 1024 * 1024;
const MAX_MEDIA = 128 * 1024 * 1024;
export const cachedResponses = () =>
  readOffline<CachedResponse[]>('responses-v2', []);
export const cachedLessons = () =>
  readOffline<CachedResponse[]>('lessons-v1', []);
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
export async function loadLesson<T>(
  key: string,
  load: () => Promise<T>,
  isComplete: (data: T) => boolean,
): Promise<T> {
  const scope = accountScope();
  const version = getAuthSessionVersion();
  const saved = cachedLessons().find((item) => item.key === key);
  const sameAccount = () =>
    scope === accountScope() && version === getAuthSessionVersion();
  const reopen = (entry: CachedResponse) => {
    void warmLessonMedia(entry.body);
    return entry.body as T;
  };
  if (isOffline() && saved) return reopen(saved);

  let data: T;
  try {
    data = await load();
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (isOffline() && saved && sameAccount() && !(status && status < 500)) {
      return reopen(saved);
    }
    throw error;
  }
  if (!sameAccount()) throw new Error('Phiên đăng nhập đã thay đổi.');
  if (scope && isComplete(data)) {
    try {
      // Keep lessons actually opened by the learner independent of browsing history.
      const size = JSON.stringify(data).length * 2;
      if (size <= MAX_LESSON_TEXT && (!isOffline() || !saved)) {
        const entries = [
          ...cachedLessons().filter((item) => item.key !== key),
          { key, body: data, at: Date.now(), size },
        ];
        let total = entries.reduce((sum, item) => sum + item.size, 0);
        while (entries.length > MAX_LESSONS || total > MAX_LESSON_TEXT)
          total -= entries.shift()!.size;
        writeOffline('lessons-v1', entries, scope);
      }
    } catch {
      // A failed cache write must not prevent opening the lesson online.
    }
    void warmLessonMedia(data);
  }
  return data;
}

export function collectMedia(data: unknown): string[] {
  const urls = new Set<string>();
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (
        (/^(?:.*(?:audio|image)(?:Url|Path|Urls|Images)|scanUrl|optionImages)$/i.test(key) ||
          /\.(mp3|wav|m4a|png|jpe?g|webp)(?:[?#]|$)/i.test(value)) &&
        !/^(data:|file:|content:)/i.test(value)
      ) {
        try {
          const url = remoteMediaUrl(value);
          if (url && /^https?:/i.test(url) && !/\.pdf(?:[?#]|$)/i.test(url))
            urls.add(url);
        } catch {
          // Ignore invalid media URLs.
        }
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
export async function warmLessonMedia(data: unknown): Promise<void> {
  const scope = accountScope();
  if (!scope || !offlineFiles) return;
  const existing = new Set(cachedMedia().map((item) => item.url));
  for (const [url, owner] of waiting) {
    if (owner !== scope) waiting.delete(url);
  }
  // Queue media only for lessons the learner opens, including over mobile data.
  for (const url of collectMedia(data).slice(0, 150)) {
    if (!existing.has(url) && waiting.size < 150) waiting.set(url, scope);
  }
  if (running || isOffline()) return;
  running = true;
  const version = getAuthSessionVersion();
  try {
    for (const [url, owner] of waiting) {
      if (
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
        if (isOffline() && scope === accountScope() && version === getAuthSessionVersion()) {
          waiting.set(url, scope);
          break;
        }
        // The lesson stays available when an individual media file fails to download.
      }
    }
  } finally {
    running = false;
    // An account switch may have queued its own lesson while the previous job was stopping.
    if (waiting.size && version !== getAuthSessionVersion()) void warmLessonMedia(null);
  }
}
