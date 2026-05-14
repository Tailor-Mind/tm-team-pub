// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Update `site` after first GitHub Pages deploy.
// Example: 'https://<org-or-user>.github.io'
// If served from a project subpath, also set `base: '/<repo-name>'`.
export default defineConfig({
  site: 'https://tailormind.github.io',
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es'],
    routing: { prefixDefaultLocale: true, redirectToDefaultLocale: true },
  },
});
