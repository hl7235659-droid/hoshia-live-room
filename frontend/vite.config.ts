import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/live/",
  plugins: [react()],
  server: {
    fs: {
      strict: false
    },
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
      "/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true
      },
      "/live/api": {
        target: "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/live/, "")
      },
      "/live/healthz": {
        target: "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/live/, "")
      },
      "/live/ws": {
        target: "ws://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/live/, ""),
        ws: true
      }
    }
  }
});
