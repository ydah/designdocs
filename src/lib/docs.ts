import { getCollection, type CollectionEntry } from 'astro:content';
import { extractWikilinks } from './markdown.mjs';
import { resolveTarget } from './doc-index.mjs';

export type DocMeta = {
  id: string;
  repo: string;
  slug: string;
  title: string;
  status: 'draft' | 'proposed' | 'accepted' | 'rejected' | 'superseded';
  tags: string[];
  authors: string[];
  created?: Date;
  updated?: Date;
  decided?: Date;
  supersededBy?: string;
  related: string[];
  outgoing: string[];
  hasH1: boolean;
  entry: CollectionEntry<'docs'>;
};

export const splitId = (id: string) => {
  const [repo, ...rest] = id.split('/');
  return { repo, slug: rest.join('/') };
};

export const docUrl = (doc: Pick<DocMeta, 'id'>, base = '') => {
  const prefix = base.replace(/\/$/, '');
  return `${prefix}/${doc.id.split('/').map(encodeURIComponent).join('/')}/`;
};

export const byUpdated = (a: DocMeta, b: DocMeta) =>
  (b.updated?.getTime() ?? b.created?.getTime() ?? 0) - (a.updated?.getTime() ?? a.created?.getTime() ?? 0)
  || a.title.localeCompare(b.title, 'ja');

export const getDocs = async (): Promise<DocMeta[]> => {
  const entries = await getCollection('docs');
  const ids = new Set(entries.map((entry) => entry.id));
  return entries.map((entry): DocMeta => {
    const { repo, slug } = splitId(entry.id);
    const body = entry.body ?? '';
    const outgoing = extractWikilinks(body)
      .map(({ target }) => resolveTarget(target, repo, ids))
      .filter((target): target is string => Boolean(target));
    const related = entry.data.related
      .map((target) => resolveTarget(target, repo, ids))
      .filter((target): target is string => Boolean(target));
    const supersededBy = entry.data.superseded_by
      ? resolveTarget(entry.data.superseded_by, repo, ids)
      : undefined;

    return {
      id: entry.id,
      repo,
      slug,
      title: entry.data.title,
      status: entry.data.status,
      tags: entry.data.tags,
      authors: entry.data.authors,
      created: entry.data.created,
      updated: entry.data.updated,
      decided: entry.data.decided,
      supersededBy,
      related,
      outgoing: [...new Set([...outgoing, ...related, ...(supersededBy ? [supersededBy] : [])])],
      hasH1: /^#\s+.+$/m.test(body),
      entry,
    };
  });
};

export const getRepoMap = (docs: DocMeta[]) => {
  const repos = new Map<string, DocMeta[]>();
  for (const doc of docs) {
    const list = repos.get(doc.repo) ?? [];
    list.push(doc);
    repos.set(doc.repo, list);
  }
  return repos;
};

export const getTagMap = (docs: DocMeta[]) => {
  const tags = new Map<string, DocMeta[]>();
  for (const doc of docs) {
    for (const tag of doc.tags) {
      const list = tags.get(tag) ?? [];
      list.push(doc);
      tags.set(tag, list);
    }
  }
  return tags;
};
