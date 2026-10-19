// 站点信息（改这里就能改全站显示的名字/简介/链接）

export const site = {
  // 显示在网站上的名字
  name: 'takinol',
  // 一句话简介（首页名字下方）
  tagline: '我是小猫',
  // 浏览器标签页标题后缀
  titleSuffix: 'takinol',
  // 页面描述（SEO）
  description: '我是小猫，这里是 takinol 的博客。',
  // 所在地（可选，不需要就留空字符串）
  location: '',
  // 你的链接
  links: {
    github: 'https://github.com/takinol',
    email: 'mailto:835648821@qq.com',
  },
};

// 导航菜单
export const nav = [
  { label: 'Blog', href: '/blog' },
  { label: 'photo', href: '/photos' },
  { label: 'Projects', href: '/projects' },
  { label: 'Links', href: '/links' },
  { label: 'About', href: '/about' },
];
