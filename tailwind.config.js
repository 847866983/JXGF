/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0b10',
          900: '#10121a',
          850: '#151824',
          800: '#1b1f2e',
          700: '#262b3d',
          600: '#343b52'
        },
        accent: {
          DEFAULT: '#7c5cff',
          400: '#9b82ff',
          500: '#7c5cff',
          600: '#6746f0'
        }
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'Segoe UI',
          'Microsoft YaHei',
          'PingFang SC',
          'sans-serif'
        ]
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.35)'
      }
    }
  },
  plugins: []
}
