---
title: ドキュメント間リンクの規約
status: proposed
tags: [documentation, linking]
authors: [ydah]
created: 2026-08-18
updated: 2026-08-18
---

## 決定

本文中の `[[slug]]` と `[[repo/slug|表示テキスト]]` を使い、ビルド時にリンク先を検証します。

同一リポジトリ内を優先し、見つからない場合は `_shared/` を検索します。コードブロック内の記述はリンクとして解釈しません。
