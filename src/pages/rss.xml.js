import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { site } from '../data/site';

const posts = (await getCollection('blog')).sort(
  (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
);

export const prerender = true;

export const GET = (context) =>
  rss({
    title: `${site.name} · ${site.tagline}`,
    description: site.description,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `/blog/${post.id}/`,
    })),
  });
