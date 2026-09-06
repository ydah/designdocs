---
name: import-design-docs
description: Import one or more existing Design Doc drafts into this repository when the user asks to move and rename them, make a format-only checkpoint commit, then rewrite and publish them. Do not use for routine edits to documents already under src/content/docs.
---

# Import Design Docs

既存の下書きを、このリポジトリのDesign Docとして二段階で取り込み、公開する。

## 事前確認

1. ルートの`AGENTS.md`、指定された下書き、`src/content.config.ts`、同じ対象リポジトリの既存文書を読む。
2. `.idea/rule.md`があれば、公開用リライトの文章ガイドとして読む。ただし`.idea/`内のファイルはコミットしない。
3. `git status --short`で既存変更を確認する。無関係な変更は編集もステージもしない。
4. 対象リポジトリ名、文書タイトル、既存文書との関係を下書きから判断する。判断によって内容が変わる場合だけ利用者へ確認する。

## 第1段階: 原文を取り込む

1. `npm run new-doc -- <repo> "<title>"`を使い、`src/content/docs/<repo>/NNNN-kebab-case.md`を確保する。日本語タイトルから有用なslugを作れない場合は、意味を表す短い英語タイトルを生成時だけ使い、frontmatterの`title`は本来のタイトルへ直す。
2. 下書きを移し、元の場所には残さない。追跡済みファイルは生成した雛形を取り除いてから`git mv`し、無視対象のファイルは移動先の内容を確認してから元ファイルだけを削除する。
3. この段階では意味、判断、数値、コード、API名、設定、引用、出典を変えない。次の機械的な整形だけを行う。
   - 必須frontmatterと、明らかに分かる`description`、`tags`、`related`を設定する。
   - 判断済みと確認できない文書は`status: draft`にする。`accepted`や`decided`を推測しない。
   - `authors`は`[ydah]`とし、`created`と`updated`はpre-commit hookに任せる。
   - 見出し階層、表、箇条書き、コードフェンスの言語名、Markdownリンクだけを修正する。
   - コミットハッシュは、対象リポジトリのコミットページへリンクする。
4. 複数ファイルを同時に依頼された場合は、この段階の1コミットにまとめる。
5. 検証コマンドをすべて実行する。

   ```sh
   npm test
   npm run check
   npm run validate:docs
   npm run build
   ```

6. 対象文書だけをステージし、`Add initial <topic> design document`のようなメッセージでコミットする。複数なら複数形にする。コミットメッセージに`codex`を含めず、`Co-Authored-By`行を付けない。この時点ではpushしない。

## 第2段階: 公開用にリライトする

1. 原文の情報を保ったまま、設計レビューと将来の再検討に必要な構成へ直す。
   - 結論を先に示す。
   - 背景、制約、決定、比較した選択肢、採用しなかった理由、影響範囲を明確に分ける。
   - 現状の事実、提案、未検証事項を区別する。
   - 長文を分割し、重複、会話由来の文言、編集メモ、過剰な強調を削る。
   - 1文書1判断を守り、関連文書はwikilinkと`related`で接続する。
   - リポジトリ、PR、論文、コミットなどの根拠は一次情報へリンクする。
2. 内容を補うために調査する場合は一次情報を優先し、裏取りできない事項を確定表現にしない。
3. レビュー可能な提案になった場合は`status: proposed`へ変更する。採用の事実がなければ`accepted`にはしない。
4. 第1段階と同じ4コマンドを再実行し、生成HTMLでも主要なリンクとコードブロックが正しく表示されることを確認する。
5. 対象文書だけをステージし、`Publish <topic> design proposal`のようなメッセージで2つ目のコミットを作る。コミットログの制約は第1段階と同じとする。

## 公開確認

1. 文書だけの変更ではブランチやPRを作らず、現在の`main`へpushする。利用者がcommitや公開を依頼していない場合は実行しない。
2. `.github/workflows/pages.yml`の対象runを監視し、buildとdeployの成功を確認する。
3. 各公開ページがHTTP 200を返すことを確認する。
4. 作業ツリーが空であることを確認し、2つのコミットへのリンクと公開ページを報告する。

検証失敗、連番の競合、下書きの欠落、既存変更との衝突がある場合は、勝手に回避せず原因を示して止める。
