# design docs

リポジトリをまたぐ設計判断を Markdown と Git で管理し、Astro で静的サイトとして公開するリポジトリです。

## 開発

Node.js 22 以上を用意してから依存関係をインストールします。

```sh
npm install
npm run dev
```

`src/content/docs/<repo>/<slug>.md` にドキュメントを追加すると、`/<repo>/<slug>/` にページが生成されます。ファイル名は `0001-kebab-case.md` 形式、リポジトリ名は kebab-case で付けます。

ドキュメントの設計原則、状態、リンク、更新手順の詳細は [`AGENTS.md`](AGENTS.md) を参照してください。

```sh
npm run new-doc -- my-api-server "PostgreSQL を採用する"
npm run check
npm run validate:docs
npm run build
```

## frontmatter

```yaml
---
title: PostgreSQL を主データストアとして採用する
description: 採用理由、代替案、移行方針をまとめた設計判断
status: accepted
tags: [database, postgres, adr]
authors: [ydah]
created: 2026-08-18
updated: 2026-08-18
decided: 2026-08-20
superseded_by: 0007-move-to-cockroachdb
related: [billing/0003-transaction-boundaries]
---
```

`created` / `updated` は pre-commit hook がコミット日付から自動付与します。`[[slug]]` は同じリポジトリ内、`[[repo/slug|表示テキスト]]` は別リポジトリのドキュメントへリンクします。

## 状態

`draft` → `proposed` → `accepted` / `rejected`、採用済みの判断を覆すときは新しいドキュメントを追加して旧ドキュメントを `superseded` にします。

## デプロイ

`main` への push で GitHub Pages 用の Actions がビルドとデプロイを行います。`SITE_URL` と `PUBLIC_BASE` はデプロイ先に合わせて設定してください。
