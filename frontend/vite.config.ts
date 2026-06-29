import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gatewayTarget = process.env.VITE_GATEWAY_TARGET || "http://127.0.0.1:3000";
const gatewayWsTarget = gatewayTarget.replace(/^http/, "ws");

export default defineConfig({
  base: "/live/",
  plugins: [react()],
  server: {
    fs: {
      strict: false
    },
    proxy: {
      "/api": gatewayTarget,
      "/healthz": gatewayTarget,
      "/ws": {
        target: gatewayWsTarget,
        ws: true
      },
      "/live/api": {
        target: gatewayTarget,
        rewrite: (path) => path.replace(/^\/live/, "")
      },
      "/live/healthz": {
        target: gatewayTarget,
        rewrite: (path) => path.replace(/^\/live/, "")
      },
      "/live/ws": {
        target: gatewayWsTarget,
        rewrite: (path) => path.replace(/^\/live/, ""),
        ws: true
      }
    }
  }
});
