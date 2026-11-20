import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../static, which Flask serves. `npm run dev` proxies the API to the Flask server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../static", emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:5050" } },
});
