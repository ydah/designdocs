---
created: 2026-08-20
title: Lrama に PSLR(1) パーサ生成を導入する
description: 構文的左文脈に応じて字句候補を制約する PSLR(1) パーサ生成の設計と実装評価
status: proposed
tags: [lrama, pslr, parser-generator, lexer, language-composition]
authors: [ydah]
updated: 2026-08-20
---

対象: [ruby/lrama#774 "Add support PSLR(1) parser generation"](https://github.com/ruby/lrama/pull/774)（author: ydah / branch `pslr_parser` / base `1e9294d` / 15 commits / 102 files / +13,397 −545 / **open**）

基準文献: Joel E. Denny, *PSLR(1): Pseudo-Scannerless Minimal LR(1) for the Deterministic Parsing of Composite Languages*, Ph.D. Dissertation, Clemson University, May 2010（以下「論文」。節番号・定義番号はすべて論文のもの）

> 注記: 本書は PR のソースコードと論文の静的読解にもとづく。検証環境に Ruby が無いため RSpec / 生成 C コードのコンパイルは実行していない。「要検証」と記した項目は実機確認が必要。

## 1. 背景と目的

### 1.1 解こうとしている問題

従来のスキャナ・パーサ分離モデルでは、**スキャナが構文的左文脈を知らない**ため、複数の副言語（sub-language）が合成された言語で誤トークン化が起きる。論文の代表例:

```cpp
vector<list<string>> v;   // ここの ">>" は '>' '>' でなければならない
a >> b;                   // ここの ">>" は '>>' でなければならない
```

伝統的スキャナは最長一致で常に `'>>'` を返すため、前者で構文エラーになる。

**pseudo-scanner**（定義 3.1.1）の発想は単純で、スキャナが返す候補を「現在のパーサ状態 `sp` が受理しうるトークン集合 `acc(sp)`」に制限する。すると副言語の遷移が構文的左文脈から自動的に決まる。

- 入力 `ξ`、パーサ状態 `sp` に対し、`M(ξ, acc(sp)) ≠ ∅` ならスキャナは `M(ξ, acc(sp))` から選ぶ

### 1.2 pseudo-scanner が生む新たな課題（＝本実装が解くべきもの）

| # | 課題 | 論文の解 | 節 |
|---|---|---|---|
| 1 | `\|M(ξ, acc(sp))\| > 1`（pseudo-scanner conflict）が残る | `%lex-prec` による字句優先度 + 無解決コンフリクトの**報告** | 3.2 |
| 2 | 予約語/類似演算子は「構文的に受理可能な方」が誤りのことがある | `%lex-tie` で `acc(sp)` を拡張 | 3.3 |
| 3 | LALR/IELR の**状態マージ**が `acc(sp)` を汚し、pseudo-scanner の挙動を壊す | IELR(1) の状態互換性判定を拡張 | 3.4.3 |
| 4 | 構文エラー時、`acc(sp)` 内に一致がないと停止する | `scanner_accepts` に **fallback 行** | 3.5.1 |
| 5 | 状態マージ・default reduction・`%nonassoc` がエラー検出を遅延させる | **LAC**（lookahead correction） | 3.5.2 |
| 6 | 空白・コメントを文法に書きたくない | `YYLAYOUT*` トークン | 3.6 |

### 1.3 Lrama にとっての動機

Ruby の `parse.y` は `lex_state_e`（`EXPR_BEG` / `EXPR_END` / `EXPR_ARG` / `EXPR_CMDARG` …）という手書きのレキサ状態機械でこの問題を解いている。PSLR はこれを**パーサ状態から自動導出**する道を開く。本 PR が論文にない `%lexer-context` を持ち込んでいるのは、この既存資産との橋渡しを意図したもの。

---

## 2. 全体アーキテクチャ

### 2.1 パイプライン

```text
 .y ファイル
    │
    ▼
 Lrama::Lexer / Lrama::Parser (parser.y)
    │  %token-pattern / %token-action / %lex-prec /
    │  %lex-tie / %lex-no-tie / %symbol-set / %lexer-context
    ▼
 Lrama::Grammar
    │  ・token_patterns, lex_prec(宣言), lex_tie(宣言), symbol_sets
    │  ・%define: lr.type=pslr, api.pslr.*, parse.lac, pslr.*
    ▼
 Lrama::States#compute            … LALR(1) 基底テーブル
    │
    ▼
 Lrama::States#compute_pslr       ★本 PR の中核
    ├ Phase 1  predecessors / follow_kernel_items / always_follows / goto_follows
    ├ Phase 2  build_scanner_fsa        → ScannerFSA (Σs)
    │          build_length_precedences → LengthPrecedences
    │          compute_inadequacy_annotations （既存 IELR のまま）
    ├ Phase 3a split_states  ← PSLR 互換性判定を挿入（Pslr::PairwiseResolution）
    ├ Phase 3b split_states_by_context  ← Lrama 独自（%lexer-context 時のみ）
    ├ Phase 4  clear/compute_look_ahead_sets
    ├ Phase 5  compute_conflicts(:ielr) / compute_default_reduction
    │          build_scanner_accepts    → State::ScannerAccepts（+ fallback 行）
    │          handle_pslr_inadequacies
    └ Phase 6  再 classify_lexer_contexts / finalize_pslr_metrics
    │
    ▼
 States#validate!  … 状態増加ガード / scanner conflict / inadequacy /
    │                pure モード網羅性 / useless %lex-prec / tie 候補
    ▼
 Lrama::Context → Lrama::Output → template/bison/yacc.c (ERB)
    │
    ▼
 生成 C: FSA 表, scanner_accepts, length_precedences,
         yy_pseudo_scan_result, LAC, （pure モードなら yylex）
```

### 2.2 ファイル構成と責務

| ファイル | 行数 | 責務 | 論文対応 |
|---|---|---|---|
| `lib/lrama/grammar/token_pattern.rb` | 43 | `%token-pattern` の値オブジェクト。`layout?` 判定 | 3.1, 3.6 |
| `lib/lrama/grammar/token_action.rb` | 33 | `%token-action` の値オブジェクト | 3.6 |
| `lib/lrama/grammar/lex_prec.rb` | 200 | 7 演算子の定義、identity 関係の問い合わせ、useless 追跡 | Def 3.2.3, 3.2.4 |
| `lib/lrama/grammar/lex_tie.rb` | 290 | tie/no-tie の specificity 解決 + union-find による推移閉包 | Def 3.3.1〜3.3.3 |
| `lib/lrama/grammar/lexer_context.rb` | 39 | `%lexer-context`（**論文外**） | — |
| `lib/lrama/scanner_fsa.rb` | 730 | 正規表現サブセット → Thompson NFA → 部分集合構成 DFA。conflict pair 列挙 | Σs, Def 3.2.12 |
| `lib/lrama/length_precedences.rb` | 186 | `length_precedences` 行列（3 値）+ fallback 行列。矛盾宣言の検出 | Def 3.2.15 |
| `lib/lrama/state/scanner_accepts.rb` | 527 | プロファイル解決器、`scanner_accepts` 構築、状態互換性 checker | Def 3.2.14, 3.2.17〜3.2.20, Obs 3.2.18 |
| `lib/lrama/pslr/pairwise_resolution.rb` | 75 | phase 3 用の pair 単位互換性判定 | 3.4.3 の高速化 |
| `lib/lrama/state/pslr_inadequacy.rb` | 79 | PSLR 不適格性の記述と profile 比較 | 3.4.3 |
| `lib/lrama/lexer_context_classifier.rb` | 161 | kernel item からレキサ文脈を推定（**論文外**） | — |
| `lib/lrama/states.rb` | +647 | `compute_pslr` 本体、分割、検証、レポート用 API | 3.4.3 |
| `lib/lrama/output.rb` | +838 | C テーブル・関数の生成、pure/bridge モード | 3.2.6, 3.2.16, 3.5 |
| `lib/lrama/reporter/pslr.rb` | 134 | `--report=pslr` | 3.2.1 |
| `template/bison/yacc.c` | +273 | LAC 組み込み、`YYSETSTATE_CONTEXT`、補助関数 | 3.5.2 |

---

## 3. 外部仕様（文法ディレクティブ）

### 3.1 `%define` キー

| キー | 値 | 既定 | 意味 |
|---|---|---|---|
| `lr.type` | `pslr` | — | PSLR(1) 生成を有効化 |
| `api.pslr.lexer` | `generated` | 未設定 | **pure モード**: 生成パーサが `yylex` を所有 |
| `api.pslr.state-member` | 識別子 | 未設定 | **bridge モード**: パーサ状態を格納する `%parse-param` 構造体メンバ名 |
| `parse.lac` | `full` / `none` | PSLR は `full`、他は `none` | 先読み補正 |
| `pslr.tables` | `ielr`(既定) / `canonical-lr` | `ielr` | 分割の基底アルゴリズム |
| `pslr.max-states` | 整数 | 無制限 | **Lrama 独自**の状態数上限ガード |
| `pslr.max-state-ratio` | 実数 | 無制限 | **Lrama 独自**の状態増加率上限ガード |

### 3.2 字句宣言

```text
%token-pattern [TAG] NAME /regex/ ["alias"] ...
%token-action  NAME { C コード }
%symbol-set    name SYM ...
%lex-prec      A <op> B [<op> C ...]        // 連鎖可
%lex-tie       X Y [Z ...]
%lex-no-tie    X Y [Z ...]
%lexer-context NAME SYM ...                 // Lrama 独自
```

- 論文の `%token-re NAME (regex)` は Lrama では `%token-pattern NAME /regex/` に改名（Lrama のレキサに `REGEX` トークンを追加）
- `yyall` は全トークンを表す組み込みシンボル集合
- `YYLAYOUT` または `YYLAYOUT*` で始まる名前は layout トークン

### 3.3 `%lex-prec` 演算子（論文 Def 3.2.3 / 3.2.4）

演算子は 2 文字で、**1 文字目が identity conflict、2 文字目が length conflict** の解決規則を表す。

| 論文 | Lrama | identity conflict | length conflict | 常に self-consistent (Thm 3.2.11) |
|---|---|---|---|---|
| `<∼` | `<~` | 右トークンが勝つ | 最長一致 | ✅ |
| `<-` | `<-` | 右トークンが勝つ | （指定しない） | ✅ |
| `-∼` | `-~` | （指定しない） | 最長一致 | ✅ |
| `<<` | `<<` | 右トークンが勝つ | 右トークンが勝つ | ✅ |
| `-<` | `-<` | （指定しない） | 右トークンが勝つ | ✅ |
| `<s` | `<s` | 右トークンが勝つ | 最短一致 | ❌（同一トークン時のみ ✅） |
| `-s` | `-s` | （指定しない） | 最短一致 | ❌（同一トークン時のみ ✅） |
| `><` | **未実装** | 左が勝つ | 右が勝つ | ❌（論文も自己矛盾として不採用）|

重要な性質（実装もこれに従う）:

- **推移的ではない**（`A <- B`, `B <- C` から `A <- C` は導かれない）
- 自己 length conflict（autolength conflict）の既定は**最長一致**（Def 3.2.2）
- `-~` と `-s` は operand の順序が無関係（対称）

### 3.4 正規表現サブセット

`ScannerFSA` が受理する構文（`lib/lrama/scanner_fsa.rb`）:

- リテラル、エスケープ `\/ \* \+ \? \( \) \[ \] \\ \{`
- グループ `(...)`、選択 `|`、反復 `* + ?`
- 文字クラス `[a-z]`, `[^*]`, `[\]]`, `[\\]`, `[\n\t\r]`
- `.`（改行を除く任意バイト）
- `\n \t \r`
- `{NAME}` … 既出 `%token-pattern` の本体をインライン展開（自己参照・前方参照はエラー）

**バイト指向**。否定文字クラスと `.` は 0–255 を渡すので UTF-8 多バイト列は素通しになる。Unicode プロパティ、Onigmo 拡張は非対応。**nullable なパターン（`//`, `/a*/`, `/a?/`, `/a|/`）は生成時エラー**（PSLR の lexeme は非空である必要があるため）。

---

## 4. 内部設計: 生成時アルゴリズム

### 4.1 Scanner FSA `Σs` の構築

`ScannerFSA#build_fsa`:

1. 各 `%token-pattern` の正規表現を Thompson 構成で NFA に変換
2. 全 NFA を単一の開始状態から ε 結合
3. 部分集合構成で DFA 化

**論文との一致点（重要）**: 伝統的スキャナ生成器と違い、**受理状態は「受理トークンの集合」を保持したまま**にする（Def 3.2.12 の `acc(ss)`）。identity conflict を宣言順で潰さない。長さ conflict も畳まない。これらの解決はすべて `scanner_accepts` / `length_precedences` に外出しされる。

さらに Lrama は暗黙リテラルトークンパターンを合成する（`Grammar#synthesize_implicit_literal_token_patterns!`）。`'>'` や `"=>"` のような文字リテラル終端に対し、完全一致の正規表現を自動生成する。論文が「引用されたトークンの正規表現は暗黙」と述べる部分に対応。

`ScannerFSA#pairwise_conflict_pairs` は、
- 同一受理状態に複数トークンが同居する対（identity conflict）
- ある受理状態から到達可能な後続受理状態のトークン対（length conflict）

を列挙する。これは 4.5 の状態互換性判定と 4.7 の tie 候補報告の両方で使う。

### 4.2 `acc(sp)` の計算

`States#acceptable_tokens_for_pslr(state, filtered_lookaheads = nil, expand_ties:, include_layout:)`:

```text
acc(sp) = { 終端シフト遷移のシンボル }
        ∪ { reduce の先読み集合 }
        （→ %lex-tie で推移閉包展開）
        ∪ { layout トークン全部 }
```

- 論文 Def 3.3.2（tie 込みの `acc`）+ 3.6（layout は全状態に追加）に対応
- `filtered_lookaheads` を渡すと、分割候補の仮想的な `acc` を評価できる（phase 3 用）
- 重要: **tie されたトークンにパーサアクションは生成しない**（論文 3.5.2 の指摘どおり）。tie は `scanner_accepts` と状態互換性判定にのみ効く

### 4.3 `length_precedences`

`LengthPrecedences` は論文 Def 3.2.15 の boolean 行列を**3 値**に拡張している。

| 値 | 意味 |
|---|---|
| `PREFER_NEW` | より長い `new_token` の一致が、既存の `old_token` の一致を置き換える |
| `PREFER_OLD` | 置き換えない（最短一致側） |
| `UNRESOLVED` | 規則なし |

演算子 → 行列の写像:

| 演算子 | `[left][right]` | `[right][left]` |
|---|---|---|
| `<~`, `-~` | `PREFER_NEW` | `PREFER_NEW` |
| `<s`, `-s` | `PREFER_OLD` | `PREFER_OLD` |
| `<<`, `-<` | `PREFER_NEW` | `PREFER_OLD` |

- 同一トークン（`old == new`）は既定 `PREFER_NEW` = 最長一致（Def 3.2.2）
- `fallback: true` では `UNRESOLVED` を `PREFER_NEW`（最長一致）に落とす → 論文 3.5.1 の「fallback 行では伝統的規則で補完」
- **矛盾する宣言（`A -~ B` と `A -s B` の併記）は `LexicalPrecedenceConflictError` で拒否**。論文には明記のない、Lrama 独自の健全性検査

### 4.4 `scanner_accepts` の構築（プロファイル解決器）

論文 Def 3.2.17〜3.2.20 の実装が `State::ScannerAccepts` にある。

#### 4.4.1 conflict profile（Def 3.2.17）

入力 `ξ` の scanner conflict profile は 3 つ組 `(Ts, ts, Tl)`:

- `Ts`: `ξ` の**真の接頭辞**にマッチするトークン全体
- `ts`: `Ts` の中で最高優先度の一致のトークン（なければ undefined）
- `Tl`: `ξ` 全体にマッチするトークン全体

profile の個数が有限であることが、無限個ありうる complete conflict を有限個に分類できる根拠。

#### 4.4.2 解決規則（Obs 3.2.18 / `ProfileResolver#resolve_normal`）

```ruby
# 1. Tl が空 → 短い側の勝者をそのまま維持
if current_tokens.empty?
  return RESOLVED(selected_shorter_token) if selected_shorter_token
  return EMPTY
end

# 2. ts があり、Tl の全トークンが「ts に長さで負ける」→ ts を維持
if selected_shorter_token && current_tokens.all? { length_prefers_old?(ts, t) }
  return RESOLVED(ts)
end

# 3. Tl の中で identity 勝者かつ Ts 全部に長さで勝つものが一意 → それ
winners = current_tokens.select { |c|
  identity_winner?(c, current_tokens) &&
  shorter_tokens.all? { |s| length_prec.resolution(s, c) == PREFER_NEW }
}
return RESOLVED(winners.first) if winners.size == 1

# 4. それ以外 → UNRESOLVED（報告対象）
```

論文の記述との対応:

| 論文 Obs 3.2.18 | 実装 |
|---|---|
| 1. `ts ≠ undefined ∧ ∀t ∈ Tl, (t-<ts) ∨ (t-s ts)` → `ts` | 手順 2（`PREFER_OLD` 判定が `-<`/`-s` に一致） |
| 2. `∃t_l ∈ Tl : (∀t ∈ Tl, t<-t_l) ∧ (∀t ∈ Ts, (t-<t_l) ∨ (t-~ t_l))` | 手順 3（`PREFER_NEW` 判定が `-<`/`-~` に一致） |
| 3. それ以外は unresolved | 手順 4 |

**実装が論文より厳格な点**: 論文は「そのような `t_l` を選ぶ」としか書かないが、実装は `winners.size == 1` を要求する。identity 関係に循環（`A <- B` と `B <- A`）があれば unresolved になる。安全側で妥当。

#### 4.4.3 探索（Def 3.2.19 / 3.2.20 / `CompleteProfileComputer`）

FSA を開始状態から深さ優先で辿り、各遷移先で profile を求めて解決する。

```ruby
def visit_state(fsa_state_id, shorter_tokens, selected_shorter_token, visited, path)
  current_tokens = current_acceptable_tokens(fsa_state)   # acc(sp, ss)
  key = [fsa_state_id, shorter_tokens.sort, selected_shorter_token, current_tokens.sort]
  return if visited.include?(key)                          # 論文の profile_map
  visited << key

  result = @resolver.resolve(shorter_tokens, selected_shorter_token, current_tokens)
  # resolved なら @table[fsa_state_id] に記録、unresolved なら @conflicts に記録
  # ...
  visit_transitions(fsa_state_id, shorter_tokens | current_tokens,
                    result.resolved? ? result.token_name : nil, visited, path)
end
```

- `visited` キーが論文の `profile_map[(Ts, ts, Tl)] ∋ s'_s` に相当し、**停止性**と**無限ループ回避**を保証する
- `path` は Lrama 独自の追加で、コンフリクト報告時に**再現入力（witness）**を添えられるようにしている

#### 4.4.4 fallback 行（論文 3.5.1）

`compute_fallback_row` は `acceptable_tokens` に「生成 FSA が知る全トークン」を与え、`fallback: true` で解決する。段階的に緩める:

1. 明示的 `%lex-prec` を適用
2. 長さ conflict は最長一致で補完（`fallback_precedes?`）
3. identity conflict は**トークン宣言順**で補完
4. なお決まらなければ短い側の勝者を採用

これにより `M(ξ, T0) ≠ ∅` である限り必ず何か返る。返らない場合はランタイムが 1 バイト消費して `YYUNDEF` を返す（論文の character token）。

### 4.5 IELR(1) 拡張: 状態互換性判定（論文 3.4.3）

論文の定義（Def 3.4.3、Thm 3.4.2 で簡約済み）:

> `sp` と `s'p` が互換 ⟺ `∀ξ`: `M(ξ,acc(sp)) = ∅ ∨ M(ξ,acc(s'p)) = ∅` または `∆(M(ξ,acc(sp))) = ∆(M(ξ,acc(s'p)))`

論文はこれを毎マージ判定で評価すると遅すぎるとし、**pairwise レベルに落とす**ことを推奨する（FSA を 1 回走査して全トークン対の解決を要約しておく）。

Lrama の実装（`Pslr::PairwiseResolution`）:

```ruby
def compatible_accept_sets?(left_acc, right_acc)
  return true if left_acc == right_acc
  diff = (left_acc - right_acc) | (right_acc - left_acc)
  return true if diff.empty?
  # diff に触れる conflict pair だけを検査
  diff.all? { |t| @pairs_by_token[t].all? { |pair| pair_compatible?(pair, left_acc, right_acc) } }
end

def pair_compatible?(pair, left_acc, right_acc)
  l = presence(pair, left_acc)   # bit0=pair[0]を含む, bit1=pair[1]を含む
  r = presence(pair, right_acc)
  l == r || l == 0 || r == 0
end
```

これが**論文の pairwise 化と厳密には一致しない**（→ [6.3](#63-アルゴリズム上の実質的な差分)）。論文は「その対の**解決結果**が同一か」を見るのに対し、Lrama は「その対の**在/不在**が同一か」を見る。

呼び出しは `States#compatible_split_state?` から。この判定は `@pslr_split_enabled` が真の phase 3a でのみ効く。また PSLR パスでは `propagate_lookaheads_without_filter` を使い、IELR の `lookahead_set_filters` による絞り込みを**バイパス**して `acc` を計算する。

`%define pslr.tables canonical-lr` を指定すると `canonical_lookaheads_match?` に切り替わり、kernel の先読み集合が完全一致するときだけマージする（論文 3.4.3 末尾の「コンフリクト報告のデバッグのために canonical LR(1) に切り替えるオプション」に相当）。

### 4.6 layout トークン（論文 3.6）

- `YYLAYOUT` 前置の名前を layout として識別（`TokenPattern#layout?`）
- `acc(sp)` に無条件で加算 → 全パーサ状態で認識される
- ランタイムは layout を**パーサに返さず破棄して再スキャン**
- pure モードでは layout の字句列を蓄積し、次の非 layout トークンの `%token-action` から `YYPSLR_LAYOUT_TEXT` で参照できる

論文が述べる「layout は always contribution なので IELR phase 2 の注釈が不要」という最適化については、`PairwiseResolution` が「layout は全 accept 集合に含まれる → 対称差に現れない → 対を区別しない」という形で自然に成立している（コメントで明記あり）。

### 4.7 検証とレポート（論文 3.2.1 の指導原理）

論文の中心的主張は「**スキャナのコンフリクトを黙って解決するな、報告せよ**」。実装は `States#validate!` から:

| 検査 | 深刻度 | 論文対応 |
|---|---|---|
| `validate_pslr_state_growth!` | error | **論文外**（Lrama 独自ガード） |
| `validate_pslr_scanner_conflicts!` | error | 3.2.1「未解決 complete conflict を全部報告」 |
| `validate_pslr_inadequacies!` | error | 3.4.3 |
| `validate_pslr_pure_coverage!` | error | **論文外**（pure モード必須条件） |
| `validate_pslr_useless_lex_prec!` | warning | 3.2.1「useless な `%lex-prec` を報告」 |
| `validate_pslr_lexical_tie_candidates!` | warning | Def 3.3.3 |

`--report=pslr` はさらに、分割メトリクス、状態ごとの `acc(sp)`、`scanner_accepts` 行、witness 付きコンフリクト、useless 規則、tie 候補を出力する。

---

## 5. 内部設計: ランタイム（生成 C コード）

### 5.1 生成テーブル

| テーブル | 型 | 大きさ | 論文 |
|---|---|---|---|
| `yy_scanner_transition` | `int[N_fsa][256]` | FSA 状態数 × 256 | Σs |
| `yy_state_to_accepting` | `int[N_fsa]` | FSA 状態数 | Def 3.2.13 |
| `yy_scanner_accepts` | `int[N_parser][N_accepting]` | パーサ状態 × 受理状態 | Def 3.2.14 |
| `yy_scanner_fallback_accepts` | `int[N_accepting]` | 受理状態 | 3.5.1 fallback 行 |
| `yy_pslr_length_precedes` | `int[N_pat][N_pat]` | パターン数² | Def 3.2.15 |
| `yy_pslr_fallback_length_precedes` | `int[N_pat][N_pat]` | パターン数² | 3.5.1 |
| `yy_token_pattern_to_token_id` | `int[N_pat]` | パターン数 | — |
| `yy_token_pattern_is_layout` | `int[N_pat]` | パターン数 | 3.6 |

`yy_state_to_accepting` による列圧縮（Def 3.2.13）は実装済み。

### 5.2 `yy_pseudo_scan_result`（論文 Def 3.2.16 + 3.5.1）

```c
int yy_pseudo_scan_result(int parser_state, const char *input,
                          size_t input_len, yypslr_scan_result *result);
```

論文の擬似コードとの対応:

| 論文 Def 3.2.16 | 生成 C |
|---|---|
| `if (\|ξ\| = 0) return #` | `if (input_len == 0) { result->token = YYEOF; ... }` |
| `for i = 1 .. \|ξ\| ∧ ∃δ(...)` | `while (i < input_len)` + `YY_SCANNER_INVALID_STATE` で break |
| `sa = state_to_accepting_state[ss]` | `int sa = yy_state_to_accepting[ss];` |
| `t = scanner_accepts[sp][sa]` | `yy_scanner_accepts[parser_state][sa]` |
| `if (t ≠ undef ∧ (tbest = undef ∨ length_precedences[tbest][t]))` | `if (pbest == EMPTY \|\| yy_pslr_length_precedes[pbest][pattern_index])` |
| `return tbest` | `result->token = yy_token_pattern_to_token_id[pbest]` |

拡張（論文 3.5.1）: 同一ループで fallback 行も並行に走査し、通常行が空なら fallback の結果を `from_fallback = 1` 付きで返す。どちらも空なら **1 バイト消費して `YYUNDEF`**（character token）。

`yypslr_scan_result` は `{token, length, is_layout, is_character_token, from_fallback}` を返す構造体で、長さ指定 API（`input` + `input_len`）なので NUL バイトを含む入力も扱える。

### 5.3 動作モード

#### pure モード（`%define api.pslr.lexer generated`）

生成パーサが `yylex` を持ち、字句解析を完全に所有する。

- 呼び出し側は `yypslr_set_input(input, len)` で入力を渡してから `yyparse()`
- `yypslr_scan_with_layout` が layout を飛ばしつつテキストを蓄積
- `%token-action` が `yytext` / `yyleng` / `yylval` / `YYPSLR_LAYOUT_TEXT` から意味値を構築
- **全終端に `%token-pattern` が必須**（`validate_pslr_pure_coverage!`）

論文のモデルに最も近い。

#### bridge モード（`%define api.pslr.state-member`）

既存の手書き `yylex` がマクロ経由で pseudo-scanner に問い合わせる。

```c
YYPSLR_PSEUDO_SCAN(Context, Input, InputLen, MatchLength)
YYPSLR_PSEUDO_SCAN_RESULT(Context, Input, InputLen, Result)
YYPSLR_TOKEN_IS_LAYOUT(Token)
```

パーサ状態は `YYSETSTATE_CONTEXT` / `YYPSLR_SET_PARSER_STATE` で `%parse-param` 構造体のメンバに書き戻される。`%token-pattern` を持たない終端はユーザレキサの担当のまま（警告が出る）。

NEWS が正直に述べているとおり、**このモードは「まだ消費していない入力の接頭辞」をレキサが渡す必要がある**ため、既に切り出したトークン片しか渡せない従来型ブリッジでは効果が限定される。

### 5.4 LAC（論文 3.5.2）

`%define parse.lac full`（PSLR は既定で有効、LALR/IELR にも開放）。

`yy_lac_check_(yyss, yyssp, yytoken)` がパーサスタックのコピー上で**意味アクションを実行しない探索的パース**を行い、
- 先読みが構文的に受理可能か判定 → 遅延エラー検出を解消
- エラー時は全トークンについて探索して**正しい期待トークン一覧**を構築（`yypcontext_expected_tokens`）

これにより、論文が指摘する「状態マージ・default reduction・`%nonassoc` によるエラー検出遅延と誤った期待トークン列挙」が解消され、IELR + LAC が canonical LR(1) と同じアクション列を保証する。

### 5.5 補助関数（論文外・Lrama 独自）

`yy_state_accepts_token` / `yy_state_eventually_accepts_token` / `yy_state_deep_accepts_token` の 3 つ。ユーザレキサから「この状態でこのトークンは受理されるか」を問い合わせるための、空 reduce / default reduce を追跡するヘルパ。Ruby の `parse.y` 統合を見据えたものと思われる。

---

## 6. 論文との差分

### 6.1 実装済み対応表

| 論文の要素 | 節/定義 | Lrama | 状態 |
|---|---|---|---|
| pseudo-scanner の基本挙動 | Def 3.1.1 | `acc(sp)` 制約 + `yy_pseudo_scan_result` | ✅ |
| `%token-re` | 3.1 | `%token-pattern`（改名） | ✅ |
| 引用リテラルの暗黙正規表現 | 3.1 | `synthesize_implicit_literal_token_patterns!` | ✅ |
| autolength の既定＝最長一致 | Def 3.2.2 | `resolution(t, t) == PREFER_NEW` | ✅ |
| 伝統的演算子 `<~ <- -~` | Def 3.2.3 | 実装 | ✅ |
| 非伝統的演算子 `<< -< <s -s` | Def 3.2.4 | 実装 | ✅ |
| `><` を採用しない | 3.2.5 | 未実装（論文と同じ判断） | ✅ |
| 字句優先度関数 `∆` | Def 3.2.5 | `ProfileResolver` | ✅ |
| 非推移性 | 3.2.1 | `identity_precedes?` は直接規則のみ | ✅ |
| `acc(ss)`, `acc(sp,ss)` | Def 3.2.12 | `ScannerFSA#acc_ss` / `current_acceptable_tokens` | ✅ |
| `state_to_accepting_state` | Def 3.2.13 | `yy_state_to_accepting` | ✅ |
| `scanner_accepts` | Def 3.2.14 | `State::ScannerAccepts` | ✅ |
| `length_precedences` | Def 3.2.15 | `LengthPrecedences`（3 値に拡張） | ✅ |
| `pseudo_scan` | Def 3.2.16 | `yy_pseudo_scan_result` | ✅ |
| conflict profile | Def 3.2.17 | `(shorter_tokens, selected, current_tokens)` | ✅ |
| profile 単位の解決 | Obs 3.2.18 | `resolve_normal` | ✅ |
| `compute_scanner_accepts` / `resolve` | Def 3.2.19/3.2.20 | `CompleteProfileComputer` | ⚠️ 報告粒度が異なる |
| useless `%lex-prec` の報告 | 3.2.1 | `LexPrec#useless_rules` + 警告 | ✅ |
| `ties(t)` の反射・対称・推移 | Def 3.3.1 | union-find | ✅ |
| tie 込みの `acc(sp)` | Def 3.3.2 | `expand_lexical_ties` | ✅ |
| symbol-set 絡みは conflict 対のみ tie | 3.3 | `declaration_pairs` の `specificity < 3` 分岐 | ✅ |
| token 同士は無条件 tie | 3.3 | `specificity == 3` | ✅ |
| lexical tie candidate 報告 | Def 3.3.3 | `collect_lexical_tie_candidates` | ✅ |
| `%lex-no-tie yyall yyall` と個別上書き | 3.3 | specificity 0/1/2/3 | ✅ |
| tie 済みへの no-tie 宣言を拒否 | 3.3 | `rebuild_relations` で例外 | ✅ |
| 状態互換性判定 | Def 3.4.1/3.4.3 | `PairwiseResolution` | ⚠️ 近似（6.3 参照） |
| merge-stable 性の利用 | Thm 3.4.2 | 前提として `∆` の合流を評価しない | ✅ |
| 未解決同士はマージする | 3.4.3 | presence 一致で許容 | ✅ |
| canonical LR(1) 切替オプション | 3.4.3 | `%define pslr.tables canonical-lr` | ⚠️ 近似 |
| fallback 行 | 3.5.1 | `compute_fallback_row` | ✅ |
| fallback は伝統規則で補完 | 3.5.1 | 最長一致 + 宣言順 | ✅ |
| character token | 3.5.1 | 1 バイト消費 + `YYUNDEF` | ✅ |
| LAC | 3.5.2 | `yy_lac_check_` | ✅ |
| tie 済みトークンにアクションを作らない | 3.5.2 | tie は `acc` にのみ影響 | ✅ |
| layout トークン | 3.6 | `YYLAYOUT*` | ✅ |
| layout の再スキャン | 3.6 | `yypslr_scan_with_layout` | ✅ |
| layout テキストの蓄積と次アクションでの参照 | 3.6 | `YYPSLR_LAYOUT_TEXT` | ⚠️ pure モードのみ |
| layout の split-stable 最適化 | 3.6 | presence 判定で自然に成立 | ✅ |
| `%token-action`（個別） | 3.6 | 実装 | ✅ |

### 6.2 未実装（論文でも future work のもの）

| 要素 | 論文の位置づけ | Lrama |
|---|---|---|
| 非対称 lexical tie（`%lex-tie ID -> non-reserved`） | 3.3 future work | ❌ |
| 型/タグ単位の一括 `%token-action` | 3.6 で「実装済み」と記述 | ❌ **論文は実装済みと述べている点に注意** |
| layout 値の任意型化（lexeme 以外の蓄積） | 3.6 future work | ❌ |
| lexical nonterminal / `%lex` / lexical parser | 3.6 future work | ❌（NEWS に明記） |
| scoped declarations（namespace 方式） | 3.7 future work | ❌ |
| scoped declarations（副言語開始記号方式） | 3.7 future work | ❌ |
| scope ごとの複数 fallback 行 | 3.7 future work | ❌ |

> `state/scanner_accepts.rb` の冒頭コメントに `%lex-scope` への言及があるが、対応する実装・ディレクティブは存在しない。**書きかけのコメントが残っている**（要削除）。

### 6.3 アルゴリズム上の実質的な差分

ここが本設計書でもっとも重要な部分。

#### (A) IELR phase 2 の PSLR 拡張が無い

論文 3.4.3 冒頭:

> We extend IELR(1) for PSLR(1) in two steps. **First, we extend IELR(1) phase 2 to annotate parser states based on their contributions to pseudo-scanner conflicts.** Second, we extend IELR(1) phase 3 by adjusting its state compatibility test to consider these extended annotations.

Lrama は**第 2 段階しか実装していない**。`compute_pslr` は既存の `compute_inadequacy_annotations`（LR(1) 相対の不適格性のみ）を呼び、pseudo-scanner conflict への寄与に基づく注釈は作らない。代わりに phase 3 で `propagate_lookaheads_without_filter` を使い、**フィルタなしの先読みから直接 `acc` を組み立てて比較**する。

帰結:

- IELR の「コンフリクトに寄与する先読みだけを見る」という枝刈りが PSLR パスでは効かない
- 先読み集合のどんな差異も `acc` の差異として現れうる → **過剰分割**
- `pslr.max-states` / `pslr.max-state-ratio` という論文にないガードが必要になっているのは、この帰結の裏返しと読める

#### (B) 状態互換性判定が「解決結果」ではなく「トークンの在/不在」

論文 3.4.3:

> if `R` selects **the same highest precedence match** for every pairwise pseudo-scanner conflict in `sp` as in `s'p`, then it is guaranteed to select the same highest precedence match for every complete pseudo-scanner conflict

Lrama の `pair_compatible?` は解決結果を一切参照せず、`presence` の一致だけを見る。

具体例で差が出る:

```text
%token-pattern RANGLE />/
%token-pattern RSHIFT />>/
%lex-prec RSHIFT << RANGLE      // RANGLE が identity/length 双方で必ず勝つ
```

- 状態 A: `acc = {RANGLE}` → `presence = 1`
- 状態 B: `acc = {RANGLE, RSHIFT}` → `presence = 3`

論文の判定: 任意の `ξ` について `∆(M(ξ,{RANGLE}))` も `∆(M(ξ,{RANGLE,RSHIFT}))` も常に RANGLE の一致 → **互換 → マージ可**

Lrama の判定: `1 ≠ 3` かつどちらも `0` でない → **非互換 → 分割**

`<<` / `-<` は論文 3.7 が「非伝統的演算子の最大の力は、似た字句を持つ他トークンのためにあるトークンを無効化できること」と述べる、まさに主力の用途である。そこで過剰分割が起きるのは設計上の弱点。

なお `presence` が `1` vs `2`（片方だけ別のトークン）のケースでは論文と一致して非互換になるので、**健全性（unsound になる）ではなく完全性（必要以上に分割する）の問題**である点は補足しておく。

#### (C) コンフリクト報告の粒度

論文 Def 3.2.20 の 15 行目:

```text
else if (entry = ∅) do:
    report_conflict(sp, s'_s, Ts, ts, Tl)
```

`profile_map[profile]` が空のときだけ報告する ＝ **profile ごとに 1 件**。

Lrama の `visited` キーは `[fsa_state_id, shorter, selected, current]` であり、同一 profile が別の FSA 状態で現れると別件として報告される。報告は有限に収まるが、論文が意図した「包括的かつ有限な報告」より冗長になる。

#### (D) shorter-wins 時に `scanner_accepts` セルへ書き込む

論文 Def 3.2.20 では、`t_l = ts`（短い側が勝つ）の枝では `scanner_accepts` に**書き込まない**。書き込むのは 14 行目、`Tl` から勝者を選んだ枝だけ。これにより論文は「各セルに入りうるトークンは 1 つだけで、一度書いたら変わらない」という不変条件を得ている。

Lrama は shorter-wins でも `current_tokens.include?(result.token_name)` なら書き込むため、この不変条件を破る。破ると `existing.name != token_pattern.name` の分岐に落ち、**論文なら報告しないコンフリクトが報告されうる**。

- 発生条件は限定的（`%lex-prec X -s X` があり、かつ同じ FSA 状態で別トークンが identity 勝者になる経路が存在する）
- ランタイム挙動自体は `length_precedences` が正しく最短一致を保つため壊れない
- **要検証**: 実文法で再現するかは未確認

#### (E) `pslr.tables canonical-lr` は真の canonical LR ではない

`canonical_lookaheads_match?` は「kernel の先読み集合が完全一致するときだけ既存 isocore にマージ」する近似であり、canonical LR(1) の item set 構成をやり直すわけではない。デバッグ目的（コンフリクト報告が文脈をまたいでマージされるのを防ぐ）には十分だが、名前から期待される厳密性はない。

#### (F) fallback 行の `T0` が論文の `T'` より狭い

論文 3.5.1 は fallback 行を「文法の全終端 `T'`」で計算する。Lrama は「生成 FSA が知る終端」＝ `%token-pattern` を持つもの + 暗黙リテラル合成できたものに限る。bridge モードでユーザレキサが担当する終端は fallback からも漏れる。**NEWS に明記済み**であり意図的な制限。

### 6.4 Lrama 独自の拡張（論文になし）

| 機能 | 目的 | 評価 |
|---|---|---|
| `%lexer-context` + 文脈ベース分割 | Ruby `parse.y` の `lex_state_e` との橋渡し | 意欲的だが論文の枠外。設計根拠の文書化が薄い |
| `pslr.max-states` / `max-state-ratio` | 状態爆発の安全弁 | 実用的。ただし 6.3(A)(B) の過剰分割の対症療法でもある |
| pure モード | 生成パーサが字句解析を所有 | 論文の思想に最も忠実。良い追加 |
| conflict witness（再現入力） | コンフリクト報告の実用性 | 論文にない優れた改善 |
| 矛盾する `%lex-prec` の拒否 | `-~` と `-s` の併記など | 論文にない健全性検査。良い |
| 自己ペアへの identity 演算子の拒否 | `%lex-prec A <- A` など | 同上 |
| `%define parse.lac` を LALR/IELR にも開放 | 論文 3.5.2 も「PSLR と直交」と述べる | 妥当 |
| nullable パターンの拒否 | PSLR の lexeme は非空 | 論文には明記なし。正しい |
| `yy_state_*_accepts_token` | bridge モード用ヘルパ | → 7.2 に重大な問題あり |

---

## 7. 実装評価

### 7.1 評価できる点

1. **論文の骨格を忠実に再現している**。conflict profile による有限分類、`scanner_accepts` / `length_precedences` / `state_to_accepting_state` の 3 表構成、`pseudo_scan` の擬似コードとの逐語的な対応まで、主要な定義がコード上で追跡できる。コメントに定義番号が入っているのも良い。

2. **論文の指導原理（3.2.1）を守っている**。通常行のコンフリクトを宣言順で黙って解決せず error にする、useless `%lex-prec` を報告する、tie 候補を報告する — この 3 点は PSLR の思想の核であり、実装が妥協していない。

3. **論文にない健全性検査を足している**。矛盾 `%lex-prec` の拒否、自己ペア演算子の検証、nullable パターンの拒否、witness 付きコンフリクト報告。いずれも実用上価値がある。

4. **実験的機能として適切に隔離されている**。`%define lr.type pslr` が opt-in で、既定経路は無変更。NEWS が制限事項を正直に列挙している。

5. **テストが厚い**。integration fixture 11 セット（template argument lists、layout/comment、keyword context、shift chain、implicit literal、token action、pure、fallback precedence 等）+ unit spec 多数 + regression/family spec。RBS 署名も追随している。

### 7.2 修正すべき問題

#### 🔴 P1: `yy_state_*_accepts_token` が全パーサに無条件出力される

`template/bison/yacc.c` で、この 3 関数は `<%- if output.pslr_enabled? -%>` ガードの**外**にある。つまり Lrama が生成する**すべての**パーサに、`static` でない外部リンケージのシンボルとして混入する。

- 既存利用者（Ruby の `parse.y` 含む）の名前空間を汚染する
- 1 バイナリに複数パーサをリンクすると**多重定義エラー**
- 未使用関数警告

→ `pslr_enabled?` ガード内に移し、`static` を付けるべき。

#### 🔴 P1: `yy_state_deep_accepts_token` の型パニング

```c
typedef short yy_state_t_compat;
const yy_state_t_compat *stack_base = (const yy_state_t_compat *)stack_base_v;
```

しかし `yy_state_t` は `typedef <%= output.int_type_for([output.yynstates - 1]) %>` であり、状態数 128 未満の文法では **`yytype_int8`（1 バイト）**になる。1 バイト配列を `short*` で読むのは未定義動作で、返る状態番号がでたらめになる。

→ `void*` 経由をやめて `yy_state_t*` を直接受けるか、テンプレート変数で正しい型を埋め込む。

#### 🟠 P2: LAC が呼び出しごとに `YYMALLOC`

`yy_lac_check_` は毎回 `YYMAXDEPTH * sizeof(yy_state_t)`（既定 10,000 要素）を確保して解放する。Bison 本家の LAC は `yyesa` / `yyes` の再利用バッファを持つ。

- 通常パースでも「default reduction 単独でない状態」ごとに 1 回
- エラー時は**期待トークン列挙で全終端分**（`YYNTOKENS` 回）

Ruby の `parse.y` 規模で常時 LAC を有効にすると無視できないコストになる。また `malloc` 失敗時に `return 1`（受理扱い）へフォールバックするのは、期待トークン一覧に誤りを混ぜる。

→ パーサごとの再利用バッファ化、および `yyss` と同じ拡張ロジックへの追随。

#### 🟠 P2: 生成テーブルが非圧縮かつ全部 `int`

- `yy_scanner_transition[N_fsa][256]` を `int` で持つ。FSA 状態 2,000・4 バイトなら 2 MB
- `yy_scanner_accepts[N_parser][N_accepting]` も `int` の密行列
- `yy_pslr_length_precedes` と fallback 版で `int[N_pat][N_pat]` が 2 枚

Lrama/Bison が `yytable` 等で行っている `yytype_int8` 選択・行圧縮が PSLR 表には適用されていない。論文が `state_to_accepting_state` をわざわざ定義した理由（表の縮小）を考えると、列圧縮だけでは不十分。

→ 最小整数型の選択、`length_precedes` の bitset 化、遷移表の行共有・default 遷移導入。

#### 🟠 P2: `merge_lookaheads` のバグ修正が PSLR PR に混入

```ruby
-  state.item_lookahead_set = state.item_lookahead_set.merge {|_, v1, v2| v1 | v2 }
+  state.item_lookahead_set = state.item_lookahead_set.merge(filtered_lookaheads) {|_, v1, v2| v1 | v2 }
```

引数なしの `Hash#merge` はブロックが呼ばれず実質 no-op なので、これは**既存 IELR の明確なバグ修正**であり PSLR とは独立。`state.rb` の `nil` ガード追加（`compact` / `&.`）も同様。

→ 別 PR に切り出すべき。IELR 利用者に影響する挙動変更が 13k 行の実験的機能に埋もれるのは危険。同じ理由で、`Command#call` における `validate!` の呼び出し位置の変更（レポート・出力より**前**に移動）も、失敗時に部分出力が生成されなくなる挙動変更であり、切り分けたい。

#### 🟡 P3: 過剰分割（6.3 (A)(B)）

設計上の近似に起因する。論文の pairwise 化（対ごとの解決結果を事前計算して比較）に寄せるだけで、`<<` / `-<` 使用時の不要分割はかなり減るはず。IELR phase 2 の PSLR 注釈は工数が大きいので、まず (B) の是正を推奨。

#### 🟡 P3: `%lexer-context` 分割の状態共有

`create_context_split_state` が
```ruby
new_state.item_lookahead_set = original.item_lookahead_set
new_state.pslr_item_lookahead_set = original.pslr_item_lookahead_set
```
と**同一オブジェクトを参照共有**している。後段の `merge_lookaheads` が破壊的に置換するのでハッシュ自体は差し替わるが、共有中に読まれる経路が無いかは要確認。直後の phase 4 で `clear_look_ahead_sets` → `compute_look_ahead_sets` が走るため実害は限定的と思われるが、`dup` するのが安全。

#### 🟡 P3: 性能上の細かい懸念

- `LexPrec#identity_precedes?` が規則配列の線形走査。profile 解決の内側ループから呼ばれる → 規則数 × プロファイル数。ハッシュ索引化すべき（useless 追跡のために index が要るなら `Hash[[winner,loser]] => rule_index` で足りる）
- `ScannerFSA#pairwise_conflict_pairs` がメモ化されておらず、呼ぶたびに全状態 DFS。主要経路では 3 回程度だが `pairwise_conflict?` 経由だと危険

#### 🟡 P3: レポートの規模

`Reporter::Pslr#report_acceptable_tokens` / `report_scanner_accepts` が全パーサ状態を列挙する。Ruby の `parse.y` 規模（数千状態）では出力が実用外になる。状態範囲指定か閾値が要る。

#### 🟢 P4: 細かい指摘

- `state/scanner_accepts.rb` 冒頭の `%lex-scope` 言及は未実装機能への参照。削除
- `scanner_accepts_table_code` は `@context.states.states` 全体で行を出すが、構築は `reachable_parser_states` のみ。到達不能状態の行が全 `-1` で埋まる（無害だが表サイズの無駄）
- `yy_pslr_token_is_layout` がパターン配列の線形探索。トークン ID 索引の表にできる
- pure モードの layout バッファが 4 KB 固定（`YYPSLR_LAYOUT_BUFFER_SIZE`）で、溢れると黙って切り捨てる。少なくとも切り捨ての検知手段が要る

### 7.3 テストカバレッジの評価

| 論文の要素 | fixture / spec | 評価 |
|---|---|---|
| `>` vs `>>`（論文の主題例） | `pslr_template_argument_lists.{y,l}` | ✅ |
| layout / コメント | `pslr_layout_comment.{y,l}` | ✅ |
| 予約語 vs 識別子（tie） | `pslr_keyword_context.{y,l}` | ✅ |
| fallback 行 | `pslr_fallback_precedence.{y,l}` | ✅ |
| pure モード | `pslr_pure.y` | ✅ |
| `%token-action` | `pslr_token_action.y` | ✅ |
| 暗黙リテラルパターン | `pslr_implicit_literal.{y,l}` | ✅ |
| 状態増加ガード | `pslr_growth_limit.y` | ✅ |
| プロファイル解決器 | `state/scanner_accepts_spec.rb`(442行) | ✅ |
| FSA / 正規表現サブセット | `scanner_fsa_spec.rb`(364行) | ✅ |
| pairwise 互換性 | `pslr/pairwise_resolution_spec.rb`(49行) | ⚠️ 薄い |
| 論文の Fig 3.3/3.4/3.5（曖昧性の 3 例） | — | ❌ **未網羅** |
| Fig 3.2c/3.2d（C 複数行コメントの `-s`） | 部分的 | ⚠️ |
| Table 3.2（`><` の自己矛盾） | — | ❌（未実装なので妥当） |
| 大規模実文法（C99 / SQL / Ruby parse.y） | — | ❌ **未検証** |

論文 4 章は Bison 自身・Levine SQL・ISO C99・C++ template argument list の 4 ケーススタディで、状態数増加と可読性を定量評価している。**Lrama 側に同等の規模検証がない**のが最大のギャップ。特に 6.3 (A)(B) の過剰分割は小さな fixture では露見しないため、実文法での状態数計測が必須。

### 7.4 総合評価

| 観点 | 評価 |
|---|---|
| 論文への忠実度（コア） | **A−**。3.1〜3.3、3.5、3.6 はほぼ完全 |
| 論文への忠実度（3.4.3 IELR 拡張） | **C**。phase 2 拡張が無く、phase 3 も近似 |
| 未実装機能の妥当性 | **A**。未実装は論文でも future work（1 点例外あり: 型単位 `%token-action`） |
| コード品質（Ruby 側） | **B+**。構造は明快、RBS 追随、命名が論文に対応 |
| コード品質（生成 C 側） | **C**。無条件出力・型パニング・非圧縮テーブル・LAC の malloc |
| テスト | **B−**。ユニットは厚いが大規模検証と論文の曖昧性例が欠落 |
| PR としての衛生 | **C**。無関係な IELR バグ修正と挙動変更が混在、102 ファイル |

**結論**: PSLR(1) のコアアルゴリズムは十分な水準で実装されており、実験的機能としてマージ可能な完成度に近い。ただし **P1 の 2 件（無条件出力・型パニング）は生成コードの正当性に関わるためマージ前必須**。IELR 拡張の近似（6.3 A/B）は「動くが最適でない」レベルなので、大規模文法での状態数計測結果を添えて判断するのが妥当。

---

## 8. 残課題とロードマップ

### 8.1 マージ前に必須

- [ ] `yy_state_*_accepts_token` を `pslr_enabled?` ガード内に移し `static` 化（P1）
- [ ] `yy_state_deep_accepts_token` の `short` キャストを正しい `yy_state_t` に修正（P1）
- [ ] `merge_lookaheads` バグ修正・`state.rb` の nil ガード・`validate!` 呼び出し順変更を別 PR に分離
- [ ] `%lex-scope` に言及する死んだコメントを削除

### 8.2 短期（実験的機能として公開した直後）

- [ ] 大規模文法（Ruby `parse.y` / ISO C99）での状態数・テーブルサイズ・生成時間の計測。論文 Table 4.1〜4.3 相当のデータを出す
- [ ] LAC の再利用バッファ化
- [ ] PSLR テーブルの整数型最適化と `length_precedes` の bitset 化
- [ ] `LexPrec#identity_precedes?` のハッシュ索引化、`pairwise_conflict_pairs` のメモ化
- [ ] 論文 Fig 3.3 / 3.4 / 3.5 の曖昧性 3 例を回帰テストに追加（いずれも unresolved として報告されることを確認）
- [ ] `Reporter::Pslr` の出力量制御

### 8.3 中期（論文への追随）

- [ ] 状態互換性判定を「対ごとの解決結果の比較」に是正（6.3 B）。`PairwiseResolution` に、各 conflict 対について `∆` が選ぶトークンを事前計算した表を持たせる
- [ ] コンフリクト報告を profile 単位に集約（6.3 C）
- [ ] shorter-wins 時の `scanner_accepts` 書き込みを論文どおり抑止（6.3 D）
- [ ] 型/タグ単位の一括 `%token-action`（論文 3.6 で実装済みとされている唯一の欠落）
- [ ] IELR phase 2 の PSLR 注釈（6.3 A）。これができれば `pslr.max-states` ガードは保険に格下げできる
- [ ] fallback 行を文法の全終端 `T'` に拡張（bridge モードの実用性向上）

### 8.4 長期（論文の future work）

- [ ] 非対称 lexical tie（PL/I・SQL の非予約語対応）
- [ ] lexical nonterminal / `%lex` / lexical parser
- [ ] scoped declarations（C++ の `>` / `>>` を副言語ごとにスコープ）
- [ ] scope ごとの fallback 行

---

## 付録 A: 用語対応表

| 論文の記法 | 意味 | Lrama の実装 |
|---|---|---|
| `Ξ` | 文字集合 | バイト 0–255 |
| `ξ` | 入力文字列 | `input` (const char*, 長さ指定) |
| `λ` | lexeme（一致した部分文字列） | `result->length` |
| `M(ξ, T)` | `ξ` に対する `T` 上の全一致集合 | FSA 走査で暗黙に列挙 |
| `Σp` / `sp` | パーサ状態集合 / 状態 | `States#states` / `State` |
| `Σs` / `ss` | スキャナ FSA 状態集合 / 状態 | `ScannerFSA#states` |
| `acc(sp)` | `sp` が受理するトークン集合 | `acceptable_tokens_for_pslr` |
| `acc(ss)` | FSA 状態 `ss` の受理トークン | `State#accepting_tokens` |
| `acc(sp, ss)` | 両者の積 | `current_acceptable_tokens` |
| `∆` | 字句優先度関数 | `ProfileResolver#resolve` |
| `F` | 逐次字句優先度関数 | （使用しない。論文も `∆` を採用） |
| `R` | 字句優先度規則集合 | `Grammar::LexPrec` + 既定規則 |
| `T0` / `T'` | 全終端（fallback 用） | 生成 FSA が知るトークン全体 |
| `#` | 入力終端 | `YYEOF` |
| `(Ts, ts, Tl)` | scanner conflict profile | `(shorter_tokens, selected_shorter_token, current_tokens)` |

## 付録 B: 参考リンク

- PR: <https://github.com/ruby/lrama/pull/774>
- 論文: <https://open.clemson.edu/all_dissertations/519/>
- IELR(1) 原著: Denny & Malloy, "The IELR(1) algorithm for generating minimal LR(1) parser tables for non-LR(1) grammars with conflict resolution", *Science of Computer Programming*, 2010
