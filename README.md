# takinol.github.io

我是小猫，这里是 takinol 的博客。

用 [Astro](https://astro.build/) 搭建，部署在 [GitHub Pages](https://pages.github.com/)，每次 `git push` 后由 GitHub Actions 自动构建发布。

线上地址：https://takinol.github.io/

## ⚡ 一键导入 Obsidian 笔记（推荐）

双击 **`上传文章.bat`**，把笔记的绝对路径粘进去回车；或者直接把 `.md` 文件拖到这个 `.bat` 上。

脚本会自动把笔记和它引用的图片复制进仓库、改写图片语法、补好 frontmatter，并自动 `git add` + `git commit`。完事只需要：

```bash
git push
```

细节：`![[图片]]`（含 `|宽度` 写法）、`![](相对路径)`、`[[双链]]`、`> [!info]` 提示块、`%%注释%%` 都会处理；大于 300KB 的 PNG 自动转 JPG；图片找不到时会中止，避免上线后图裂。

## 📝 手动更新博客（两步）

1. **写文章**：在 `src/content/blog/` 文件夹里新建一个 `.md` 文件，开头加上这几行信息：

   ```markdown
   ---
   title: 文章标题
   date: 2026-10-14
   description: 一句话简介
   tags:
     - 标签1
   ---

   正文用 Markdown 写……
   ```

2. **推送**：打开终端，进入项目文件夹，执行：

   ```bash
   git add .
   git commit -m "新文章"
   git push
   ```

   等 1~2 分钟，GitHub Actions 构建完，文章就上线了。

## 🛠 常用命令（本地预览）

```bash
npm install    # 第一次要装依赖
npm run dev    # 本地预览，浏览器打开 http://localhost:4321
npm run build  # 构建出 dist/ 文件夹
```

## ✏️ 想改网站内容，改这些文件

| 想改的东西 | 文件 |
|---|---|
| 名字 / 简介 / 邮箱 / GitHub 链接 | `src/data/site.ts` |
| 教育经历 | `src/data/education.ts` |
| 技能标签 | `src/data/skills.ts` |
| 项目页内容 | `src/data/projects.ts` |
| 友链页内容 | `src/data/links.ts` |
| 颜色 / 字体 / 主题 | `src/styles/global.css` 顶部的变量 |
| 网站标题文字（About 区块） | `src/pages/index.astro` |

## 🌐 首次部署注意事项（只做一次）

GitHub Pages 的部署来源需要从「分支」改成「GitHub Actions」：

1. 打开仓库 → **Settings** → 左侧 **Pages**
2. **Build and deployment** → Source 选 **GitHub Actions**
3. 完事。之后每次 push 都会自动构建部署。

## 📁 目录结构

```
├── .github/workflows/    # 自动部署配置
├── public/               # 静态资源（favicon）
├── src/
│   ├── content/blog/     # 📝 文章（Markdown）
│   ├── data/             # 站点信息等数据
│   ├── layouts/          # 页面布局
│   ├── pages/            # 页面（首页/Blog/Projects/Links/About/搜索）
│   └── styles/           # 全局样式
└── astro.config.mjs      # Astro 配置
```
