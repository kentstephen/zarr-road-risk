import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Project Pages site lives at https://kentstephen.github.io/zarr-road-risk/,
  // so production asset URLs must be prefixed with the repo name. Local dev
  // stays at "/" for ergonomics.
  base: command === "build" ? "/zarr-road-risk/" : "/",
  worker: { format: "es" },
  server: {
    // Standard dev port for anyone cloning the repo. Override per-machine with
    // the PORT env var — Stephen runs another process on 3000, so he launches
    // with `PORT=5371 npm run dev` (see CLAUDE.md). strictPort makes a taken
    // port fail loudly rather than silently hopping elsewhere.
    port: Number(process.env.PORT) || 3000,
    strictPort: true,
  },
}));
