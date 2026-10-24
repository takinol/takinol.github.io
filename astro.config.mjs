// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
  // 你的站点地址：GitHub Pages 免费域名
  site: 'https://takinol.github.io',
  integrations: [sitemap()],
  // 开发工具条会遮挡画布底部，逐帧检查时碍事，关掉（只影响 dev，不影响构建）
  devToolbar: { enabled: false },
  markdown: {
    // 支持 $$...$$ 块公式 与 $...$ 行内公式
    remarkPlugins: [remarkMath],
    // 用 KaTeX 把公式渲染成 HTML；throwOnError:false / strict:false
    // 保证公式里夹了中文或小瑕疵时不会让整页构建失败
    rehypePlugins: [
      [rehypeKatex, { throwOnError: false, strict: false, output: 'html' }],
    ],
  },
});
