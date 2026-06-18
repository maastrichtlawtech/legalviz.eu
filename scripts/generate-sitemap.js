import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Helper to get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOMAIN = 'https://legalviz.eu';
const distDir = path.join(__dirname, '../dist');

function collectIndexRoutes(rootDir) {
  const routes = new Set(['/']);

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.name !== 'index.html') continue;

      const relativeDir = path.relative(rootDir, path.dirname(fullPath));
      const route = relativeDir ? `/${relativeDir.split(path.sep).join('/')}` : '/';
      routes.add(route);
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return Array.from(routes).sort((left, right) => left.localeCompare(right));
}

function generateSitemap() {
  const routes = collectIndexRoutes(distDir);
  let sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n';
  sitemap += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const route of routes) {
    sitemap += `<url><loc>${DOMAIN}${route}</loc></url>\n`;
  }

  sitemap += '</urlset>';

  // Write to sitemap.xml and a duplicate sitemap_copy.xml. The copy exists
  // because Google Search Console applies a long fetch back-off to a sitemap
  // URL once it has failed, and our sitemap.xml entry got stuck in that state.
  // The sitemap_copy.xml URL has a healthy fetch history in GSC, so we keep it
  // populated with identical content as a working fallback.
  //
  // Write into both public/ (repo source of truth) and dist/ (the build output
  // that gets deployed). This script runs after `vite build`, which has already
  // copied public/ into dist/, so writing only to public/ would never reach the
  // deployed site.
  const outputDirs = [path.join(__dirname, '../public'), distDir];
  for (const fileName of ['sitemap.xml', 'sitemap_copy.xml']) {
    for (const dir of outputDirs) {
      const outputPath = path.join(dir, fileName);
      fs.writeFileSync(outputPath, sitemap);
      console.log(`Sitemap generated at ${outputPath}.`);
    }
  }
}

generateSitemap();
