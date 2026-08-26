import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Deployed to GitHub Pages at https://<user>.github.io/eu-digital-laws/ for
// now; BASE_PATH collapses to "/" once the site moves to a custom domain.
export default defineConfig({
  base: process.env.BASE_PATH || "/eu-digital-laws/",
  plugins: [react()],
});
