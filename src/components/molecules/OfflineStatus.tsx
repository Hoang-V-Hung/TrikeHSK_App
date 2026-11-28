import { Text } from 'react-native';
import { ms, useTheme } from '@/theme';
import { useIsOffline } from '@/services/offline/useOffline';

export default function OfflineStatus() {
  const offline = useIsOffline();
  const { colors } = useTheme();
  if (!offline) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: colors.secondary,
        color: colors.dialogText,
        fontSize: ms(12),
        paddingHorizontal: ms(12),
        paddingVertical: ms(4),
        textAlign: 'center',
      }}
    >
      Bạn đang ngoại tuyến
    </Text>
  );
}
