import type { Config } from "tailwindcss";

// Warlock phosphor-HUD palette. Violet + amber are co-primary accents on a
// near-black base. See src/index.css for the :root CSS custom properties that
// back these tokens — the two sources must stay in sync.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "var(--bg-base)",
          tile: "var(--bg-tile)",
          elev: "var(--bg-elev)",
          strip: "var(--bg-strip)",
        },
        line: {
          dim: "var(--line-dim)",
          mid: "var(--line-mid)",
        },
        txt: {
          dim: "var(--txt-dim)",
          body: "var(--txt-body)",
          hi: "var(--txt-hi)",
        },
        violet: {
          bright: "var(--violet-bright)",
          DEFAULT: "var(--violet-base)",
          base: "var(--violet-base)",
          deep: "var(--violet-deep)",
        },
        amber: {
          bright: "var(--amber-bright)",
          DEFAULT: "var(--amber-base)",
          base: "var(--amber-base)",
          deep: "var(--amber-deep)",
        },
        mint: {
          safe: "var(--mint-safe)",
          DEFAULT: "var(--mint-safe)",
        },
        cyan: {
          signal: "var(--cyan-signal)",
          DEFAULT: "var(--cyan-signal)",
        },
        pink: {
          alert: "var(--pink-alert)",
          DEFAULT: "var(--pink-alert)",
        },
        // Preserve legacy warlock.* tokens so stray old references compile to
        // reasonable phosphor equivalents. Intentionally dim mapping — nothing
        // new should reference these, but this avoids a hard failure if a file
        // slips through.
        warlock: {
          bg: "var(--bg-base)",
          panel: "var(--bg-tile)",
          border: "var(--line-dim)",
          accent: "var(--amber-base)",
          safe: "var(--mint-safe)",
          danger: "var(--pink-alert)",
          warn: "var(--amber-base)",
          muted: "var(--txt-dim)",
          text: "var(--txt-hi)",
        },
      },
      fontFamily: {
        mono: [
          "'IBM Plex Mono'",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      letterSpacing: {
        label: "0.08em",
        hud: "0.12em",
      },
      fontSize: {
        hud: ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.08em" }],
        body: ["0.8125rem", { lineHeight: "1.25rem" }],
      },
      boxShadow: {
        "glow-amber": "var(--glow-amber)",
        "glow-violet": "var(--glow-violet)",
        "glow-mint": "var(--glow-mint)",
        "glow-pink": "var(--glow-pink)",
        "tile-inset": "inset 0 0 0 1px var(--line-dim)",
      },
      keyframes: {
        "pulse-live": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.92)" },
        },
        "cursor-blink": {
          "0%, 50%": { opacity: "1" },
          "50.01%, 100%": { opacity: "0" },
        },
        "value-flash": {
          "0%": { backgroundColor: "rgba(255,179,71,0.22)" },
          "100%": { backgroundColor: "transparent" },
        },
        "scanline-sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "pulse-live": "pulse-live 1.2s ease-in-out infinite",
        "cursor-blink": "cursor-blink 1s step-end infinite",
        "value-flash": "value-flash 300ms ease-out",
        "scanline-sweep": "scanline-sweep 2.4s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
