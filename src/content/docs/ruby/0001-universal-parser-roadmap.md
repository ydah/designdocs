---
created: 2026-11-25
title: Universal Parser の依存削減を先行する
description: parse.y の libruby 依存を増やさない仕組みを導入し、直接依存の解消後に単体配布の要否を判断する
status: proposed
tags: [ruby, parser, universal-parser, roadmap]
authors: [ydah]
updated: 2026-11-25
---

| 項目 | 内容 |
|---|---|
| 対象リポジトリ | [ruby/ruby](https://github.com/ruby/ruby) |
| 調査基準 | [`72d4cf2e`](https://github.com/ruby/ruby/commit/72d4cf2e9ab72899958450638409ebdc18e9855b)（2026-11-21の`master`） |
| 提案 | Universal Parserを設計上のルールとして維持し、librubyへの新しい直接依存を防いでから既存の直接依存を解消する |
| 保留事項 | 単体ライブラリとしての配布、Prism APIとの互換性、Ripper対応、configの互換性 |
| 検証範囲 | `rubyparser.h`と`parse.y`の静的調査。Universal Parserビルドと生成物のリンク検証は未実施 |

## 提案

Universal Parserは当面、`parse.y`の外部依存を`rb_parser_config_t`へ集約する設計上のルールとして維持する。
まず、librubyへの直接依存が増える退行をCIで検出し、既存の直接依存を解消する。
単体ライブラリとして配布する作業は、具体的な利用者と保守担当が決まるまで開始しない。

この方針では、Phase 0の合意形成と並行してPhase 1、2を進める。
Phase 3、4は、単体配布を目指すと決まった場合だけ実施する。

## 背景

Universal Parserは、`parse.y`をCRuby本体（libruby）から切り離し、Ruby実装や開発ツールから利用できるようにする取り組みとして始まった。
当初の利用者にはmruby、PicoRuby、JRuby、TruffleRuby、Sorbetなどを想定していた。
必要なCRuby関数を`rb_parser_config_t`（以下、config）に格納し、外部から渡す方式である。
この方式は2023年6月に[Feature #19719](https://bugs.ruby-lang.org/issues/19719)として`ruby/ruby`へ導入された。

導入後、Rubyのパーサを取り巻く状況は変わった。

- Ruby 3.4からPrismがデフォルトのパーサになった（[Feature #20564](https://bugs.ruby-lang.org/issues/20564)）。
- Feature #19719では、Matzが最終的なAPIとASTをYARP（現在のPrism）と互換にする方針を示している。
- `parse.y`がPrism APIを実装する案を扱った[Misc #21825](https://bugs.ruby-lang.org/issues/21825)は、理由を示すコメントがないままRejectedになった。
- Ripperの非推奨化は時期尚早とされたが、`irb`、`rdoc`、`rbs`はRipperから移行した（[Feature #21827](https://bugs.ruby-lang.org/issues/21827)）。

Prismは複数言語向けのAPIを持つため、Universal Parserを外部へ配布する当初の必要性は弱まった。
一方、`parse.y`の依存先をconfigへ集約すれば、`--parser=parse.y`を保守しやすくなる。
この保守上の利点は、単体配布の有無にかかわらず残る。

## 現状

`rb_parser_config_t`のメンバー数は、2023年5月の209個から104個へ減った。
このうち43個はシグネチャに`VALUE`を含み、Rubyオブジェクトの存在を前提とする。
数値は基準コミットの[`rubyparser.h`](https://github.com/ruby/ruby/blob/72d4cf2e9ab72899958450638409ebdc18e9855b/rubyparser.h)を14カテゴリに分けて数えた結果である。

EncodingとSymbolはメンバー数が多いものの、シグネチャに`VALUE`を含むものは少ない。
`VALUE`をなくす作業はString、例外、IOから始める。

### 2023年の目標に対する進捗

| 2023年の目標 | 状態 | 根拠 |
|---|---|---|
| `UNIVERSAL_PARSER`モードを`ruby/ruby`へ導入する | 完了 | [Feature #19719](https://bugs.ruby-lang.org/issues/19719)。CIの`compilers.yml`に`UNIVERSAL_PARSER`ジョブがある |
| RNodeのunionを型ごとの構造体へ分ける | 完了 | [`74c67811`](https://github.com/ruby/ruby/commit/74c67811)（2023-08） |
| リテラルをRubyオブジェクトから切り離す | ほぼ完了 | `NODE_INTEGER`などは文字列で保持する。`NODE_SYM`の生成だけが`VALUE`を経由する |
| ASTをimemoとGCから外す | AST側は完了 | [`e816ab0b`](https://github.com/ruby/ruby/commit/e816ab0b)、[`2244c58b`](https://github.com/ruby/ruby/commit/2244c58b)（2024-04）。configには`gc_mark`などが残る |
| `shareable_constant_value`を`compile.c`へ移す | 完了 | [`60567731`](https://github.com/ruby/ruby/commit/60567731)（2024-04） |
| 外から渡す関数を減らす | 進行中 | 209個から104個へ減少 |
| `ruby_scan_hex`、`ruby_scan_oct`、`ruby_scan_digits`、`strtod`を内製する | 一部完了 | hexとoctは[`6b15825d`](https://github.com/ruby/ruby/commit/6b15825d)（2026-10）で完了。`scan_digits`と`strtod`が残る |
| `malloc`と`free`だけを任意で渡せるようにする | 未着手とみられる | メモリ系11個とGC系4個が残る |
| 単体ライブラリまたはgemとして配布する | 未着手 | `common.mk`に単体ビルド用のターゲットがない |

### configを通らない直接依存

`UNIVERSAL_PARSER`ビルドでも`internal.h`経由で宣言が見え、Ruby本体へリンクされるため、現在のCIはconfigを通らない呼び出しを検出できない。
PR #19534が追加しようとした`rb_memhash`の直接呼び出しも、この検出対象に含まれる。
`parse.y`の静的調査では、次の候補が見つかった。
ビルドによる確認はまだ行っていない。

| 関数 | 使用箇所 | 用途 |
|---|---|---|
| `rb_node_*_val`（10種類） | `nd_value()`、`%printer` | 重複キー警告のメッセージ、デバッグ表示 |
| `rb_str_new_parser_string` | `str_to_sym_node()`、`parser_reg_compile()` | Symbolリテラルの生成、正規表現の検査 |
| `rb_exc_raise` | マジックコメントのencodingエラー | 例外の送出 |
| `rb_sym2id` | パターンマッチの`"key":`ラベル | IDへの変換 |
| `rb_str_cat` | lex state、bitstackのデバッグ出力 | 文字列の連結 |
| `rb_ispunct` | `TOKEN2ID`マクロ | 文字種の判定 |

開発の頻度も下がっている。
コミットメッセージからUniversal Parser関連と判断できるコミットは、2024年の33件に対して、2025年は8件、2026年は1件だった。
この件数は検索による概数である。

## 選択肢

| 選択肢 | 実施内容 | 前提とコスト |
|---|---|---|
| A. 設計上のルールとして維持する | 配布せず、`parse.y`の外部依存をconfigへ集約する。Phase 1、2を進める | コストは比較的小さい。`--parser=parse.y`の保守性も上がる |
| B. 単体ライブラリとして配布する | 2023年の当初目標に沿い、Phase 1から4まで進める | コストは大きい。mruby、JRuby、Sorbetなどの需要を先に確認する必要がある。PrismはC、JavaなどのAPIをすでに持つ |
| C. Universal Parserを終了する | `UNIVERSAL_PARSER`モードとconfigを整理して削除する | 保守コストは下がるが、これまでに進めた切り離しを失う |

本書は選択肢Aを提案し、Phase 1、2を進める。
選択肢Bは具体的な利用者が見つかった後に判断する。
選択肢Cは`parse.y`の依存管理にも利用できる仕組みを失うため、現時点では採らない。

## 直近の修正

[PR #19534](https://github.com/ruby/ruby/pull/19534)は、文字列リテラルのハッシュをseedなしのdjb2から`rb_memhash`へ変更する提案だった。
目的は、衝突するキーによる二次時間の解析を防ぐことにある。
このPRは2026年11月22日にマージされず閉じられた。
同等の修正を再提案する場合は、通常ビルドだけで`rb_memhash`を使い、`UNIVERSAL_PARSER`では現在のdjb2を残す。

```c
#ifdef UNIVERSAL_PARSER
static st_index_t
djb2(const uint8_t *str, size_t len)
{
    st_index_t hash = 5381;

    for (size_t i = 0; i < len; i++) {
        hash = ((hash << 5) + hash) + str[i];
    }

    return hash;
}
#endif

static st_index_t
parser_memhash(const void *ptr, rb_len_t len)
{
#ifdef UNIVERSAL_PARSER
    /* TODO: seed 付きの衝突に強いハッシュにする */
    return djb2(ptr, len);
#else
    return rb_memhash(ptr, len);
#endif
}
```

`rb_parser_str_hash`と`rb_char_p_hash`は、従来どおり`parser_memhash`を呼ぶ。
djb2の定義も`#ifdef`内へ移さないと、通常ビルドでunused functionの警告が出る。
同じ問題は[`474f4188`](https://github.com/ruby/ruby/commit/474f4188)で確認できる。

この修正だけでは、`UNIVERSAL_PARSER`側にハッシュ衝突の問題が残る。
`literal_hash`はstのコールバックであり、configを指す`p`を受け取れないため、config経由で`rb_memhash`を呼べない。
seedを渡す方式には次の候補がある。

1. `siphash.c`をパーサ側にも含め、seedだけをconfigから受け取る。`siphash.c`は標準ヘッダと`siphash.h`にだけ依存する。
2. ハッシュ表の作成時にconfigからseedを取り出し、パーサ側の変数に保持する。

PR #19534のテストは再利用できる。
`case_labels`も同じハッシュを使うため、case/whenの重複検査に対するテストも追加する。

## 実施計画

ロードマップはPhase 0から4までの5段階で進める。
各Phaseの完了条件を、次のPhaseへ進むための判定に使う。

### Phase 0: ゴールの再決定

- [ ] 選択肢AからCをもとに、yui-knkとUniversal Parserの方針を相談する
- [ ] 開発者会議の議題として提案する

完了条件は、Universal Parserをどこまで進めるかについて合意があることとする。
Phase 0はPhase 1、2と並行して進める。

### Phase 1: 直接依存の退行防止

- [ ] PR #19534と同等の修正を`#ifdef UNIVERSAL_PARSER`付きで再提案する
- [ ] `UNIVERSAL_PARSER`ビルドのパーサ側オブジェクトを`nm -u`で調べるCIチェックを追加する
- [ ] 許可リストにないシンボルを検出した場合はCIを失敗させる
- [ ] 現在の直接依存は既知の例外として許可リストへ入れ、Phase 2で減らす
- [ ] configへ関数を追加する手順を文書化する。source hashを追加した[`93638d07`](https://github.com/ruby/ruby/commit/93638d07)を例にする

完了条件は、librubyへの新しい直接依存が追加されたときにCIが失敗することとする。

### Phase 2: 既存の直接依存の解消

- [ ] `NEW_SYM`が`rb_parser_string_t`を直接受け取り、`str_to_sym_node()`の`VALUE`往復をなくす
- [ ] `nd_value()`の警告メッセージを、`rb_node_*_val`を使わずに組み立てる
- [ ] `parser_reg_compile()`の文字列変換をconfig側の`reg_compile`へ移す
- [ ] encodingエラーの`rb_exc_raise`、`rb_sym2id`、デバッグ出力の`rb_str_cat`を、config経由またはパーサ内の実装に置き換える
- [ ] `rb_ispunct`を`parse.y`内へ移し、`rb_isspace`などと同じ扱いにする
- [ ] `UNIVERSAL_PARSER`側のハッシュもseed付きにする

完了条件は、Phase 1の許可リストからlibrubyの関数がなくなることとする。

### Phase 3: configからVALUEを除去

104個のメンバーは性質ごとに扱う。
`local_defined`、`dvar_defined`、`compile_callback`、source hashなど、呼び出し側との正当なインターフェースは残す。

- [ ] `scan_digits`、`strtod`、`rtest`、`nil_p`、`long2int`などの小さな純粋関数を`parse.y`側へ移す
- [ ] IO 7個、Error 6個、例外とEval 6個、VM 1個は、`VALUE`を作らずデータとして返し、`ruby_parser.c`側でRubyオブジェクトへ変換する
- [ ] String 11個、Array 2個、Numeric 1個の`VALUE`生成をやめ、`rb_parser_string_t`などのパーサ側の型へ置き換える
- [ ] Encoding 19個をパーサ用の小さなencodingインターフェースへまとめる
- [ ] SymbolとIDの15個を、internと`id2name`程度のインターフェースへ絞る
- [ ] メモリ系11個を`malloc`、`realloc`、`free`だけにする。関数が渡されなければ標準の`malloc`を使う
- [ ] `VALUE`の除去後、`gc_mark`と`gc_guard`を削除する
- [ ] Ripper用4個の扱いは、Ripperを対象に含めるかというPhase 0の決定に従う

完了条件は、configのシグネチャから`VALUE`がなくなることとする。

### Phase 4: 単体ビルドと配布

- [ ] `common.mk`へ、`parse.o`、`node.o`、`parser_st.o`などのパーサ側オブジェクトだけでライブラリを作るターゲットを追加する
- [ ] librubyなしで`1 + 2`をパースする小さなCプログラムをCIで実行する。Ruby Parser開発日誌 (8) のデモを基準にする
- [ ] `rubyparser.h`の公開範囲と互換性方針を決める
- [ ] 配布形態を決める。2023年の案には`ruby/universal_parser`のgemがある

完了条件は、Ruby本体なしでCプログラムからASTを取得できることとする。

## 未決事項

### Ripperを対象に含めるか

Ripperの非推奨化は議論中である。
Feature #21827の調査時点では、Rubyに同梱されるgemのうち`power_assert`だけがRipperを使い続けている。
Ripperを対象外とする場合は、configのRipper用4個を削減対象から外せる。

### Prism APIを実装するか

Misc #21825はRejectedだが、理由は記録されていない。
理由を確認し、単体配布を選ぶかどうかの判断材料にする。

### configの互換性を維持するか

単体配布する場合は、`rb_parser_config_t`のメンバーを追加または削除するときの互換性規則が必要になる。

### 誰が作業を担うか

2026年の関連コミットは検索上1件である。
各Phaseの担当者が決まらなければ、ロードマップを継続して進めることは難しい。

## 影響範囲

- `ruby/ruby`の`parse.y`、`rubyparser.h`、`ruby_parser.c`、CI設定、ビルド設定を変更する。
- Phase 1、2は`--parser=parse.y`の保守性に影響するが、単体配布を前提にしない。
- Phase 3はconfigのシグネチャを変更するため、外部利用者がいる場合は互換性方針が必要になる。
- Phase 4は公開API、配布物、リリース方法を新たに定める。

## 参考資料

- [Ruby Parser開発日誌 (8) - Universal Parserへの道](https://yui-knk.hatenablog.com/entry/2023/05/01/174828)（2023-05）
- [Ruby Parser開発日誌 (10) - parse.y リファクタリングチャレンジ](https://yui-knk.hatenablog.com/entry/2023/06/18/162100)（2023-06）
- [Feature #19719 Universal Parser](https://bugs.ruby-lang.org/issues/19719)
- [Feature #20564 Switch default parser to Prism](https://bugs.ruby-lang.org/issues/20564)
- [Misc #21825 Status of the universal parser implementing the Prism API](https://bugs.ruby-lang.org/issues/21825)
- [Feature #21827 Deprecating Ripper](https://bugs.ruby-lang.org/issues/21827)
- [PR #19534 Prevent quadratic parsing of colliding hash literal keys](https://github.com/ruby/ruby/pull/19534)
- [`038189b6` Use dedicated parser_string hash function](https://github.com/ruby/ruby/commit/038189b6)（djb2を導入したコミット）
- [`93638d07` Compute a source hash of the program in parse.y](https://github.com/ruby/ruby/commit/93638d07)
- [`6b15825d` Use digit scanner in the universal parser](https://github.com/ruby/ruby/commit/6b15825d)
- [`rubyparser.h`（基準コミット）](https://github.com/ruby/ruby/blob/72d4cf2e9ab72899958450638409ebdc18e9855b/rubyparser.h)
- 「Ruby Parser やりたいことリスト」（移行元に添付本体が含まれていなかったため未確認）
