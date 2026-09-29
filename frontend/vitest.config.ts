import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // globals: true lets @testing-library/react's automatic afterEach(cleanup)
  // register itself, so DOM from one test never leaks into the next.
  test: { environment: "jsdom", testTimeout: 15000, globals: true, include: ["src/**/*.test.{ts,tsx}"] },
});
