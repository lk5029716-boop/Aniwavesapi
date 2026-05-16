/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          900: '#0d1117',
          800: '#161b22',
          700: '#21262d',
          600: '#30363d',
        },
        accent: {
          blue: '#58a6ff',
          green: '#3fb950',
          orange: '#d29922',
          red: '#f85149',
          purple: '#a371f7',
        }
      }
    },
  },
  plugins: [],
}
