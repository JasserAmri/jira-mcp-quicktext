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
      // Keep express + node built-ins external. express is only referenced by the
      // unused HTTP/SSE transport (not in the stdio entry's import graph), so it is
      // never actually imported at runtime.
      external: [
        "express",
        /^node:.*/,  // Externalize all node: imports
      ],
    },
    target: "node18",
    outDir: "build",
    sourcemap: true,
    ssr: true,  // Build for server-side rendering (Node.js)
  },
  // Bundle ALL dependencies (the SDK and its transitive deps: zod, ajv, etc.) into
  // build/index.js so the output is fully self-contained — no node_modules needed at
  // runtime, which is what the MCPB extension bundle requires. Only express (unused,
  // referenced by the dead HTTP/SSE transport) and node built-ins stay external.
  ssr: {
    noExternal: true,
    external: ["express"],
  },
  plugins: [dts()],
});
