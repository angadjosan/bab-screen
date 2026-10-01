/* ============================================================================
   Blockchain at Berkeley — Tailwind v3 config
   For Tailwind CSS v3. In v4, prefer references/tailwind.css (@theme) instead.

   Usage (v3):
     // tailwind.config.js
     const bab = require('./references/tailwind.config.js');
     module.exports = { content: ['./**/*.{html,js,jsx,ts,tsx}'], ...bab };

   Utilities produced (examples):
     bg-bab-black  text-bab-gold  border-bab-line-soft
     font-display  text-display-xl  tracking-bab
     p-pad  gap-row  max-w-bab  rounded-bab
   Load the fonts via <link> (see SKILL.md) or @fontsource.
   ========================================================================== */

module.exports = {
  theme: {
    extend: {
      colors: {
        bab: {
          black:      '#0C0C0C',      // shipped canvas; Figma spec #0A0A0A
          'black-alt':'#0A0A0A',
          'black-true':'#000000',
          'surface-1':'#111111',
          'surface-2':'#1B1B1B',
          line:       '#2A2A2A',
          'line-soft':'rgba(42, 42, 42, 0.65)',
          'line-lit': '#3B3B3B',
          white:      '#FFFFFF',
          dim:        'rgba(255, 255, 255, 0.70)',
          mute:       'rgba(255, 255, 255, 0.50)',
          faint:      'rgba(255, 255, 255, 0.30)',
          gold:       '#FECB33',      // shipped brand gold (logo, "Apply")
          'gold-sub': '#F8BE34',      // "AT BERKELEY" subtitle gold
          'gold-deep':'#EAA536',      // shaded logo face / pressed
          'gold-cal': '#FDB515',      // official Berkeley California Gold
          'wordmark-dark':  '#E5E5E5', // "BLOCKCHAIN" on dark canvas
          'wordmark-light': '#3D3D3D', // "BLOCKCHAIN" on light canvas
          'gold-warm':'#F4B320',
          'gold-hot': '#FAE42C',
          'amber-deep':'#A43E04',
          blue:       '#003262',
        },
      },
      fontFamily: {
        display: ['"EB Garamond"', 'Georgia', '"Times New Roman"', 'serif'],
        sans:    ['"Instrument Sans"', '-apple-system', '"Segoe UI"', 'Helvetica', 'sans-serif'],
        mono:    ['"DM Mono"', '"IBM Plex Mono"', '"SF Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
      fontSize: {
        // [size, { lineHeight }]
        'display-xl': ['clamp(3.5rem, 9.5vw, 9rem)',   { lineHeight: '0.81' }],
        'display-l':  ['clamp(3rem, 6.4vw, 6rem)',     { lineHeight: '0.86' }],
        'display-m':  ['clamp(2.25rem, 4.2vw, 4rem)',  { lineHeight: '0.92' }],
        'display-s':  ['clamp(1.75rem, 2.6vw, 2.5rem)',{ lineHeight: '1.0'  }],
        lead:         ['clamp(1.2rem, 1.5vw, 1.44rem)',{ lineHeight: '1.4'  }],
        body:         ['1rem',      { lineHeight: '1.5'  }],
        small:        ['0.875rem',  { lineHeight: '1.45' }],
        label:        ['0.75rem',   { lineHeight: '1'    }],
        micro:        ['0.6875rem', { lineHeight: '1'    }],
      },
      letterSpacing: {
        bab: '-0.03em',              // the -3% fingerprint
      },
      spacing: {
        pad:    '31px',
        row:    '46px',
        margin: '69px',
        cell:   '224px',
      },
      maxWidth: {
        bab: '1374px',
      },
      borderRadius: {
        bab: '0px',
      },
      transitionTimingFunction: {
        bab: 'cubic-bezier(0.2, 0.6, 0, 1)',
      },
      transitionDuration: {
        fast: '150ms',
        slow: '480ms',
      },
    },
  },
  plugins: [],
};
