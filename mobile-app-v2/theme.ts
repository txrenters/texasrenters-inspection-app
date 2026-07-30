import { vars } from "nativewind";

export interface ThemeFonts {
  heading: {
    family: string;
    weights: Record<string, string>;
  };
  body: {
    family: string;
    weights: Record<string, string>;
  };
  mono: {
    family: string;
    weights: Record<string, string>;
  };
}

export const themeFonts: ThemeFonts = {
  heading: {
    family: 'Inter',
    weights: {
      normal: 'Inter_400Regular',
      medium: 'Inter_500Medium',
      semibold: 'Inter_600SemiBold',
      bold: 'Inter_700Bold',
    },
  },
  body: {
    family: 'Inter',
    weights: {
      normal: 'Inter_400Regular',
      medium: 'Inter_500Medium',
      semibold: 'Inter_600SemiBold',
    },
  },
  mono: {
    family: 'JetBrainsMono',
    weights: {
      normal: 'JetBrainsMono_400Regular',
      medium: 'JetBrainsMono_500Medium',
    },
  },
};

// TexasRenters — Professional field inspection palette
// Deep teal primary, warm stone neutrals, amber accents

export const lightTheme = vars({
  "--radius": "12",

  "--background": "252 251 248",
  "--foreground": "15 23 42",

  "--card": "255 255 255",
  "--card-foreground": "15 23 42",

  "--popover": "255 255 255",
  "--popover-foreground": "15 23 42",

  "--primary": "20 83 73",
  "--primary-foreground": "240 253 250",

  "--secondary": "245 240 235",
  "--secondary-foreground": "20 83 73",

  "--muted": "241 239 235",
  "--muted-foreground": "120 113 105",

  "--accent": "250 245 238",
  "--accent-foreground": "20 83 73",

  "--destructive": "185 28 28",

  "--border": "226 222 217",
  "--input": "226 222 217",
  "--ring": "20 83 73",

  "--chart-1": "231 111 81",
  "--chart-2": "20 150 130",
  "--chart-3": "59 130 100",
  "--chart-4": "217 140 65",
  "--chart-5": "142 100 186",

  "--sidebar": "250 248 245",
  "--sidebar-foreground": "15 23 42",
  "--sidebar-primary": "20 83 73",
  "--sidebar-primary-foreground": "240 253 250",
  "--sidebar-accent": "245 240 235",
  "--sidebar-accent-foreground": "20 83 73",
  "--sidebar-border": "226 222 217",
  "--sidebar-ring": "20 83 73",
});

export const darkTheme = vars({
  "--radius": "12",

  "--background": "10 15 24",
  "--foreground": "236 240 243",

  "--card": "17 24 35",
  "--card-foreground": "236 240 243",

  "--popover": "22 30 42",
  "--popover-foreground": "236 240 243",

  "--primary": "45 212 191",
  "--primary-foreground": "4 40 35",

  "--secondary": "25 35 48",
  "--secondary-foreground": "236 240 243",

  "--muted": "25 35 48",
  "--muted-foreground": "94 107 120",

  "--accent": "30 42 55",
  "--accent-foreground": "236 240 243",

  "--destructive": "239 68 68",

  "--border": "30 42 55",
  "--input": "25 35 48",
  "--ring": "45 212 191",

  "--chart-1": "248 140 110",
  "--chart-2": "45 212 191",
  "--chart-3": "74 222 128",
  "--chart-4": "251 191 99",
  "--chart-5": "177 130 208",

  "--sidebar": "15 20 30",
  "--sidebar-foreground": "236 240 243",
  "--sidebar-primary": "45 212 191",
  "--sidebar-primary-foreground": "4 40 35",
  "--sidebar-accent": "25 35 48",
  "--sidebar-accent-foreground": "236 240 243",
  "--sidebar-border": "30 42 55",
  "--sidebar-ring": "45 212 191",
});
