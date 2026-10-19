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
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (kv) {
      currentKey = kv[1];
      const value = kv[2].trim();
      if (value === '') {
        data[currentKey] = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // 支持 Obsidian 默认的 tags: [a, b] 行内数组写法
        const inner = value.slice(1, -1).trim();
        data[currentKey] = inner
          ? inner
              .split(',')
              .map((s) => parseScalar(s))
              .filter((s) => s !== '')
          : [];
      } else {
        data[currentKey] = parseScalar(value);
      }
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
    // 每次构建先清空内容仓库：否则删掉的文章会残留在缓存里继续显示
    store.clear();
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
    // 更新日期（可选，写了会在列表里显示“更新 X”）
    updated: z.coerce.date().optional(),
    // 文章简介（列表页和搜索用）
    description: z.string().optional(),
    // 标签（可省略）
    tags: z.array(z.string()).default([]),
    // 文章语言（不写默认中文）
    language: z.string().default('中文'),
    // 草稿：draft: true 会从网站上「下架」（列表/搜索/RSS 都不显示），但文件保留
    draft: z.boolean().default(false),
    // 加密：写了 password 的文章在列表/搜索照常显示，但正文必须输对密码才能看
    password: z.string().optional(),
  }),
});

export const collections = { blog };
