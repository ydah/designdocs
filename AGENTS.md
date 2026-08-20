# design docs

このリポジトリは、複数の実装リポジトリにまたがる設計判断を Markdown と Git で管理し、静的サイトとして公開する場所。決定事項だけでなく、背景、検討した選択肢、採用しなかった理由、影響範囲を残し、あとから判断の経緯を辿れる状態を保つ。

## 設計ドキュメントの原則

ドキュメントを作成・編集するときは、以下を意識すること。

1. **1ドキュメント1判断** — 複数の独立した判断を一つに詰め込まず、別ドキュメントに分けてリンクする。
2. **判断の理由を残す** — 結論だけでなく、背景、制約、比較した選択肢、採用しなかった理由を書く。
3. **対象リポジトリを明確にする** — ドキュメントは `src/content/docs/<repo>/` に置き、どの実装リポジトリに関する判断かをパスで示す。
4. **決定を上書きしない** — 採用済みの判断を変更するときは新しいドキュメントを作り、古いドキュメントを `superseded` にして履歴を残す。
5. **関連する判断を繋ぐ** — 本文の wikilink と frontmatter の `related` を使い、前提・後続・別リポジトリの判断へ辿れるようにする。
6. **事実と提案を分ける** — 現状調査、決定内容、未解決事項を混同しない。未決定の内容を確定事項として書かない。

完成された一般向け記事やチュートリアルにする必要はない。ただし、設計レビューと将来の再検討に必要な根拠は省略しない。

## 新しいドキュメントを追加する手順

1. 対象リポジトリ名とタイトルを指定して雛形を作る。

   ```sh
   npm run new-doc -- lrama "新しい設計判断のタイトル"
   ```

   対象リポジトリ名は小文字の kebab-case にする。ファイルは `src/content/docs/<repo>/0001-kebab-case.md` の形式で、リポジトリごとに連番が付く。

2. frontmatter と本文を編集する。少なくとも背景、決定、検討した選択肢、採用しなかった理由、影響範囲を書く。該当する内容がない節は削除してよい。

3. 関連する既存ドキュメントを `src/content/docs/` から検索し、必要なら wikilink または `related` で繋ぐ。

4. 以下を実行して検証する。

   ```sh
   npm test
   npm run check
   npm run validate:docs
   npm run build
   ```

5. `src/content/docs/**/*.md` のソースをコミットする。`dist/`、`.astro/`、`public/pagefind/` などの生成物はコミットしない。

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

- `title` は必須。
- `description` は一覧やメタ情報に使う短い要約。
- `status` は `draft`、`proposed`、`accepted`、`rejected`、`superseded` のいずれか。
- `tags` は検索・一覧用の分類。英字は小文字の kebab-case に正規化される。
- `authors` はドキュメントの作成・判断に関わった人の識別子。
- `created` と `updated` は pre-commit hook が管理するため、通常は手で更新しない。
- `decided` は判断が確定した日。`accepted` または `rejected` にしたときに設定する。
- `superseded_by` はこの判断を置き換えた新しいドキュメントへのリンク。
- `related` は関連するドキュメントへのリンクの配列。

## 状態の扱い

基本的な遷移は `draft` → `proposed` → `accepted` / `rejected`。

- `draft` — 作成途中で、レビューに出せる状態ではない。
- `proposed` — 提案としてレビューできる。
- `accepted` — 採用された判断。
- `rejected` — 検討したが採用しなかった判断。却下理由を本文に残す。
- `superseded` — 後続の判断に置き換えられた状態。`superseded_by` を設定する。

採用済みドキュメントの結論を、履歴が分からなくなる形で書き換えない。誤字修正、リンク修正、事実関係の補足は既存ドキュメントに行ってよい。

## ドキュメント間リンク

本文では `[[...]]` 形式の wikilink を使える。

- `[[0002-client-api]]` — 同じリポジトリ内のドキュメントへリンクする。
- `[[billing/0003-transaction-boundaries]]` — 別リポジトリのドキュメントへリンクする。
- `[[billing/0003-transaction-boundaries|トランザクション境界の判断]]` — 表示テキストを指定する。

リポジトリをまたぐリンクは必ず `<repo>/<slug>` を明記する。存在しないリンクは `npm run validate:docs` と本番ビルドでエラーになる。コードブロック、インラインコード、数式内の `[[...]]` はリンクとして解釈されない。

frontmatter の `related` と `superseded_by` も同じ解決規則を使う。同じリポジトリ内は slug のみ、別リポジトリは `<repo>/<slug>` を指定する。

## Markdownで使える表現

- フェンス付きコードブロックには言語名を付ける。
- `mermaid` コードブロックは閲覧時に図として描画される。
- `$$...$$` と `\(...\)` は KaTeX の数式として描画される。
- 長い設計書では、見出しの粒度と順序を揃え、同じ説明を複数の節に重複させない。

## 書き方のトーン

- 日本語で書く。
- 結論を明確にし、具体的な制約、検証結果、コードやパスを優先する。
- 採用しなかった案を感情的に評価せず、その時点の要件とトレードオフに基づいて書く。
- 外部情報を根拠にするときは、公式ドキュメント、仕様、論文、実装などの一次情報を優先し、参考リンクを残す。
- 推測は事実として書かず、未検証または未解決であることを明記する。

## 作成日・更新日

`src/content/docs/**/*.md` をコミットすると、lefthook の pre-commit hook が新規ファイルに `created` と `updated` を追加し、既存ファイルの `updated` を更新する。

- 日付はデフォルトで `Asia/Tokyo` 基準。
- 必要なら `DOC_DATE_TIMEZONE` で変更できる。
- ファイルの mtime ではなく Git 履歴から新規・既存を判定する。
- frontmatter がない場合も hook が日付を補うが、設計ドキュメントには必要な frontmatter を最初から書く。

## 初回セットアップ

Node.js 22.12.0 以上を使う。

```sh
npm install
npm run dev
```

変更確認には以下を使う。

```sh
npm test
npm run check
npm run validate:docs
npm run build
```

## GitHub Pages

公開先は `https://ydah.github.io/designdocs/`。`main` への push で GitHub Actions が検証、ビルド、デプロイを行う。

- `.github/workflows/pages.yml` が GitHub Pages をデプロイする。
- Actions では `PUBLIC_BASE` にリポジトリ名、`SITE_URL` に所有者の GitHub Pages URLを設定する。
- `dist/` と Pagefind の検索インデックスはビルド時に生成されるため、Git にコミットしない。

## 関連ファイル

- `src/content/docs/<repo>/*.md` — 公開する設計ドキュメント
- `src/content.config.ts` — frontmatter のスキーマ
- `src/lib/doc-index.mjs` — ドキュメント ID とリンク解決
- `src/lib/docs.ts` — 一覧、タグ、関連リンク用のデータ処理
- `src/lib/remark-wikilink.mjs` — `[[...]]` wikilink の変換
- `scripts/new-doc.mjs` — 新規ドキュメントの雛形作成
- `scripts/validate-docs.mjs` — リンクとドキュメント構造の検証
- `scripts/update-doc-dates.mjs` — 作成日・更新日の自動付与
- `src/pages/`、`src/layouts/`、`src/components/` — 公開サイト
- `astro.config.mjs` — Astro、Markdown、base path、sitemap の設定
- `.github/workflows/pages.yml` — GitHub Pages のビルドとデプロイ
- `README.md` — セットアップの短い概要
