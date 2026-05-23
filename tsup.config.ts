import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    codemirror: "src/codemirror.ts",
    pyodide: "src/pyodide.ts"
  },
  format: ["esm"],
  minify: false,
  splitting: true,
  sourcemap: true,
  target: "es2022"
});
