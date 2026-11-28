import { instance } from '../instance';
import { cachedLessons, cachedMedia } from './cache';
import type { BackendPracticeSet } from '../education/types';
import { getAuthSessionVersion } from '../storage';
import {
  accountScope,
  enqueueEvent,
  getLocalResults,
  getPacks,
  getPendingEvents,
  isOffline,
  newEventId,
  notifyOffline,
  readOffline,
  updateLocalResult,
  writeOffline,
} from './store';
import type { LocalResult } from './store';
import type { VocabularyProgressDto } from '../analytics/types';

const syncing = new Set<string>();
export const isSyncing = () => {
  const scope = accountScope();
  return !!scope && syncing.has(scope);
};
export function queueVocabulary(dto: VocabularyProgressDto) {
  enqueueEvent({
    id: newEventId(),
    route: 'analytics/vocabulary-progress',
    body: { ...dto },
  });
  // Retain the latest local rating through a process restart, independent of the outbox.
  const ratings = readOffline<Record<string, string>>('ratings', {});
  if (dto.action !== 'studied' || !ratings[dto.vocabularyId])
    ratings[dto.vocabularyId] = dto.action;
  writeOffline('ratings', ratings);
  void syncOfflineEvents();
}
export function recordLearningResult(
  key: string,
  result: Record<string, unknown>,
  context: { kind?: 'exam' | 'set'; sourceId?: number; title: string },
) {
  const scope = accountScope();
  if (!scope) return;
  const id = newEventId();
  const canSync =
    !!context.kind &&
    Number.isSafeInteger(context.sourceId) &&
    context.sourceId! > 0;
  const item: LocalResult = {
    id,
    title: context.title,
    createdAt: new Date().toISOString(),
    result: { ...portableResult(result), localKey: key, localAttemptId: id },
    sync: canSync ? 'pending' : 'local',
  };
  // Write the durable receipt before showing a completed result to the learner.
  writeOffline('results', [item, ...getLocalResults()].slice(0, 30), scope);
  if (canSync)
    enqueueEvent({
      id,
      route: 'learning-scores/submit',
      body: {
        attemptId: id,
        kind: context.kind,
        sourceId: context.sourceId,
        answers: result.answers || {},
        durationSeconds: Math.max(
          0,
          Math.floor(Number(result.durationInSeconds) || 0),
        ),
      },
    });
  void syncOfflineEvents();
  return id;
}
export const savedResults = (): Record<string, unknown> =>
  Object.fromEntries(
    [...getLocalResults()]
      .reverse()
      .map((item) => [
        String(item.result.localKey),
        confirmedLearningResult(item.result),
      ]),
  );

export async function syncOfflineEvents(): Promise<void> {
  const scope = accountScope();
  if (!scope || syncing.has(scope) || isOffline()) return;
  const version = getAuthSessionVersion();
  syncing.add(scope);
  notifyOffline();
  try {
    // Only these two existing APIs are replayed: vocabulary upsert and idempotent attempt IDs.
    // Attendance, purchases, PK and non-idempotent time pings never enter this queue.
    while (
      !isOffline() &&
      accountScope() === scope &&
      version === getAuthSessionVersion()
    ) {
      const event = getPendingEvents().find((item) => !item.blocked);
      if (!event) break;
      try {
        const confirmed = await instance
          .post(event.route, { json: event.body, retry: 0 })
          .json<Record<string, unknown>>();
        if (scope !== accountScope() || version !== getAuthSessionVersion())
          break;
        if (event.route === 'learning-scores/submit') {
          updateLocalResult(
            event.id,
            {
              sync: 'saved',
              result: {
                ...getLocalResults().find((item) => item.id === event.id)
                  ?.result,
                serverResult: confirmed,
              },
            },
            scope,
          );
        }
        writeOffline(
          'outbox',
          getPendingEvents().filter((item) => item.id !== event.id),
          scope,
        );
      } catch (error) {
        if (scope !== accountScope() || version !== getAuthSessionVersion())
          break;
        const status = (error as { response?: { status?: number } }).response
          ?.status;
        // Keep refused/stale attempts for review; never repeatedly hammer a 4xx every heartbeat.
        const message =
          status && status >= 400 && status < 500
            ? 'Máy chủ chưa nhận bài này. Hãy kiểm tra phiên đăng nhập hoặc nội dung bài rồi thử đồng bộ lại.'
            : 'Chưa kết nối được máy chủ. Tiến độ vẫn được giữ trên máy.';
        const events = getPendingEvents();
        writeOffline(
          'outbox',
          events.map((item) =>
            item.id === event.id
              ? {
                  ...item,
                  error: message,
                  blocked: !!status && status >= 400 && status < 500,
                }
              : item,
          ),
          scope,
        );
        if (event.route === 'learning-scores/submit')
          updateLocalResult(event.id, { sync: 'error' }, scope);
        break;
      }
    }
  } finally {
    syncing.delete(scope);
    notifyOffline();
  }
}
export const practiceContext = (sourceId: number) => {
  const set = (cachedLessons().find((entry) => entry.key === `set:${sourceId}`)?.body as BackendPracticeSet | undefined)
    ?? getPacks().flatMap((pack) => pack.sets).find((item) => item.id === sourceId);
  return {
    kind: 'set' as const,
    sourceId,
    title: set?.title || `Bài luyện #${sourceId}`,
  };
};
export function saveOfflineStudyTime(
  durationInSeconds: number,
  module: string,
) {
  const key = 'local-study-time';
  const records = readOffline<
    Array<{ date: string; seconds: number; module: string }>
  >(key, []);
  const date = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const prior = records.find(
    (item) => item.date === date && item.module === module,
  );
  if (prior) prior.seconds += durationInSeconds;
  else records.push({ date, seconds: durationInSeconds, module });
  writeOffline(key, records.slice(-365));
}
export const getOfflineStudySeconds = () =>
  readOffline<Array<{ seconds: number }>>('local-study-time', []).reduce(
    (sum, item) => sum + item.seconds,
    0,
  );
const resultObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function confirmedLearningResult(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const local = getLocalResults().find(
    (item) => item.id === raw.localAttemptId,
  );
  if (!local || local.sync !== 'saved') return raw;
  const server = resultObject(local.result.serverResult);
  if (typeof server.correctCount !== 'number') return raw;
  const grades = new Map(
    (Array.isArray(server.questions) ? server.questions : []).map((value) => {
      const grade = resultObject(value);
      return [String(grade.questionId), grade] as const;
    }),
  );
  const sections = (Array.isArray(server.sections) ? server.sections : []).map(
    resultObject,
  );
  const correct = (skill: string) =>
    sections.find((section) => section.skill === skill)?.correctCount || 0;
  return {
    ...raw,
    score: server.score,
    correctCount: server.correctCount,
    gradedCount: server.gradedCount,
    manualCount: server.ungradedCount,
    listeningCorrect: correct('Listening'),
    readingCorrect: correct('Reading'),
    writingCorrect: correct('Writing'),
    pendingSync: false,
    questions: Array.isArray(raw.questions)
      ? raw.questions.map((value) => {
          const question = resultObject(value);
          const grade = grades.get(String(question.id));
          const answers = (
            Array.isArray(grade?.correctAnswers) ? grade.correctAnswers : []
          ).filter((answer): answer is string => typeof answer === 'string');
          if (!answers.length) return question;
          const options = (
            Array.isArray(question.options) ? question.options : []
          ).map(resultObject);
          const option = options.find((item) =>
            answers.some((answer) =>
              [item.id, item.label, item.text].some(
                (candidate) =>
                  String(candidate).trim().toLowerCase() ===
                  answer.trim().toLowerCase(),
              ),
            ),
          );
          return {
            ...question,
            requiresManualReview: false,
            correctOptionId: option?.id || answers[0],
            ...(question.writing
              ? {
                  writing: {
                    ...resultObject(question.writing),
                    correctAnswers: answers,
                  },
                }
              : {}),
          };
        })
      : raw.questions,
  };
}

function portableResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const originals = new Map(
    [
      ...getPacks().flatMap((pack) =>
        Object.entries(pack.media).map(([url, file]) => [file, url] as const),
      ),
      ...cachedMedia().map(({ uri, url }) => [uri, url] as const),
    ],
  );
  const portable = (value: unknown): unknown => {
    if (typeof value === 'string') return originals.get(value) || value;
    if (Array.isArray(value)) return value.map(portable);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, portable(item)]),
      );
    return value;
  };
  return portable(result) as Record<string, unknown>;
}
