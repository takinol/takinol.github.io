---
title: 网站是怎么搭起来的（写给未来的自己）
date: 2026-10-14
description: 记录一下这个网站用到的技术栈和部署流程，方便以后维护。
tags:
  - 教程
  - 网站
---

这篇写给未来的自己，也写给想搭同样博客的人：这个网站是怎么从零搭起来的。

## 技术栈

- **框架**：[Astro](https://astro.build/) —— 静态网站生成器，内容用 Markdown 写，构建后输出纯静态 HTML
- **样式**：手写 CSS（`src/styles/global.css`），支持深色 / 浅色主题切换
- **托管**：[GitHub Pages](https://pages.github.com/) —— 免费、自动 HTTPS
- **自动部署**：GitHub Actions 工作流（`.github/workflows/deploy.yml`）

## 目录结构

```
takinol.github.io/
├── .github/workflows/    # 自动部署配置
├── public/               # 静态资源（favicon 等）
├── src/
│   ├── content/blog/     # 文章（Markdown）
│   ├── data/             # 站点信息、技能、教育经历等数据
│   ├── layouts/          # 页面布局
│   ├── pages/            # 各个页面
│   └── styles/           # 全局样式
└── astro.config.mjs      # Astro 配置
```

## 想改什么，去哪里改

| 想改的东西 | 改哪个文件 |
|---|---|
| 名字 / 简介 / 链接 | `src/data/site.ts` |
| 教育经历 | `src/data/education.ts` |
| 技能标签 | `src/data/skills.ts` |
| 项目 | `src/data/projects.ts` |
| 友链 | `src/data/links.ts` |
| 颜色 / 字体 | `src/styles/global.css` 顶部的变量 |

## 部署流程

```bash
# 本地预览
npm install
npm run dev

# 构建
npm run build

# 推送到 GitHub 后自动部署
git add .
git commit -m "更新"
git push
```

好了，记录完毕，收工。
