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
    port: 3000,
  },
}));
