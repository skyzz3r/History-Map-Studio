import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages serves project sites from /<repo>/, so assets need that prefix.
// Reading it from the env var Actions already sets means the repo can be renamed
// or forked without touching this file. Locally the var is unset -> "/".
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];

export default defineConfig({
  base: repo ? `/${repo}/` : "/",
  plugins: [react(), tailwindcss()],
});
