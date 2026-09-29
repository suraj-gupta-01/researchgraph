import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  // Never inline assets as data: URIs. The production CSP allows fonts and
  // images from 'self' only (nginx/default.conf.template); an inlined
  // woff2 subset was blocked there, found by the browser evidence pass.
  build: { assetsInlineLimit: 0 },
});
