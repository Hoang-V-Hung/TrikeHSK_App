import { API_BASE_URL } from '../config';
import { cacheResponse, cachedLessons, cachedResponses, readCachedResponse } from './cache';
import type {
  BackendPracticeSet,
  BackendQuestion,
  BackendTopicSummary,
} from '../education/types';
import type { BackendExam } from '../exams/types';
import type { Vocabulary } from '../vocabulary/types';
import { getAuthSessionVersion, getUser } from '../storage';
import {
  accountScope,
  getPacks,
  isOffline,
  setBackendReachable,
  subscribeOffline,
} from './store';

export class OfflineUnavailableError extends Error {
  constructor() {
    super(
      'Dữ liệu này chưa được lưu trên máy. Hãy kết nối mạng để mở.',
    );
    this.name = 'OfflineUnavailableError';
  }
}
const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const unique = <T extends { id: number | string }>(items: T[]) => [
  ...new Map(items.map((item) => [item.id, item])).values(),
];
export const offlineContent = (url: URL): unknown => {
  const route = url.pathname
    .slice(new URL(API_BASE_URL).pathname.length)
    .replace(/^\//, '');
  const params = url.searchParams;
  const level = params.get('hskLevel');
  const packs = getPacks().filter(
    (pack) => !level || pack.level === Number(level),
  );
  const recent = cachedResponses();
  const opened = cachedLessons();
  if (!packs.length && !recent.length && !opened.length) return undefined;
  const entities = <T>(name: string): T[] => {
    const path = new URL(API_BASE_URL).pathname + '/' + name;
    const entries = recent.filter((entry) => {
      const pathname = entry.key.slice('response:'.length).split('?')[0];
      return (
        pathname === path || new RegExp('^' + path + '/\\d+$').test(pathname)
      );
    });
    return entries.flatMap((entry) => {
      const body = entry.body as { data?: T[] };
      return Array.isArray(body)
        ? body
        : Array.isArray(body?.data)
          ? body.data
          : body
            ? [body as T]
            : [];
    });
  };
  const filter = <
    T extends { hskLevel?: number; topic?: string | null; skill?: string },
  >(
    items: T[],
  ) =>
    items.filter(
      (item) =>
        (!level || item.hskLevel === Number(level)) &&
        (!params.get('topic') || item.topic === params.get('topic')) &&
        (!params.get('skill') || item.skill === params.get('skill')) &&
        (!params.get('search') ||
          normalize(JSON.stringify(item)).includes(
            normalize(params.get('search')!),
          )),
    );
  const paginate = (items: unknown[]) => {
    const page = Math.max(1, Number(params.get('page')) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 10));
    return {
      data: items.slice((page - 1) * limit, page * limit),
      page,
      limit,
      total: items.length,
      totalPages: Math.ceil(items.length / limit),
      hasNextPage: page * limit < items.length,
    };
  };
  const sets = unique(
    [
      ...packs.flatMap((pack) => pack.sets),
      ...entities<BackendPracticeSet>('practice-sets'),
      ...opened.flatMap((entry) =>
        entry.key.startsWith('set:') || entry.key.startsWith('practice-topic:')
          ? (entry.body as BackendPracticeSet | BackendPracticeSet[])
          : [],
      ),
    ].sort(
      (a, b) =>
        Number(!!a.practiceSetQuestions?.length) -
        Number(!!b.practiceSetQuestions?.length),
    ),
  );
  const words = unique([
    ...packs.flatMap((pack) => pack.words),
    ...entities<Vocabulary>('vocabulary'),
    ...opened.flatMap((entry) =>
      entry.key.startsWith('vocabulary-topic:') ? (entry.body as Vocabulary[]) : [],
    ),
  ]);
  const exams = unique(
    [
      ...packs.flatMap((pack) => pack.exams),
      ...entities<BackendExam>('exams'),
      ...opened.flatMap((entry) =>
        entry.key.startsWith('exam:') ? [entry.body as BackendExam] : [],
      ),
    ].sort(
      (a, b) => Number(!!a.sections?.length) - Number(!!b.sections?.length),
    ),
  );
  if (route === 'practice-sets/topics')
    return unique([
      ...packs.flatMap((pack) => pack.topics),
      ...entities<BackendTopicSummary>('practice-sets/topics'),
    ]).filter((topic) => !level || topic.hskLevel === Number(level));
  if (route === 'practice-sets/summary') {
    const selected = filter(sets);
    return {
      totalSets: selected.length,
      totalQuestions: selected.reduce(
        (sum, set) => sum + (set.practiceSetQuestions?.length || 0),
        0,
      ),
    };
  }
  if (route === 'practice-sets') return paginate(filter(sets));
  if (/^practice-sets\/\d+$/.test(route))
    return sets.find((set) => set.id === Number(route.split('/')[1]));
  if (route === 'vocabulary') return paginate(filter(words));
  if (route === 'vocabulary/topic-counts')
    return Object.fromEntries(
      [...new Set(words.map((word) => word.topic).filter(Boolean))].map(
        (topic) => [topic, words.filter((word) => word.topic === topic).length],
      ),
    );
  if (/^vocabulary\/\d+$/.test(route))
    return words.find((word) => word.id === Number(route.split('/')[1]));
  if (route === 'exams') return paginate(filter(exams));
  if (/^exams\/\d+$/.test(route))
    return exams.find((exam) => exam.id === Number(route.split('/')[1]));
  if (route === 'questions')
    return paginate(filter(unique([
      ...packs.flatMap((pack) => pack.questions),
      ...entities<BackendQuestion>('questions'),
    ])));
  return undefined;
};
const cacheable = (route: string) =>
  /^(auth\/me|analytics\/dashboard|practice-sets(?:\/.*)?|exams(?:\/\d+)?|vocabulary(?:\/.*)?|questions|leaderboard\/streak|game\/(?:pk\/history|offline\/(?:words|top-scores)))$/.test(
    route,
  );
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-HSK-Offline': '1' },
  });
const cacheKey = (url: URL) => {
  const pairs = [...url.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `response:${url.pathname}?${new URLSearchParams(pairs).toString()}`;
};
export const offlineFetch: typeof fetch = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  const api = new URL(API_BASE_URL);
  const scope = accountScope();
  const version = getAuthSessionVersion();
  const route = url.pathname.slice(api.pathname.length).replace(/^\//, '');
  const allowed =
    request.method === 'GET' &&
    url.origin === api.origin &&
    url.pathname.startsWith(api.pathname + '/') &&
    cacheable(route);
  const cached = () => {
    if (
      !scope ||
      scope !== accountScope() ||
      version !== getAuthSessionVersion()
    )
      return undefined;

    if (route === 'auth/me') {
      const user = getUser();
      if (user) return response(user);
    }
    const stored = readCachedResponse(cacheKey(url));
    if (stored) return response(stored.body);
    const content = offlineContent(url);
    return content === undefined ? undefined : response(content);
  };
  if (isOffline()) {
    if (allowed) {
      const fallback = cached();
      if (fallback) return fallback;
      throw new OfflineUnavailableError();
    }
    throw new Error(
      'Tính năng này cần kết nối mạng. Tiến độ ngoại tuyến vẫn được giữ trên máy.',
    );
  }
  let result: Response;
  try {
    if (!allowed) result = await fetch(input, init);
    else {
      let unsubscribe = () => {};
      try {
        result = await Promise.race([
          fetch(input, init),
          new Promise<Response>((resolve, reject) => {
            unsubscribe = subscribeOffline(() => {
              if (
                scope !== accountScope() ||
                version !== getAuthSessionVersion()
              ) {
                reject(new Error('Phiên đăng nhập đã thay đổi.'));
              } else if (isOffline()) {
                const fallback = cached();
                if (fallback) resolve(fallback);
                else reject(new OfflineUnavailableError());
              }
            });
          }),
        ]);
      } finally {
        unsubscribe();
      }
    }
  } catch (error) {
    if (request.signal?.aborted) {
      const fallback = allowed ? cached() : undefined;
      if (fallback) return fallback;
      throw error;
    }
    if (allowed) {
      setBackendReachable(false);
      const fallback = cached();
      if (fallback) return fallback;
    }
    throw error;
  }
  if (
    scope &&
    (scope !== accountScope() || version !== getAuthSessionVersion())
  )
    throw new Error('Phiên đăng nhập đã thay đổi.');
  if (result.headers.get('X-HSK-Offline') === '1') return result;
  if (result.ok) setBackendReachable(true);
  if (allowed && result.status >= 500) {
    const fallback = cached();
    if (fallback) return fallback;
  }
  // A server refusal must never be replaced with previously authorized content.
  if (
    result.ok &&
    allowed &&
    scope &&
    scope === accountScope() &&
    version === getAuthSessionVersion()
  ) {
    try {
      const text = await result.clone().text();
      if (text.length < 2_000_000)
        cacheResponse(cacheKey(url), JSON.parse(text), scope);
    } catch {
      /* A cache write must not turn a successful HTTP request into a failure. */
    }
  }
  return result;
};
