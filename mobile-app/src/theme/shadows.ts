import { Platform, type ViewStyle } from 'react-native';

export const shadows: Record<'card' | 'floating', ViewStyle> = {
  card: Platform.select({
    web: { boxShadow: '0 4px 12px rgba(29, 41, 40, 0.07)' },
    default: {
      shadowColor: '#1D2928',
      shadowOpacity: 0.07,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
  }),
  floating: Platform.select({
    web: { boxShadow: '0 8px 18px rgba(29, 41, 40, 0.14)' },
    default: {
      shadowColor: '#1D2928',
      shadowOpacity: 0.14,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 6,
    },
  }),
};
