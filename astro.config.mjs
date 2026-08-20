import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import { buildDocIndex } from './src/lib/doc-index.mjs';
import { remarkWikilink } from './src/lib/remark-wikilink.mjs';

const BASE = (process.env.PUBLIC_BASE ?? '').replace(/\/$/, '');
const SITE = process.env.SITE_URL ?? 'https://design-docs.example.com';
const DOCS_ROOT = fileURLToPath(new URL('./src/content/docs/', import.meta.url));
const strictWikilinks = process.env.NODE_ENV === 'production' || process.env.CI === 'true';
const docIndex = buildDocIndex(DOCS_ROOT, { strictWikilinks });

export default defineConfig({
  site: SITE,
  base: BASE || undefined,
  trailingSlash: 'always',
  integrations: [sitemap()],
  markdown: {
    processor: unified({
      remarkPlugins: [
        [remarkWikilink, { base: BASE, index: docIndex, strict: strictWikilinks }],
        remarkMath,
      ],
      rehypePlugins: [
        rehypeSlug,
        [rehypeAutolinkHeadings, { behavior: 'wrap' }],
        rehypeKatex,
      ],
    }),
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['mermaid', 'math'],
    },
    shikiConfig: {
      theme: 'github-dark-default',
      wrap: false,
    },
  },
});
