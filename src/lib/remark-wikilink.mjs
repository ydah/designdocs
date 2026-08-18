import { visit } from 'unist-util-visit';

const WIKILINK = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;

const urlForId = (id, base) => `${base || ''}/${id.split('/').map(encodeURIComponent).join('/')}/`;

export const remarkWikilink = ({ index, base = '', strict = false } = {}) => {
  if (!index || typeof index.resolve !== 'function') {
    throw new Error('remarkWikilink requires a document index');
  }

  const prefix = base.replace(/\/$/, '');
  return (tree, file) => {
    const currentRepo = index.repoFromPath(file.path ?? file.history?.[0] ?? '');
    visit(tree, 'text', (node, position, parent) => {
      if (!parent || parent.type === 'link' || !node.value.includes('[[')) return;

      const children = [];
      let last = 0;
      for (const match of node.value.matchAll(WIKILINK)) {
        const start = match.index ?? 0;
        if (start > last) children.push({ type: 'text', value: node.value.slice(last, start) });

        const target = match[1].trim();
        const label = match[2]?.trim();
        const resolved = index.resolve(target, currentRepo);
        const linked = resolved ? index.byId?.get(resolved) : undefined;
        if (!resolved && strict) {
          throw new Error(`broken wikilink: [[${target}]] in ${file.path ?? 'document'}`);
        }
        if (!resolved) {
          file.message(`未解決の wikilink: [[${target}]]`, node);
        }

        const fallback = target.includes('/') ? target : `${currentRepo}/${target}`;
        children.push({
          type: 'link',
          url: urlForId(resolved ?? fallback, prefix),
          data: {
            hProperties: {
              class: resolved ? 'wikilink' : 'wikilink broken',
              ...(resolved ? {} : { 'aria-label': `未解決: ${target}` }),
            },
          },
          children: [{ type: 'text', value: label ?? linked?.title ?? target }],
        });
        last = start + match[0].length;
      }

      if (!children.length) return;
      if (last < node.value.length) children.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(position, 1, ...children);
      return position + children.length;
    });
  };
};
