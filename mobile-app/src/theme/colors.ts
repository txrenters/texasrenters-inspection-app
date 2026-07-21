export const brandColors = {
  blue: '#1D4492',
  green: '#85C43F',
  white: '#FFFFFF',
} as const;

const lightPalette = {
  primary: brandColors.blue,
  primaryDark: '#142F66',
  primarySoft: '#E5ECFA',
  secondary: brandColors.green,
  secondaryDark: '#527A24',
  secondarySoft: '#EEF7E4',
  background: '#F5F7FB',
  surface: '#FFFFFF',
  surfaceMuted: '#EDF1F7',
  textPrimary: '#14213A',
  textSecondary: '#5C6A80',
  border: '#D9E0EA',
  success: '#397A35',
  successSoft: '#E5F3E1',
  warning: '#94601B',
  warningSoft: '#F8EBD2',
  danger: '#B64040',
  dangerSoft: '#F8E1E1',
  info: '#315FAF',
  infoSoft: '#E2EBFA',
  white: '#FFFFFF',
  overlay: 'rgba(8, 20, 43, 0.58)',
  ink: '#14213A',
  muted: '#5C6A80',
  canvas: '#F5F7FB',
  paleBlue: '#E5ECFA',
  accent: brandColors.green,
} as const;

export type AppColors = { [Name in keyof typeof lightPalette]: string };

export const lightColors: AppColors = lightPalette;

export const darkColors: AppColors = {
  primary: '#6E95E8',
  primaryDark: brandColors.blue,
  primarySoft: '#1A2B4E',
  secondary: brandColors.green,
  secondaryDark: '#A8D96E',
  secondarySoft: '#24361D',
  background: '#0B1220',
  surface: '#121C2D',
  surfaceMuted: '#19263A',
  textPrimary: '#F2F6FC',
  textSecondary: '#B1BED0',
  border: '#2A3950',
  success: '#75C46F',
  successSoft: '#19351F',
  warning: '#E1AE5A',
  warningSoft: '#3B2C18',
  danger: '#F08080',
  dangerSoft: '#402123',
  info: '#86A9EE',
  infoSoft: '#1A2D50',
  white: '#FFFFFF',
  overlay: 'rgba(0, 0, 0, 0.72)',
  ink: '#F2F6FC',
  muted: '#B1BED0',
  canvas: '#0B1220',
  paleBlue: '#1A2B4E',
  accent: brandColors.green,
};

// Kept for non-visual compatibility. UI code should consume useAppTheme().colors.
export const colors = lightColors;
