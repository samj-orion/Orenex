/**
 * ORENEX design tokens — macOS-inspired dark theme.
 *
 * Color palette draws from macOS system colors:
 * - Surfaces: layered dark grays (macOS sidebar / window chrome)
 * - Accents: Apple's green tint recast as a deep mining-green
 * - Semantic: limonite amber (warn), hematite red (critical)
 * - Text: multi-level white/gray hierarchy matching macOS labels
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // macOS-style layered dark surfaces
        mac: {
          // Window / app background levels
          base:     '#161618',   // deepest bg — like macOS app background
          elevated: '#1c1c1e',   // secondary windows / sidebar
          overlay:  '#232325',   // popovers, dropdowns
          card:     '#2c2c2e',   // cards, panels
          control:  '#3a3a3c',   // controls, inputs
          border:   '#3a3a3c',   // subtle borders
          separator:'#48484a',   // dividers
          // Vibrancy / translucent surfaces
          vibrancy: 'rgba(28,28,30,0.72)',
          frosted:  'rgba(44,44,46,0.80)',
        },
        // Apple-system label hierarchy
        label: {
          primary:   'rgba(255,255,255,0.92)',
          secondary: 'rgba(255,255,255,0.60)',
          tertiary:  'rgba(255,255,255,0.38)',
          quaternary:'rgba(255,255,255,0.18)',
        },
        // Primary accent — manganese / deep mining green (Apple green-tinted)
        accent: {
          50:  '#d1f2e8',
          100: '#a3e5d1',
          200: '#5ecfb0',
          300: '#30bf99',
          400: '#15a87e',
          500: '#0e9166',   // default
          600: '#0a7a54',
          700: '#076342',
          800: '#054d33',
          900: '#033625',
          950: '#021f16',
        },
        // Apple system red — critical alerts
        danger: {
          50:  '#ffeaea',
          100: '#ffcaca',
          200: '#ff9494',
          300: '#ff6060',
          400: '#ff3737',
          500: '#ff3b30',   // Apple system red
          600: '#d63029',
          700: '#aa2520',
          800: '#7d1a17',
        },
        // Apple system orange/yellow — warnings
        warn: {
          50:  '#fff8e6',
          100: '#ffefc2',
          200: '#ffd87a',
          300: '#ffc338',
          400: '#ffb300',
          500: '#ff9f0a',   // Apple system orange
          600: '#d6870a',
          700: '#a86b09',
          800: '#7a4f07',
        },
        // Apple system blue — info / geospatial
        info: {
          50:  '#e0eeff',
          100: '#c0ddff',
          200: '#80bbff',
          300: '#409aff',
          400: '#007aff',   // Apple system blue
          500: '#006fe0',
          600: '#0060c2',
          700: '#004da3',
          800: '#003a85',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'Monaco', 'monospace'],
      },
      fontSize: {
        '2xs':    ['0.6875rem', { lineHeight: '1rem',  letterSpacing: '0.01em' }],
        'display':['2.5rem',    { lineHeight: '1.04',  letterSpacing: '-0.032em', fontWeight: '600' }],
        'title':  ['1.375rem',  { lineHeight: '1.18',  letterSpacing: '-0.022em', fontWeight: '600' }],
        'head':   ['1rem',      { lineHeight: '1.35',  letterSpacing: '-0.014em', fontWeight: '600' }],
        'subhead':['0.9375rem', { lineHeight: '1.4',   letterSpacing: '-0.01em',  fontWeight: '500' }],
      },
      borderRadius: {
        DEFAULT: '10px',
        sm:  '6px',
        md:  '8px',
        lg:  '12px',
        xl:  '16px',
        '2xl':'20px',
        full:'9999px',
      },
      boxShadow: {
        // macOS-authentic shadow system
        'mac-1': '0 1px 3px rgba(0,0,0,0.35)',
        'mac-2': '0 2px 8px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.3)',
        'mac-3': '0 4px 16px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.3)',
        'mac-4': '0 8px 32px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.35)',
        'mac-pop':'0 16px 64px rgba(0,0,0,0.8), 0 4px 16px rgba(0,0,0,0.4)',
        'mac-inset': 'inset 0 0.5px 0 rgba(255,255,255,0.08), inset 0 -0.5px 0 rgba(0,0,0,0.2)',
        'mac-border': '0 0 0 0.5px rgba(255,255,255,0.12)',
        'accent-glow':'0 0 20px rgba(14,145,102,0.25)',
        'danger-glow': '0 0 16px rgba(255,59,48,0.25)',
      },
      transitionTimingFunction: {
        'mac-spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'mac-ease':   'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        settle: 'cubic-bezier(0.22, 0.75, 0.24, 1)',
        enter:  'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translate3d(0,10px,0)' },
          to:   { opacity: '1', transform: 'none' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        'slide-left': {
          from: { opacity: '0', transform: 'translate3d(20px,0,0)' },
          to:   { opacity: '1', transform: 'none' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to:   { opacity: '1', transform: 'scale(1)' },
        },
        'draw-in': {
          from: { strokeDashoffset: '1' },
          to:   { strokeDashoffset: '0' },
        },
        'pulse-ring': {
          '0%':   { transform: 'scale(0.82)', opacity: '0.85' },
          '70%':  { transform: 'scale(1.7)',  opacity: '0' },
          '100%': { transform: 'scale(1.7)',  opacity: '0' },
        },
        'shimmer': {
          from: { backgroundPosition: '-640px 0' },
          to:   { backgroundPosition: '640px 0' },
        },
        'strat-drift': {
          from: { backgroundPosition: '0 0' },
          to:   { backgroundPosition: '0 -240px' },
        },
      },
      animation: {
        'fade-up':    'fade-up 0.32s cubic-bezier(0.16,1,0.3,1) both',
        'fade-in':    'fade-in 0.24s ease-out both',
        'slide-left': 'slide-left 0.28s cubic-bezier(0.16,1,0.3,1) both',
        'scale-in':   'scale-in 0.22s cubic-bezier(0.34,1.56,0.64,1) both',
        'draw-in':    'draw-in 0.9s cubic-bezier(0.4,0,0.2,1) both',
        'pulse-ring':  'pulse-ring 2.4s cubic-bezier(0.22,0.75,0.24,1) infinite',
        'shimmer':    'shimmer 1.8s ease-in-out infinite',
        'strat-drift': 'strat-drift 14s linear infinite',
      },
      backdropBlur: {
        'mac': '24px',
        'mac-heavy': '40px',
      },
    },
  },
  plugins: [],
};