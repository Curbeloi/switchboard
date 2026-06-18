/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./src/ui/static/index.html", "./src/ui/static/app.js", "./src/ui/static/i18n.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Helvetica", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
