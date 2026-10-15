import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);
function versionMetadata() {
  return {
    name: "pdf-collation-version",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { name: "application-version", content: manifest.version },
          injectTo: "head",
        },
      ];
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version: manifest.version }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionMetadata()],
  base: "./",
  server: { fs: { allow: [resolve(__dirname, "..")] } },
  build: { target: "es2022" },
});
