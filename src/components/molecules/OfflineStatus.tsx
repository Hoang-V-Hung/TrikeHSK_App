import { Text, View } from 'react-native';
import { ms, useTheme } from '@/theme';
import { useOffline } from '@/services/offline/useOffline';
import {
  accountScope,
  getPendingEvents,
  isOffline,
} from '@/services/offline/store';
import { isSavingMedia } from '@/services/offline/cache';
import { isSyncing } from '@/services/offline/sync';

export default function OfflineStatus() {
  useOffline();
  const { colors } = useTheme();
  if (!accountScope()) return null;
  const offline = isOffline();
  const pending = getPendingEvents().length;
  if (!offline && !pending && !isSavingMedia()) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: colors.secondary,
        paddingHorizontal: ms(16),
        paddingVertical: ms(8),
        borderBottomColor: colors.dialogBorder,
        borderBottomWidth: 1,
      }}
    >
      <Text
        style={{ color: colors.gray800, fontSize: ms(12), lineHeight: ms(18) }}
      >
        {offline
          ? 'Mất kết nối · đang dùng nội dung đã lưu trên máy'
          : isSyncing()
            ? 'Đang đồng bộ tiến độ…'
            : pending
              ? 'Tiến độ đang chờ đồng bộ'
              : 'Đang lưu ảnh và audio của bài vừa mở…'}
        {pending ? ` · ${pending} mục chưa gửi` : ''}
      </Text>
    </View>
  );
}
