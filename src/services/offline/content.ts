import { instance } from '../instance';
import { educationApi } from '../education/api';
import { vocabularyApi } from '../vocabulary/api';
import { examsApi } from '../exams/api';
import { offlineFiles, collectMedia } from './cache';
export { offlineFiles, collectMedia } from './cache';
import { API_ORIGIN } from '../config';
import { getAuthSessionVersion, getToken } from '../storage';
import {
  accountScope,
  commitPack,
  getPacks,
  isOffline,
  notifyOffline,
  readOffline,
  removeOffline,
  writeOffline,
} from './store';
import type { OfflinePack } from './store';
import type { BackendQuestion } from '../education/types';

export type DownloadProgress = {
  scope: string;
  level: number;
  done: number;
  total: number;
  phase: string;
};
let progress: DownloadProgress | null = null;
let cancelled = false;
export const getDownloadProgress = () =>
  progress?.scope === accountScope() ? progress : null;
export const cancelDownload = () => {
  cancelled = true;
  if (progress) progress = { ...progress, phase: 'Đang hủy tải…' };
  notifyOffline();
};
const publish = (patch: Partial<DownloadProgress>) => {
  if (progress) progress = { ...progress, ...patch };
  notifyOffline();
};
export async function downloadLevel(level: number): Promise<void> {
  if (progress)
    throw new Error('Đang tải một gói khác. Vui lòng chờ hoàn tất.');
  if (!offlineFiles)
    throw new Error(
      'Bản cài này chưa có bộ tải ngoại tuyến. Hãy cài lại bản Android mới.',
    );
  const files = offlineFiles;
  const scope = accountScope();
  if (!scope || !Number.isInteger(level) || level < 1 || level > 9)
    throw new Error('Cấp HSK hoặc phiên đăng nhập không hợp lệ.');
  if (isOffline())
    throw new Error(
      'Chưa kết nối được máy chủ. Hãy kiểm tra mạng rồi tải lại.',
    );
  const version = getAuthSessionVersion();
  const directory = `${scope}|${level}|${Date.now()}`;
  const previous = getPacks().find((pack) => pack.level === level);
  cancelled = false;
  progress = {
    scope,
    level,
    done: 0,
    total: 0,
    phase: 'Đang lấy nội dung bài học…',
  };
  notifyOffline();
  const check = () => {
    if (
      cancelled ||
      scope !== accountScope() ||
      version !== getAuthSessionVersion()
    )
      throw new Error('Đã hủy tải. Gói đã tải trước đó vẫn được giữ.');
  };
  try {
    const [topics, words] = await Promise.all([
      educationApi.getTopics(level),
      vocabularyApi.getAllForPractice({ hskLevel: level }),
    ]);
    check();
    const sets = await instance
      .get('practice-sets', {
        searchParams: { hskLevel: level, page: 1, limit: 100 },
      })
      .json<{ data: OfflinePack['sets']; totalPages: number }>();
    const allSets = [...sets.data];
    for (let page = 2; page <= sets.totalPages; page += 1) {
      check();
      allSets.push(
        ...(
          await educationApi.getPracticeSets({
            hskLevel: level,
            page,
            limit: 100,
          })
        ).data,
      );
    }
    for (let index = 0; index < allSets.length; index += 1) {
      const set = allSets[index]!;
      if (
        !set.practiceSetQuestions?.length ||
        set.practiceSetQuestions.some((link) => !link.question)
      )
        allSets[index] = await educationApi.getPracticeSetById(set.id);
      check();
    }
    const allExams: OfflinePack['exams'] = [];
    let page = 1;
    let pages = 1;
    do {
      check();
      const result = await examsApi.getExams({
        hskLevel: level,
        page,
        limit: 100,
      });
      for (const exam of result.data) {
        const access = exam as typeof exam & {
          access?: { canAttempt?: boolean };
          canAccess?: boolean;
          isLocked?: boolean;
        };
        if (
          access.access?.canAttempt === false ||
          access.canAccess === false ||
          access.isLocked === true
        )
          continue;
        try {
          allExams.push(await examsApi.getExamById(exam.id, exam));
        } catch (error) {
          // Paid or revoked content is excluded; other errors make the package incomplete.
          const status = (error as { response?: { status?: number } }).response
            ?.status;
          if (status !== 403 && status !== 402) throw error;
        }
      }
      pages = result.totalPages;
      page += 1;
    } while (page <= pages);
    check();
    const invalidSet = allSets.some(
      (set) =>
        set.hskLevel !== level ||
        !set.practiceSetQuestions?.length ||
        set.practiceSetQuestions.some(
          (link) =>
            !link.question ||
            link.question.id !== link.questionId ||
            link.question.hskLevel !== level ||
            link.question.skill !== set.skill,
        ) ||
        (typeof set.totalQuestions === 'number' &&
          set.totalQuestions !== set.practiceSetQuestions.length),
    );
    const invalidExam = allExams.some((exam) => {
      const links = (exam.sections || []).flatMap(
        (section) => section.sectionQuestions || [],
      );
      return (
        exam.hskLevel !== level ||
        !links.length ||
        links.some(
          (link) =>
            !link.question ||
            link.question.id !== link.questionId ||
            link.question.hskLevel !== level,
        ) ||
        (typeof exam.totalQuestions === 'number' &&
          exam.totalQuestions !== links.length)
      );
    });
    if (
      invalidSet ||
      invalidExam ||
      words.some((word) => word.hskLevel !== level)
    )
      throw new Error(
        'Máy chủ trả về nội dung thiếu hoặc khác cấp HSK. Chưa thay gói đã tải; hãy kiểm tra dữ liệu rồi thử lại.',
      );
    const questions = [
      ...new Map<number, BackendQuestion>(
        [
          ...allSets.flatMap((set) =>
            (set.practiceSetQuestions || []).map((link) => link.question),
          ),
          ...allExams.flatMap((exam) =>
            (exam.sections || []).flatMap((section) =>
              (section.sectionQuestions || []).map((link) => link.question),
            ),
          ),
        ]
          .filter((question): question is BackendQuestion => !!question)
          .map((question) => [question.id, question]),
      ).values(),
    ];
    if (!allSets.length && !words.length && !allExams.length)
      throw new Error('HSK này chưa có nội dung để tải.');
    const urls = collectMedia([allSets, allExams, words]);
    const media: Record<string, string> = {};
    let bytes = 0;
    publish({ total: urls.length, phase: 'Đang tải ảnh và audio…' });
    // Settle all in-flight downloads before deleting staging files on cancellation/failure.
    for (let start = 0; start < urls.length; start += 3) {
      check();
      const batch = await Promise.allSettled(
        urls.slice(start, start + 3).map(async (url) => {
          const token =
            new URL(url).origin === API_ORIGIN ? getToken() || '' : '';
          const file = await files.download(directory, url, token);
          media[url] = file.uri;
          bytes += file.bytes;
          publish({ done: Object.keys(media).length });
        }),
      );
      const failed = batch.find((item) => item.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (bytes > 512 * 1024 * 1024)
        throw new Error(
          'Gói vượt quá 512 MB. Hãy chọn cấp HSK khác hoặc giải phóng bộ nhớ.',
        );
    }
    check();
    if (!(await files.validateFiles(Object.values(media))))
      throw new Error('Tệp tải về chưa đầy đủ. Vui lòng tải lại.');
    commitPack(
      {
        version: 1,
        level,
        directory,
        downloadedAt: new Date().toISOString(),
        bytes,
        topics,
        sets: allSets,
        words,
        exams: allExams,
        questions,
        media,
      },
      scope,
    );
    if (previous)
      await files.removePack(previous.directory).catch(() => undefined);
  } catch (error) {
    await files.removePack(directory).catch(() => undefined);
    throw error;
  } finally {
    progress = null;
    notifyOffline();
  }
}
export async function deleteLevel(level: number) {
  if (progress)
    throw new Error('Hãy chờ tải xong hoặc hủy tải trước khi xóa gói.');
  const scope = accountScope();
  const pack = getPacks().find((item) => item.level === level);
  if (!scope || !pack || !offlineFiles) return;
  removeOffline(`pack:${level}`, scope);
  writeOffline(
    'levels',
    readOffline<number[]>('levels', [], scope).filter((item) => item !== level),
    scope,
  );
  await offlineFiles.removePack(pack.directory);
}
