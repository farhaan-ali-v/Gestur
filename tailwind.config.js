/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        void: '#0A0A0A',
        ink: '#FFFFFF',
        graphite: '#121212',
        steel: '#1D1D1D',
        neon: '#CCFF00',
        neonBlue: '#00E5FF',
        neonMagenta: '#FF2BD6',
        success: '#00FF7F',
        danger: '#FF3B30',
      },
      fontFamily: {
        display: ['"Space Grotesk"', '"IBM Plex Sans"', '"Segoe UI"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        brutal: '6px 6px 0 #CCFF00',
        brutalSoft: '6px 6px 0 #1F1F1F',
      },
    },
  },
  plugins: [],
}
