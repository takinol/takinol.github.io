import { defineCollection, z } from 'astro:content';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

/**
 * 轻量 Markdown loader：
 * 读取 src/content/blog/ 下的 .md 文件，手工解析 frontmatter，
 * 用 Astro 自带的 renderMarkdown 渲染正文。
 * （不依赖 astro/loaders，避免在本环境下加载 CJS 的 yaml 包。）
 */

function parseScalar(raw: string): string | number | boolean {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s.replace(/^["']|["']$/g, '');
}

function parseFrontmatter(source: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const fm = match[1];
  const body = source.slice(match[0].length);
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  for (const line of fm.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
    if (kv) {
      currentKey = kv[1];
      const value = kv[2].trim();
      data[currentKey] = value === '' ? [] : parseScalar(value);
    } else if (currentKey && trimmed.startsWith('- ')) {
      const list = (data[currentKey] ??= []) as unknown[];
      list.push(parseScalar(trimmed.slice(2)));
    }
  }
  return { data, body };
}

const markdownLoader = {
  name: 'markdown-loader',
  load: async (context: any) => {
    const { store, parseData, renderMarkdown, generateDigest, config, logger } = context;
    const dir = new URL('./content/blog/', config.srcDir);
    const dirPath = fileURLToPath(dir);
    const rootPath = fileURLToPath(config.root);

    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const fileUrl = new URL(file, dir);
      const filePath = fileURLToPath(fileUrl);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch (error) {
        logger.error(`读取文章失败：${file} ${(error as Error).message}`);
        continue;
      }
      const { data: frontmatter, body } = parseFrontmatter(raw);
      const id = file.replace(/\.md$/, '');
      let parsedData: any;
      try {
        parsedData = await parseData({ id, data: frontmatter as any, filePath });
      } catch (error) {
        // 某一篇格式坏了只跳过这一篇，不让整个网站构建失败
        logger.error(`[跳过] ${file} 的 frontmatter 格式有误：${(error as Error).message}`);
        continue;
      }
      let rendered: any;
      try {
        rendered = await renderMarkdown(body, { fileURL: fileUrl });
      } catch (error) {
        logger.error(`渲染文章失败：${file} ${(error as Error).message}`);
        continue;
      }
      store.set({
        id,
        data: parsedData,
        body,
        filePath: relative(rootPath, filePath).replace(/\\/g, '/'),
        digest: generateDigest(raw),
        rendered,
        assetImports: rendered?.metadata?.imagePaths,
      });
    }
  },
};

// 博客文章集合：src/content/blog/ 下的 .md 文件
const blog = defineCollection({
  loader: markdownLoader,
  schema: z.object({
    // 文章标题
    title: z.string(),
    // 发布日期（YYYY-MM-DD），会被自动格式化成中文
    date: z.coerce.date(),
    // 文章简介（列表页和搜索用）
    description: z.string().optional(),
    // 标签（可省略）
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { blog };
