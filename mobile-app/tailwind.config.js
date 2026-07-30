/* eslint-disable @typescript-eslint/no-require-imports */
/* global module */

/** @type {import('tailwindcss').Config} */
module.exports = {
  // NativeWind must transform every file that carries className, which here means
  // the Expo Router tree and everything under src/.
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        // Inspection-specific status colours, sourced from the same palette.
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        offline: {
          DEFAULT: 'hsl(var(--offline))',
          foreground: 'hsl(var(--offline-foreground))',
        },
        'pending-sync': {
          DEFAULT: 'hsl(var(--pending-sync))',
          foreground: 'hsl(var(--pending-sync-foreground))',
        },
        uploading: {
          DEFAULT: 'hsl(var(--uploading))',
          foreground: 'hsl(var(--uploading-foreground))',
        },
        processing: {
          DEFAULT: 'hsl(var(--processing))',
          foreground: 'hsl(var(--processing-foreground))',
        },
        'needs-review': {
          DEFAULT: 'hsl(var(--needs-review))',
          foreground: 'hsl(var(--needs-review-foreground))',
        },
        approved: {
          DEFAULT: 'hsl(var(--approved))',
          foreground: 'hsl(var(--approved-foreground))',
        },
        rejected: {
          DEFAULT: 'hsl(var(--rejected))',
          foreground: 'hsl(var(--rejected-foreground))',
        },
        failed: {
          DEFAULT: 'hsl(var(--failed))',
          foreground: 'hsl(var(--failed-foreground))',
        },
        recording: {
          DEFAULT: 'hsl(var(--recording))',
          foreground: 'hsl(var(--recording-foreground))',
        },
        'capture-guide': {
          DEFAULT: 'hsl(var(--capture-guide))',
          foreground: 'hsl(var(--capture-guide-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};
