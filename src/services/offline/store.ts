import { createMMKV } from 'react-native-mmkv';
import { API_BASE_URL } from '../config';
import { getUser, isAuthenticated, subscribeAuthSession } from '../storage';
import type {
  BackendPracticeSet,
  BackendQuestion,
  BackendTopicSummary,
} from '../education/types';
import type { BackendExam } from '../exams/types';
import type { Vocabulary } from '../vocabulary/types';

const disk = createMMKV({ id: 'offline-learning-v1' });
export interface OfflinePack {
  version: 1;
  level: number;
  directory: string;
  downloadedAt: string;
  bytes: number;
  topics: BackendTopicSummary[];
  sets: BackendPracticeSet[];
  words: Vocabulary[];
  exams: BackendExam[];
  questions: BackendQuestion[];
  media: Record<string, string>;
}
export type PendingEvent = {
  id: string;
  route: 'analytics/vocabulary-progress' | 'learning-scores/submit';
  body: Record<string, unknown>;
  error?: string;
  blocked?: boolean;
};
export type LocalResult = {
  id: string;
  title: string;
  createdAt: string;
  result: Record<string, unknown>;
  sync: 'local' | 'pending' | 'saved' | 'error';
};
export const accountScope = (): string | null => {
  const id = getUser<{ id: number }>()?.id;
  return isAuthenticated() && id ? `${API_BASE_URL}|${id}` : null;
};
let revision = 0;
let connected = true;
let backendReachable = true;
let cachedScope: string | null = null;
let cachedPacks: OfflinePack[] | undefined;
const listeners = new Set<() => void>();
export const notifyOffline = () => {
  revision += 1;
  listeners.forEach((listener) => listener());
};
export const subscribeOffline = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const offlineRevision = () => revision;
subscribeAuthSession(() => {
  cachedPacks = undefined;
  cachedScope = null;
  notifyOffline();
});
export const readOffline = <T>(
  key: string,
  fallback: T,
  scope = accountScope(),
): T => {
  if (!scope) return fallback;
  try {
    const raw = disk.getString(`${scope}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const writeOffline = (
  key: string,
  value: unknown,
  scope = accountScope(),
) => {
  if (!scope)
    throw new Error('Hãy đăng nhập trước khi lưu dữ liệu ngoại tuyến.');
  disk.set(`${scope}:${key}`, JSON.stringify(value));
  if (key.startsWith('pack:') || key === 'levels') cachedPacks = undefined;
  notifyOffline();
};
export const removeOffline = (key: string, scope = accountScope()) => {
  if (scope) disk.remove(`${scope}:${key}`);
  cachedPacks = undefined;
  notifyOffline();
};
export const getPacks = (): OfflinePack[] => {
  const scope = accountScope();
  if (cachedScope === scope && cachedPacks) return cachedPacks;
  cachedScope = scope;
  cachedPacks = readOffline<number[]>('levels', []).flatMap((level) => {
    const pack = readOffline<OfflinePack | null>(`pack:${level}`, null);
    return pack?.version === 1 &&
      Array.isArray(pack.sets) &&
      Array.isArray(pack.words)
      ? [pack]
      : [];
  });
  return cachedPacks;
};
export const commitPack = (pack: OfflinePack, scope: string) => {
  // Publish a complete manifest only after every file has been written successfully.
  writeOffline(`pack:${pack.level}`, pack, scope);
  writeOffline(
    'levels',
    [
      ...new Set([...readOffline<number[]>('levels', [], scope), pack.level]),
    ].sort(),
    scope,
  );
};
// Old persisted manual switches are intentionally ignored: connectivity alone controls offline.
export const isOffline = () => !connected || !backendReachable;
export const setBackendReachable = (value: boolean) => {
  if (backendReachable !== value) {
    backendReachable = value;
    notifyOffline();
  }
};
export const setConnected = (value: boolean) => {
  if (value !== connected) {
    connected = value;
    notifyOffline();
  }
};
export const getConnected = () => connected;
export const localMedia = (url: string): string | undefined => {
  for (const pack of getPacks()) if (pack.media[url]) return pack.media[url];
  return readOffline<Array<{ url: string; uri: string }>>('media-v2', []).find(
    (item) => item.url === url,
  )?.uri;
};
export const getPendingEvents = () => readOffline<PendingEvent[]>('outbox', []);
export const newEventId = () =>
  `app_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
export const enqueueEvent = (event: PendingEvent) => {
  let events = getPendingEvents();
  if (event.route === 'analytics/vocabulary-progress') {
    const older = events.find(
      (item) =>
        item.route === event.route &&
        item.body.vocabularyId === event.body.vocabularyId,
    );
    if (
      event.body.action === 'studied' &&
      older &&
      older.body.action !== 'studied'
    )
      return;
    events = events.filter(
      (item) =>
        item.route !== event.route ||
        item.body.vocabularyId !== event.body.vocabularyId,
    );
  }
  if (events.length >= 2000)
    throw new Error('Bộ nhớ đồng bộ đã đầy. Hãy kết nối mạng để lưu tiến độ.');
  writeOffline('outbox', [...events, event]);
};
export const getLocalResults = () => readOffline<LocalResult[]>('results', []);
export const updateLocalResult = (
  id: string,
  patch: Partial<LocalResult>,
  scope: string,
) => {
  writeOffline(
    'results',
    readOffline<LocalResult[]>('results', [], scope).map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    ),
    scope,
  );
};
