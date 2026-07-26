/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        page: '#f3f4f6',
        card: '#ffffff',
        accent: {
          DEFAULT: '#f97316',
          hover: '#ea580c',
        },
        semantic: {
          red: '#ef4444',
          amber: '#f59e0b',
          emerald: '#10b981',
          teal: '#14b8a6',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
      gridTemplateColumns: {
        '24': 'repeat(24, minmax(0, 1fr))',
      },
    },
  },
  plugins: [],
}
