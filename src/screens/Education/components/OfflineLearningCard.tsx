import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/atoms';
import { ms, useTheme } from '@/theme';
import { HskLevelSelector } from '../Skills/components/HskLevelSelector';
import { AppAlert } from '@/services/feedback/appAlert';
import { useOffline } from '@/services/offline/useOffline';
import {
  accountScope,
  getPacks,
  getPendingEvents,
  isOffline,
} from '@/services/offline/store';
import { cachedResponses, cachedMedia } from '@/services/offline/cache';
import {
  cancelDownload,
  deleteLevel,
  downloadLevel,
  getDownloadProgress,
  offlineFiles,
} from '@/services/offline/content';
import {
  clearSyncErrors,
  isSyncing,
  syncOfflineEvents,
} from '@/services/offline/sync';

export function OfflineLearningCard() {
  useOffline();
  const { colors } = useTheme();
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [level, setLevel] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const scope = accountScope();
  const pack = getPacks().find((item) => item.level === level);
  const download = getDownloadProgress();
  const pending = getPendingEvents();
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      if (scope === accountScope()) await client.invalidateQueries();
    } catch (failure) {
      if (scope === accountScope())
        setError(
          failure instanceof Error
            ? failure.message
            : 'Chưa thực hiện được. Vui lòng thử lại.',
        );
    } finally {
      lock.current = false;
      if (scope === accountScope()) setBusy(false);
    }
  };
  return (
    <View
      style={{
        marginHorizontal: ms(16),
        marginTop: ms(16),
        padding: ms(16),
        borderRadius: ms(16),
        borderWidth: 1,
        borderColor: colors.dialogBorder,
        backgroundColor: colors.surface,
        gap: ms(12),
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: colors.gray800, fontSize: ms(16), fontWeight: '700' }}
      >
        Tiếp tục học khi mất mạng
      </Text>
      <Text
        style={{ color: colors.gray400, fontSize: ms(13), lineHeight: ms(20) }}
      >
        Bài đã mở được tự lưu trên máy. Ảnh và audio được lưu thêm khi dùng
        Wi-Fi. App tự chuyển sang dữ liệu đã lưu khi mất mạng và tự đồng bộ tiến
        độ khi kết nối lại.
      </Text>
      <Button
        title={
          expanded ? 'Thu gọn nội dung đã tải' : 'Tải bài để học khi mất mạng'
        }
        variant="outline"
        onPress={() => setExpanded((value) => !value)}
      />
      {expanded ? (
        <>
          <Text
            style={{
              color: colors.gray400,
              fontSize: ms(12),
              lineHeight: ms(18),
            }}
          >
            Đã lưu {cachedResponses().length} nội dung gần đây ·{' '}
            {(
              cachedMedia().reduce((sum, item) => sum + item.bytes, 0) /
              1024 /
              1024
            ).toFixed(1)}{' '}
            MB ảnh/audio. Bản lưu gần đây có thể được dọn khi đầy; tải trọn cấp
            HSK để giữ bài chủ động.
          </Text>
          <HskLevelSelector
            selectedHsk={level}
            onSelectHsk={setLevel}
            title="Tải trọn cấp HSK"
          />
          {pack ? (
            <Text style={{ color: colors.success, fontSize: ms(13) }}>
              HSK {level} đã tải · {(pack.bytes / 1024 / 1024).toFixed(1)} MB ·{' '}
              {new Date(pack.downloadedAt).toLocaleDateString('vi-VN')}
            </Text>
          ) : null}
          {download ? (
            <View accessibilityLiveRegion="polite" style={{ gap: ms(8) }}>
              <Text style={{ color: colors.gray800, fontSize: ms(13) }}>
                HSK {download.level} · {download.phase}{' '}
                {download.total ? `${download.done}/${download.total} tệp` : ''}
              </Text>
              <Button
                title="Hủy tải"
                variant="outline"
                onPress={cancelDownload}
              />
            </View>
          ) : (
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: ms(10) }}
            >
              <Button
                title={pack ? 'Cập nhật bài đã tải' : `Tải HSK ${level}`}
                loading={busy}
                disabled={busy || isOffline() || !offlineFiles}
                onPress={() => {
                  void run(() => downloadLevel(level));
                }}
              />
              {pack ? (
                <Button
                  title="Xóa bản tải"
                  variant="outline"
                  disabled={busy}
                  onPress={() =>
                    AppAlert.confirm(
                      'Xóa bản tải trên máy?',
                      `Các bài HSK ${level} sẽ cần mạng để mở lại. Tiến độ và bài làm vẫn được giữ.`,
                      [
                        { text: 'Giữ lại', style: 'cancel' },
                        {
                          text: 'Xóa bản tải',
                          onPress: () => {
                            void run(() => deleteLevel(level));
                          },
                        },
                      ],
                    )
                  }
                />
              ) : null}
            </View>
          )}
          <Text
            style={{
              color: colors.gray400,
              fontSize: ms(12),
              lineHeight: ms(18),
            }}
          >
            Gói gồm từ vựng, bài luyện và đề bạn được phép truy cập. PK, điểm
            danh, mua đề và chấm phát âm cần mạng.
          </Text>
          {pending.length ? (
            <Button
              title={
                isSyncing()
                  ? 'Đang đồng bộ…'
                  : `Thử đồng bộ ${pending.length} mục`
              }
              variant="outline"
              disabled={busy || isOffline() || isSyncing()}
              onPress={() => {
                clearSyncErrors();
                void run(syncOfflineEvents);
              }}
            />
          ) : null}
          {pending.find((item) => item.error)?.error ? (
            <Text style={{ color: colors.warningText, fontSize: ms(13) }}>
              {pending.find((item) => item.error)?.error}
            </Text>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: colors.red500, fontSize: ms(13) }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
