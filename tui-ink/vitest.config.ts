import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic", // matches tsconfig "jsx": "react-jsx"
  },
  test: {
    environment: "node", // ink-testing-library renders to a string, no DOM needed
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
