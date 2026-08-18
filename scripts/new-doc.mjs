#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [, , repo, ...titleParts] = process.argv;
const title = titleParts.join(' ').trim();
if (!repo || !title) {
  console.error('使い方: npm run new-doc -- <repo> <title>');
  process.exit(1);
}
if (!/^(?:_shared|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(repo) || ['og', 'repos', 'tags'].includes(repo)) {
  console.error(`リポジトリ名が不正です: ${repo}`);
  process.exit(1);
}

const titleSlug = title
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
;
const directory = path.join(process.cwd(), 'src/content/docs', repo);
fs.mkdirSync(directory, { recursive: true });
const existing = fs.readdirSync(directory).filter((name) => /^\d{4}-.+\.md$/.test(name));
const nextNumber = existing.reduce((max, name) => Math.max(max, Number(name.slice(0, 4))), 0) + 1;
const slug = titleSlug || `decision-${String(nextNumber).padStart(4, '0')}`;
const filename = `${String(nextNumber).padStart(4, '0')}-${slug}.md`;
const filePath = path.join(directory, filename);
if (fs.existsSync(filePath)) {
  console.error(`ファイルが既に存在します: ${filePath}`);
  process.exit(1);
}

const author = process.env.DOC_AUTHOR ?? 'ydah';
const content = `---
title: ${JSON.stringify(title)}
status: draft
tags: []
authors: [${author}]
---

## 背景 / 課題

<!-- なぜ今これを決める必要があるのか。現状の何が困っているのか -->

## 決定

<!-- 何を採用するか。1〜3行で言い切る -->

## 検討した選択肢

### 案A: ...

- 利点:
- 欠点:

### 案B: ...

## 採用しなかった理由

<!-- 将来の自分が「なぜBじゃないのか」と思ったときに読む場所 -->

## 影響範囲

<!-- どのリポジトリ・どのチームに影響するか。移行が必要か -->

## 未解決の論点

## 参考リンク
`;
fs.writeFileSync(filePath, content);
console.log(path.relative(process.cwd(), filePath));
