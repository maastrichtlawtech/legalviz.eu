import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/**/*.test.{js,jsx}',
      'extension/**/*.test.js',
      'backend/shared/formex-parser/**/*.test.js',
    ],
  },
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'fonts/*.woff2'],
      manifest: {
        name: 'LegalViz.EU',
        short_name: 'LegalViz',
        description: 'Interactive visualisation of EU laws',
        theme_color: '#003399',
        background_color: '#003399',
        icons: [
          {
            src: 'favicon.ico',
            sizes: '48x48',
            type: 'image/x-icon'
          },
          {
            src: 'android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,json,xml,xhtml}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
      }
    })
  ]
});
