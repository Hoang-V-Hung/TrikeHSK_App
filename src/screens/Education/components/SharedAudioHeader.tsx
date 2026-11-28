import { Text, View } from 'react-native';
import { ms, useTheme, vs } from '@/theme';
import { QuestionAudioPlayer } from './QuestionAudioPlayer';

export function SharedAudioHeader({
  url,
  label,
  onHeight,
}: {
  url: string;
  label: string;
  onHeight: (height: number) => void;
}) {
  const { colors, variant } = useTheme();
  const textColor = variant === 'dark' ? colors.accentLightBlue : colors.primaryAction;
  return (
    <View
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={{ backgroundColor: colors.secondary, paddingBottom: vs(10) }}
    >
      <View
        style={{
          backgroundColor: colors.surface,
          borderColor: colors.gray100,
          borderWidth: 1,
          borderRadius: ms(12),
          padding: ms(12),
          gap: vs(6),
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ fontSize: ms(13), fontWeight: '700', color: textColor }}
        >
          Audio dùng chung · {label}
        </Text>
        <QuestionAudioPlayer
          url={url}
          label={`chung ${label.toLowerCase()}`}
          seekable
          textColor={textColor}
        />
      </View>
    </View>
  );
}

export function SharedAudioEnd() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.secondary }} />;
}
