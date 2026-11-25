---
created: 2026-11-25
title: Universal Parser ロードマップ
description: parse.y の libruby 依存を減らし、退行防止から単体配布までの段階的な作業を整理する
status: draft
tags: [ruby, parser, universal-parser, roadmap]
authors: [ydah]
updated: 2026-11-25
---

調査時点: 2026-11-21

## 背景とゴール

結論：残っている作業の中心は「libruby への依存を減らすこと」と「依存が増える退行を止めること」です。単体ライブラリとしての配布はまだ手つかずです。ただ 2023年から状況が大きく変わったので、最初にゴールを決め直す必要があります。

Universal Parser は、parse.y を CRuby 本体（libruby）から切り離し、他の実装やツールでも使えるようにする取り組みです（[開発日誌 (8)](https://yui-knk.hatenablog.com/entry/2023/05/01/174828)）。想定していた使い手は mruby・PicoRuby、JRuby・TruffleRuby、sorbet などでした。仕組みは、必要な関数を `rb_parser_config_t` に詰めて外から渡す方式です。2023年6月に [Feature #19719](https://bugs.ruby-lang.org/issues/19719) として ruby/ruby に入りました。

その後の主な変化は次のとおりです。

- Ruby 3.4 から Prism がデフォルトのパーサになりました（[Feature #20564](https://bugs.ruby-lang.org/issues/20564)）。
- Matz は、今後の公式なパーサ API を Prism の API とすることに合意しています（[Feature #21827](https://bugs.ruby-lang.org/issues/21827) の説明より）。
- 「parse.y が Prism の API を実装する」案の [Misc #21825](https://bugs.ruby-lang.org/issues/21825) は、2026年2月に理由のコメントなしで Rejected になりました。
- Ripper の非推奨化は開発者会議で「まだ早い」とされましたが、irb・rdoc・rbs はすでに Ripper を使わなくなっています（#21827）。

このため、外部の使い手に配るという当初の目的は弱まっています。一方で、parse.y の依存先が config に集まっていれば、`--parser=parse.y` の保守もしやすくなります。そこでこのロードマップは、まず退行を止めて依存を減らし、配布するかどうかは Phase 0 の決定に従う構成にしました。

## 現状

外から渡す関数（`rb_parser_config_t` のメンバー）は、2023年5月の 209 個から 104 個まで減りました。ただしそのうち 43 個はシグネチャに `VALUE` を含み、Ruby オブジェクトがあることを前提にしています。数字は master（2026-11-21 時点の [`72d4cf2e`](https://github.com/ruby/ruby/commit/72d4cf2e)）の `rubyparser.h` を数えたものです。

> 元資料の埋め込み: rubyparser.h（master 72d4cf2e、2026-11-21）の rb\_parser\_config\_t を集計 · 14 カテゴリ

Encoding と Symbol は数こそ多いものの VALUE をほとんど含まないので、VALUE をなくす作業は String・例外・IO から始めるのが効率的です。

| 2023年の目標 | 状態 | 根拠 |
| --- | --- | --- |
| UNIVERSAL\_PARSER モードを ruby/ruby に入れる | 済み | #19719（2023-06）。CI の compilers.yml に UNIVERSAL\_PARSER ジョブがある |
| RNode の union を型ごとの構造体にする | 済み | [74c67811](https://github.com/ruby/ruby/commit/74c67811)（2023-08） |
| リテラルを Ruby オブジェクトから切り離す | ほぼ済み | NODE\_INTEGER などは文字列で保持。NODE\_SYM の生成だけ `VALUE` を経由する |
| AST を imemo / GC から外す | AST 側は済み | [e816ab0b](https://github.com/ruby/ruby/commit/e816ab0b)、[2244c58b](https://github.com/ruby/ruby/commit/2244c58b)（どちらも 2024-04）。config には gc\_mark などが残る |
| shareable\_constant\_value を compile.c へ移す | 済み | [60567731](https://github.com/ruby/ruby/commit/60567731)（2024-04） |
| 外から渡す関数を減らす | 途中 | 209 → 104 |
| ruby\_scan\_hex / oct / digits と strtod を内製する | 一部 | hex と oct は [6b15825d](https://github.com/ruby/ruby/commit/6b15825d)（2026-10）で済み。scan\_digits と strtod が残る |
| malloc / free だけを任意で渡せるようにする | 未着手とみられる | メモリ系 11 個と GC 系 4 個が残る |
| 単体ライブラリや gem として配布する | 未着手 | common.mk に単体ビルドのターゲットがない |

config を通さず、libruby の関数を直接呼んでいる箇所もあります。UNIVERSAL\_PARSER ビルドでも internal.h 経由で宣言が見え、ruby 本体にリンクされるので、今の CI では検出できません。PR #19534 の `rb_memhash` も同じパターンです。parse.y を静的に調べた候補は次のとおりです（ビルドでの確認はまだ）。

| 関数 | 使っている場所 | 用途 |
| --- | --- | --- |
| `rb_node_*_val`（10種類） | `nd_value()`、`%printer` | 重複キー警告のメッセージ、デバッグ表示 |
| `rb_str_new_parser_string` | `str_to_sym_node()`、`parser_reg_compile()` | Symbol リテラルの生成、正規表現のチェック |
| `rb_exc_raise` | マジックコメントの encoding エラー | 例外の送出 |
| `rb_sym2id` | パターンマッチの `"key":` ラベル | ID への変換 |
| `rb_str_cat` | lex state や bitstack のデバッグ出力 | 文字列の連結 |
| `rb_ispunct` | `TOKEN2ID` マクロ | 文字種の判定 |

開発の勢いも落ちています。コミットメッセージから Universal Parser 関連と分かるものは、2024年の 33 件に対し、2025年は 8 件、2026年は 1 件でした（検索による概数）。

## 直近の対応：PR #19534

[PR #19534](https://github.com/ruby/ruby/pull/19534) は、`UNIVERSAL_PARSER` のときだけ今の djb2 を残す形にすれば、すぐ入れられます。通常のビルドでは衝突対策が効き、Universal Parser の依存も増えません。

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

`rb_parser_str_hash` と `rb_char_p_hash` は今までどおり `parser_memhash` を呼ぶので、差分は小さく済みます。djb2 の定義も `#ifdef` の中に入れないと、通常ビルドで unused function の警告が出ます（[474f4188](https://github.com/ruby/ruby/commit/474f4188) と同じ問題）。

UNIVERSAL\_PARSER 側には衝突の問題が残ります。`literal_hash` は st のコールバックなので `p`（config）を受け取れず、config 経由で `rb_memhash` を呼ぶことはできません。対策の候補は2つです。

1. `siphash.c` を parser 側にも含め、seed だけを config から受け取る。`siphash.c` は標準ヘッダと `siphash.h` しか使わないので、libruby への依存は増えない。
2. ハッシュ表を作るときに config から seed を取り出し、パーサ側の変数に持たせる。

PR のテストはそのまま使えます。case/when の重複チェック（`case_labels`）も同じハッシュを使うので、そちらのテストも一つ足すと安心です。

## フェーズ別ロードマップ

Phase 1 と 2 は、どのゴールを選んでも役に立つ小さな作業です。Phase 3 と 4 は、単体配布を目指すと決めた場合に進めます。

> 元資料の埋め込み: ロードマップ · 5フェーズと3つの関門

Phase 0 は Phase 1・2 と並行して進め、その結論で Phase 3 に進むかどうかが決まります。

### Phase 0：ゴールを決め直す

- [ ] 「決めるべきこと」の選択肢をもとに、yui-knk さんと方針を相談する
- [ ] 開発者会議の議題に出す

完了条件：Universal Parser をどこまでやるかが合意されている。

### Phase 1：退行を止める

- [ ] PR #19534 を `#ifdef UNIVERSAL_PARSER` 付きで入れる
- [ ] UNIVERSAL\_PARSER ビルドのパーサ側のオブジェクトを `nm -u` で調べる CI チェックを足す。許可リストにないシンボルがあれば失敗させる
- [ ] 許可リストは、最初は「現状」の直接依存を既知の例外として許し、Phase 2 で減らす
- [ ] config に関数を足す手順を文書にする（[93638d07](https://github.com/ruby/ruby/commit/93638d07) の source hash が良い例）

完了条件：libruby への新しい直接依存が入ると CI が落ちる。

### Phase 2：config を通らない直接依存をなくす

- [ ] `NEW_SYM` が `rb_parser_string_t` を直接受け取るようにし、`str_to_sym_node()` の VALUE 往復をなくす
- [ ] `nd_value()` の警告メッセージを、`rb_node_*_val` を使わずに組み立てる
- [ ] `parser_reg_compile()` の文字列変換を config 側の `reg_compile` に寄せる
- [ ] encoding エラーの `rb_exc_raise`、`rb_sym2id`、デバッグ出力の `rb_str_cat` を config 経由か parser 内の実装に置き換える
- [ ] `rb_ispunct` を parse.y 内の実装に置き換える（`rb_isspace` などと同じ扱い）
- [ ] UNIVERSAL\_PARSER 側のハッシュも seed 付きにする（PR #19534 の続き）

完了条件：Phase 1 の許可リストから libruby の関数がなくなる。

### Phase 3：config を減らし、VALUE をなくす

残り 104 個は性質ごとに方針が違います。`local_defined`・`dvar_defined`・`compile_callback`・source hash の3つなどは、呼び出し側との正当なインターフェースなので残して構いません。

- [ ] 小さな純粋関数を parse.y 側に持つ：`scan_digits`、`strtod`、`rtest`、`nil_p`、`long2int` など
- [ ] エラー・警告・デバッグ出力（IO 7、Error 6、例外と Eval 6、VM 1）は、VALUE を作らずにデータとして返し、Ruby オブジェクトへの変換は ruby\_parser.c 側で行う
- [ ] String 11・Array 2・Numeric 1 の VALUE 生成をやめ、`rb_parser_string_t` などパーサ側の型に置き換える
- [ ] Encoding 19 個を、パーサ用の小さな encoding インターフェースにまとめる
- [ ] Symbol/ID 15 個を、intern と id2name 程度の最小限のインターフェースに絞る
- [ ] メモリ系 11 個を malloc・realloc・free だけにし、渡さなければ標準の malloc を使う。VALUE がなくなれば `gc_mark`・`gc_guard` も不要になる
- [ ] Ripper 用の 4 個は、Ripper を対象に含めるかどうかの決定（Phase 0）に従う

完了条件：config のシグネチャから VALUE が消える（今は 43 個）。

### Phase 4：単体でビルドして配布する

- [ ] common.mk に、パーサ側のオブジェクト（parse.o、node.o、parser\_st.o など）だけでライブラリを作るターゲットを足す
- [ ] libruby なしで `1 + 2` をパースする小さな C プログラムを CI で動かす（開発日誌 (8) のデモと同じ）
- [ ] `rubyparser.h` の公開範囲と互換性の方針を決める
- [ ] 配布形態を決めて実装する（2023年のメモでは ruby/universal\_parser の gem 案）

完了条件：ruby 本体なしで、C プログラムから AST が取れる。

## 決めるべきこと

いちばん大きいのは Universal Parser のゴールです。提案としては、当面は A で Phase 1・2 を進め、B は具体的な使い手が見つかってから判断するのが手堅いと考えます。

| 選択肢 | やること | 前提とコスト |
| --- | --- | --- |
| A. 設計上のルールとして続ける | 配布はせず、parse.y の外部依存を config に集める。Phase 1・2 を進める | 小さい。`--parser=parse.y` の保守性も上がる |
| B. 単体ライブラリとして配布する | 2023年の当初の目標。Phase 1〜4 すべて | 大きい。mruby・JRuby・sorbet などが今も必要としているかを先に確認する。Prism はすでに C や Java などの API を持つ |
| C. やめる | UNIVERSAL\_PARSER モードと config を整理して削る | 保守コストは下がるが、これまでの切り離しの成果を手放す |

そのほかに決めること：

1. **Ripper を対象に含めるか。** Ripper の非推奨化は #21827 で議論中で、同梱 gem は power\_assert 以外が移行済みです。含めないなら config の Ripper 用 4 個は対象外にできます。
2. **Prism の API を実装するか。** #21825 は Rejected ですが理由が書かれていません。その理由を確かめると、B を選ぶかどうかの判断材料になります。
3. **config の互換性を保つか。** 配布するなら、構造体のメンバーを足したり消したりするときのルールが必要です。
4. **誰が進めるか。** 2026年の関連コミットは 1 件です。各フェーズに担当を決めないと進みにくい状況です。

## 参考資料

- [Ruby Parser開発日誌 (8) - Universal Parserへの道](https://yui-knk.hatenablog.com/entry/2023/05/01/174828)（2023-05）
- [Ruby Parser開発日誌 (10) - parse.y リファクタリングチャレンジ](https://yui-knk.hatenablog.com/entry/2023/06/18/162100)（2023-06）
- [Feature #19719 Universal Parser](https://bugs.ruby-lang.org/issues/19719)
- [Feature #20564 Switch default parser to Prism](https://bugs.ruby-lang.org/issues/20564)
- [Misc #21825 Status of the universal parser implementing the Prism API](https://bugs.ruby-lang.org/issues/21825)
- [Feature #21827 Deprecating Ripper](https://bugs.ruby-lang.org/issues/21827)
- [PR #19534 Prevent quadratic parsing of colliding hash literal keys](https://github.com/ruby/ruby/pull/19534)
- [038189b6 Use dedicated parser\_string hash function](https://github.com/ruby/ruby/commit/038189b6)（djb2 を入れたコミット）
- [93638d07 Compute a source hash of the program in parse.y](https://github.com/ruby/ruby/commit/93638d07)（config に関数を足した例）
- [6b15825d Use digit scanner in the universal parser](https://github.com/ruby/ruby/commit/6b15825d)
- [rubyparser.h（master）](https://github.com/ruby/ruby/blob/master/rubyparser.h)（`rb_parser_config_t` の定義）
- 添付の「Ruby Parser やりたいことリスト」
