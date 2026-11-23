import { useEffect, useRef } from 'react';
import {
  accountScope,
  readOffline,
  removeOffline,
  writeOffline,
} from './store';
import { AppAlert } from '../feedback/appAlert';

export type LearningDraft = {
  answers?: Record<string, string>;
  bookmarks?: Record<string, boolean>;
  statuses?: Record<string, 'done' | 'skipped'>;
  currentIndex?: number;
  deadline?: number;
  sourceVersion?: string;
};
export const readLearningDraft = (
  key: string,
  sourceVersion?: string,
): LearningDraft => {
  const draft = readOffline<LearningDraft>(`draft:${key}`, {});
  return sourceVersion && draft.sourceVersion !== sourceVersion ? {} : draft;
};
export const clearLearningDraft = (key: string) =>
  removeOffline(`draft:${key}`);
export const remainingExamSeconds = (deadline: number, now = Date.now()) =>
  Math.max(0, Math.ceil((deadline - now) / 1000));
export function useLearningDraft(
  key: string,
  enabled: boolean,
  draft: LearningDraft,
) {
  const scope = useRef(accountScope()).current;
  const serialized = JSON.stringify(draft);
  const notified = useRef(false);
  useEffect(() => {
    if (!enabled || !scope || scope !== accountScope()) return;
    try {
      writeOffline(`draft:${key}`, JSON.parse(serialized), scope);
    } catch {
      if (!notified.current) {
        notified.current = true;
        AppAlert.error(
          'Chưa lưu được bài đang làm',
          'Bộ nhớ thiết bị không đủ. Hãy giải phóng bộ nhớ trước khi thoát app.',
        );
      }
    }
  }, [key, enabled, serialized, scope]);
}
