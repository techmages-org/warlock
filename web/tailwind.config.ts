import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        warlock: {
          bg: "#0a0a0f",
          panel: "#14141c",
          border: "#2a2a38",
          accent: "#b668ff",
          safe: "#22c55e",
          danger: "#ef4444",
          warn: "#eab308",
          muted: "#8a8aa0",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
