import type { DocMeta } from './docs';

export const buildBacklinks = (docs: DocMeta[]) => {
  const backlinks = new Map<string, DocMeta[]>();
  for (const doc of docs) {
    for (const target of new Set(doc.outgoing)) {
      const sources = backlinks.get(target) ?? [];
      sources.push(doc);
      backlinks.set(target, sources);
    }
  }
  return backlinks;
};

export const backlinksFor = (docs: DocMeta[], id: string) => buildBacklinks(docs).get(id) ?? [];
