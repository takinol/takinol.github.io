// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // 你的站点地址：GitHub Pages 免费域名
  site: 'https://takinol.github.io',
  integrations: [sitemap()],
});
