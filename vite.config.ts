import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: [
        "@modelcontextprotocol/sdk/server/index.js",
        "@modelcontextprotocol/sdk/server/stdio.js",
        "@modelcontextprotocol/sdk/server/sse.js",
        "@modelcontextprotocol/sdk/types.js",
        "express",
        /^node:.*/,  // Externalize all node: imports
      ],
    },
    target: "node18",
    outDir: "build",
    sourcemap: true,
    ssr: true,  // Build for server-side rendering (Node.js)
  },
  plugins: [dts()],
});
