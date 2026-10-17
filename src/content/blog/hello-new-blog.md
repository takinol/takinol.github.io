---
title: 你好，我的新博客
date: 2026-10-14
description: 我的博客换成 Astro 搭建啦，这是第一篇正式文章，顺便介绍一下以后怎么写文章。
tags:
  - 博客
  - 随笔
---

欢迎来到我的新博客！我是小猫。

之前的网站是 Hexo 的默认模板，只有一篇 "Hello World"。现在我把它换成了 **Astro** 搭建的站点，风格参考了 [arthals.ink](https://arthals.ink/)，整个网站从零手写，托管在免费的 GitHub Pages 上。

## 这个网站是怎么工作的

简单来说：

1. 文章用 **Markdown** 写在 `src/content/blog/` 文件夹里
2. 每次推送到 GitHub，[GitHub Actions](https://github.com/features/actions) 会自动构建网站
3. 构建结果自动发布到 `https://takinol.github.io/`

所以以后更新博客只需要两步：**写一篇 Markdown → git push**，剩下的全部自动完成。

## Markdown 长什么样

下面这些语法以后写文章都会用到：

### 列表

- 无序列表项
- 再来一个

1. 有序列表
2. 第二项

### 引用

> 这是一段引用文字。

### 代码

```js
console.log('Hello, world!');
```

### 表格

| 语法 | 作用 |
|---|---|
| `#` 标题 | 分节 |
| `**加粗**` | 强调 |
| `[文字](链接)` | 超链接 |

## 接下来

这个博客会用来记录学习笔记、生活碎片，还有各种折腾心得。慢慢写，慢慢长。

就这样，第一篇先到这里。
