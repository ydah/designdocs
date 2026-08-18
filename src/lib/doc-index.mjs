import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const DOC_FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const REPO_DIR = /^(?:_shared|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const RESERVED_REPOS = new Set(['og', 'repos', 'tags']);

const walkMarkdownFiles = (root) => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  };
  walk(root);
  return files.sort();
};

const relativeDocPath = (root, filePath) => path.relative(root, filePath).split(path.sep);

const validateRepository = (repo, filePath) => {
  if (!REPO_DIR.test(repo)) {
    throw new Error(`リポジトリディレクトリは kebab-case にしてください: ${filePath}`);
  }
  if (RESERVED_REPOS.has(repo)) {
    throw new Error(`予約済みのリポジトリ名は使えません: ${repo}`);
  }
};

const validateDocumentFile = (root, filePath) => {
  const parts = relativeDocPath(root, filePath);
  const [repo, ...slugParts] = parts;
  if (!repo || slugParts.length !== 1) {
    throw new Error(`ドキュメントは <repo>/<slug>.md の直下に置いてください: ${filePath}`);
  }
  validateRepository(repo, filePath);

  const match = slugParts[0].match(DOC_FILE);
  if (!match) {
    throw new Error(`ファイル名は 0001-kebab-case.md 形式にしてください: ${filePath}`);
  }

  return {
    filePath,
    repo,
    slug: slugParts[0].slice(0, -3),
    number: Number(match[1]),
    id: `${repo}/${slugParts[0].slice(0, -3)}`,
  };
};

export const resolveTarget = (target, currentRepo, ids) => {
  const normalized = String(target).trim().replace(/^\//, '').replace(/\/$/, '');
  if (!normalized) return undefined;
  if (ids.has(normalized)) return normalized;

  const sameRepository = `${currentRepo}/${normalized}`;
  if (ids.has(sameRepository)) return sameRepository;

  const shared = `_shared/${normalized}`;
  return ids.has(shared) ? shared : undefined;
};

export const buildDocIndex = (root, { strictWikilinks = false } = {}) => {
  const records = walkMarkdownFiles(root).map((filePath) => {
    const record = validateDocumentFile(root, filePath);
    const parsed = matter(fs.readFileSync(filePath, 'utf8'));
    return {
      ...record,
      title: String(parsed.data.title ?? record.slug),
      status: String(parsed.data.status ?? 'draft'),
      data: parsed.data,
    };
  });

  const byId = new Map();
  const numberByRepo = new Map();
  for (const record of records) {
    if (byId.has(record.id)) {
      throw new Error(`重複したドキュメント ID: ${record.id}`);
    }
    byId.set(record.id, record);

    const numbers = numberByRepo.get(record.repo) ?? new Map();
    if (numbers.has(record.number)) {
      throw new Error(`連番が重複しています: ${record.repo}/${String(record.number).padStart(4, '0')}`);
    }
    numbers.set(record.number, record.id);
    numberByRepo.set(record.repo, numbers);
  }

  const ids = new Set(byId.keys());
  const resolve = (target, currentRepo) => resolveTarget(target, currentRepo, ids);
  for (const record of records) {
    const related = Array.isArray(record.data.related) ? record.data.related : [];
    for (const target of related) {
      if (!resolve(target, record.repo)) {
        throw new Error(`存在しない related: ${target} (${record.id})`);
      }
    }
    if (record.data.superseded_by && !resolve(record.data.superseded_by, record.repo)) {
      throw new Error(`存在しない superseded_by: ${record.data.superseded_by} (${record.id})`);
    }
  }

  return {
    root,
    records,
    byId,
    ids,
    strictWikilinks,
    resolve,
    repoFromPath: (filePath) => {
      const [repo] = relativeDocPath(root, filePath);
      return repo;
    },
  };
};
