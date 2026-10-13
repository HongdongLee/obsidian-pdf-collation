import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { fs: { allow: [resolve(__dirname, "..")] } },
  build: { target: "es2022" },
});
