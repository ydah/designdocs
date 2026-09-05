---
created: 2026-09-05
title: Lrama に `%lex` による字句構造を導入する
description: 字句非終端ごとに独立したパーサープログラムを生成し、入れ子の字句構造を一つの合成トークンとして扱う機能の設計
status: draft
tags: [lrama, lex, parser-generator, lexer, language-composition]
authors: [ydah]
related: [0005-scoped-declarations]
updated: 2026-09-05
---

| 項目 | 内容 |
|---|---|
| Status | Proposed / 実装レビュー用の設計案 |
| Date | 2026-09-05 |
| Target | Lramaの決定的Cパーサー生成 |
| Related | [[0005-scoped-declarations]] |
| 主な判断 | 字句非終端ごとに独立したパーサープログラムを生成し、共有入力上のフレームスタックで実行する |
| 非保証 | 現行Lramaでの動作、生成Cのテスト成功、実測性能、最小状態数を保証した設計ではない |

## 1. 要旨

`%lex L` は、`L` の文法を**親からは一つのトークンとして扱う**ための宣言である。入れ子の括弧、入れ子コメント、文字列内部の構造などを、手書きの深さカウンターではなく通常の生成規則で定義する。

親のLRパーサーは`L`の内部トークンをshiftしない。入力上の開始トークンが選ばれると字句パーサーが起動し、終了トークンまでを解析して、意味値・位置・入力範囲を持つ一つの合成トークンを返す。字句パーサーから別の字句パーサーを呼ぶこともできる。

中心となる不変条件は次の三つである。

1. 入力の論理消費位置を更新する主体は常に一つであり、親と子が同じ字句を二重に消費しない。
2. 子の終了は子自身の文法とフレームで判断し、親の次トークンを読んで終了を判定しない。
3. 子の起動先は開始トークンの選択時に確定する。複数の子を試して、成功したものや最長のものを採用する機能にはしない。

本書の「完全」は、以下に定める対応範囲について構文・意味・失敗時の挙動を規定することを指す。任意の文脈自由言語を字句として最長一致させる機能や、任意の不正入力からの回復は対象外である。

## 2. 出典、現状、提案の区別

### 2.1 論文が提案していること

Denny 2010 §3.6、本文pp.75–76／添付PDF pp.82–83は、`%lex`、lexical nonterminal、lexical parser、開始・終了トークン、layoutとしての扱い、字句パーサーの階層を**将来の実装案**として述べている。階層をまたぐエラー回復についても研究課題としている。[D1]

したがって、同論文の実験結果を、本書で設計する`%lex`ランタイムの正しさや性能の実証として扱わない。

### 2.2 確認したLramaの実装

調査対象を以下に固定する。

- `ruby/lrama` master: `f58bbe406e660e2d7d2b77e827832754ccdea3c2`。
- PR #774: 調査時点でopen・未merge。headは`ydah/lrama`の`ab81b73f66abc605afeeea30d7842ef44aba3274`。

masterの`parser.y`と、PR headの`parser.y`、`lib/lrama/states.rb`、`lib/lrama/state/scanner_accepts.rb`を確認した。PR側には`%token-pattern`、`%token-action`、`%lex-prec`、`%lex-tie`、`%lex-no-tie`を読む経路と、scanner構築・状態分割・scanner accepts構築の経路がある。`ScannerAccepts`は通常行の未解決競合を宣言順で解決しない一方、fallback行では宣言順を使う実装を含む。[L1][L2][L3][L4]

本書はその作業ブランチを統合候補とするが、masterにこれらがmerge済みとは仮定しない。公開構文、型、メソッド名のうち本書で新たに定めたものは、すべて提案である。

### 2.3 論文から具体化・変更する点

| 項目 | 論文の記述 | 本設計 |
|---|---|---|
| 終了トークン | 終了トークンを`#`として扱う | 実トークンをshiftした後、入力を消費しない専用の`LOCAL_EOF`を供給する |
| 階層 | 字句パーサースタックを提案 | Cの再帰呼出しではなくheap上のフレームスタックを規定する |
| 起動の競合 | 詳細な公開仕様はない | 開始matchと呼出しdescriptorを一緒に解決する |
| layout | `YYLAYOUT`命名による特別扱い | 既存命名を維持し、子の自動layoutは既定で無効にする |
| 回復 | 階層対応は研究課題 | abortを既定とし、明示的な`error`規則による閉領域回復だけを追加可能にする |
| fallbackの同順位 | 論文§3.5は伝統的規則を使用 | 新ランタイムでは恣意的にtokenを選ばず、構造化された曖昧な字句エラーを返す |

終了方法の変更は、閉じ記号に対する`$n`・`@n`・意味値破棄を通常の文法規則と同じモデルで扱うためである。「閉じ記号を無視してEOFに置換する」実装にはしない。

## 3. 目的と非目的

目的は、非正則な字句構造の宣言的な記述、親文法からの内部構造の隔離、正しい入れ子処理、意味値の一回だけの移譲、まとまった字句単位でのエラー報告、既存文法へのopt-in導入である。

対象外は、GLR、バックトラッキング、複数の字句パーサーの並列試行、実行時に生成した終端文字列との照合、親のローカル変数表などによる字句規則の変更、scanner全体のUnicode化、非同期の入力中断・再開である。Rubyのheredocや全ての文字列構文をこの機能だけで置き換えることも本導入の完了条件に含めない。

## 4. 公開構文

以下の例は**提案する構文**であり、現行ブランチでそのまま受理されるサンプルではない。

```text
%define api.scanner integrated

%lex block
%lex-layout block none
%lex-recovery block abort

%token-pattern OPEN  /\{/
%token-pattern CLOSE /\}/
%token-pattern TEXT  /[^{}]+/

%%
start:
    block ';'
;

block:
    OPEN contents CLOSE
;

contents:
    %empty
  | contents TEXT
  | contents block
;
```

入力`{a{b}c};`に対し、親は`block`と`';'`を受け取る。外側の`block`パーサーは`OPEN, TEXT, block, TEXT, CLOSE`を処理し、内側の`block`は別フレームで解析される。

### 4.1 宣言の形式

```text
lex-declaration      := "%lex" [TAG] IDENTIFIER+
layout-declaration   := "%lex-layout" IDENTIFIER ("none" | IDENTIFIER+)
recovery-declaration := "%lex-recovery" IDENTIFIER ("abort" | "rules")
```

`%lex <node> block`は字句非終端と返却値の型を同時に宣言する。既存の`%type <node> block`と併記してもよいが、型が異なればエラーにする。同じシンボルを`%token`や`%token-pattern`でも宣言することは禁止する。

`%lex-layout L ...`は、Lのフレーム内で自動的に読み飛ばしてよいlayoutシンボルの許可集合を指定する。省略時は`none`である。`%lex-recovery`の既定値は`abort`である。同じ対象への矛盾する再宣言は宣言順にかかわらずエラーにする。

### 4.2 対応する字句パターン

開始・終了・内部のprimitive tokenは、統合scannerのbyte-orientedな非nullableパターンを使用する。文字クラス、group、選択、反復、制御文字escapeなどの対応範囲は基盤scannerの契約に従う。RubyのRegexpオブジェクトを実行する設計ではない。[P1]

対応しない正規表現構文は明示的に拒否し、別の意味に読み替えない。開始・終了に合成トークンを置くことはできない。

### 4.3 `YYLAYOUT`との関係

名前が`YYLAYOUT`であるか同prefixで始まる字句非終端は、親プログラムで自動layoutとして登録する。正常に閉じた領域は消費するが、親のLRスタックには返さない。

字句非終端の子フレームには、親のlayout許可を暗黙に引き継がない。例えば外側で空白をskipしても、文字列の内部から空白を消してはならない。スコープ機能と併用した場合の実際のlayout集合は、フレーム許可集合とスコープ側の有効layout集合の積集合である。

`YYLAYOUT`シンボルの明示的なRHS使用は禁止する。入れ子のlayoutは通常の字句非終端を内部で利用する。例は§15.2に示す。

## 5. 文法の静的制約

### 5.1 根の生成規則

字句非終端Lの各alternativeは、actionを除く記号列として次の形でなければならない。

```text
L → start-token middle* end-token
```

開始と終了を両方持つため、最低二つのprimitive terminalを必要とする。中間部分は空でもよい。最終actionは終了トークンの後に置けるが、その後に追加の文法記号を置けない。

開始前のmidrule action、終了後のmidrule用非終端、nullableな根、根全体の左再帰は禁止する。根の再帰参照は合成トークンへの呼出しに変換するので、通常のhelperの左再帰は使用できる。

型付きの根のalternativeには、明示的に`$$`を設定する最終actionを要求する。開始区切りの値を暗黙に`$$ = $1`として返さない。無型の根は意味値なしとして扱う。

### 5.2 境界記号の排他性

検査単位は元ファイル全体ではなく、**字句呼出しで分割した各パーサープログラム**である。

| 制約 | 内容 |
|---|---|
| 親の開始記号 | 親から呼ぶLのstart tokenを、同じ親プログラムの通常の生成規則で直接使用できない |
| 子の終了記号 | Lのend tokenは、Lの根の最終terminal以外の同一プログラム内のRHSに現れてはならない |
| 子の開始記号 | L自身のstart tokenをLの内部に通常terminalとして再利用できない。入れ子は字句呼出しで表す |
| 同一ID | 一つのLのstart集合とend集合はtoken IDとして交差しない |
| 同一字句 | 開始と終了が同じ文字列であることは許可する。異なるtoken IDを割り当てる |
| 境界のlayout | start/end tokenを自動layoutにできない |

終了記号が子のさらに内側の字句プログラムに現れることは問題ない。その記号は内側のフレームが所有する。同じ`}`を全フレームの終了として扱ってはならない。

パターンの字句集合が重なる別tokenも検査する。IDが異なるだけでは字句競合は解決しない。通常行で一意の決定ができない重なりはgeneration errorとなる。

### 5.3 複数alternativeと複数開始記号

Lが複数のstart/end tokenを持つことは許可する。開始記号が同じalternative間の選択は子のLR文法が行う。開始記号だけでalternativeを決めない。

異なるLとKが同じstart tokenを持つことも、異なる親プログラム／異なるscanner profileからしか呼ばれない場合は許可する。同じ有効profileで両方を起動できる場合は`LEX_AMBIGUOUS_ENTRY`にする。`%lex-prec`で同一開始tokenを比較しても呼出し先は区別できない。区別が必要なら異なる開始token IDか、共有する一つの字句根に整理する。

### 5.4 非生産性と進捗

各字句根には、終了記号まで有限の入力を導出する経路が必要である。非生産的な根は拒否する。nullable helperは許可するが、実行中に入力消費なしのreduce等が連続する場合にはstep上限を適用する。文法解析だけで任意のC actionの停止性を保証しない。

## 6. 意味モデル

### 6.1 二つの見え方

元のSymbolIdをLとすると、内部では次を区別する。

```text
LexicalDefinition(L)       文法ファイル上の定義
LexicalRoot(L, ProgramId)  子の生成規則のLHS
LexicalToken(L)            親のterminal
```

公開名はLのままであり、利用者に別のトークン名を宣言させない。親のFIRST/FOLLOW、ACTION、LAC、error recoveryは`LexicalToken(L)`を通常の一terminalとして扱う。

primitive scannerにとっては`LexicalToken(L)`は正規表現を持たない。親の候補`LexicalToken(L)`を、そのLの開始token群と呼出しdescriptorへ射影する。

### 6.2 パーサープログラムへの分割

生成物は一つのmain programと、各字句根から到達するlexical programからなる。

```text
Program(main): start → TOK(block) ';'
Program(block): block_root → OPEN contents CLOSE
                contents → ε | contents TEXT | contents TOK(block)
```

各プログラム内のhelperは、字句根へのRHS参照に到達した時点で探索を止める。helperを複数プログラムが共有するときは、同じソース規則をそれぞれのprogram-local IRへ展開する。意味値型とソース位置は共有し、LR用の番号だけを局所化する。

未使用の字句根は警告し、呼出し・layout登録から到達しないプログラムは出力しない。

### 6.3 開始時の候補

scannerが選ぶ単位を単なるTokenIdから次へ拡張する。

```text
ScanCandidate = {
  primitive_token_id,
  matched_length,
  delivery: RETURN | CALL | LAYOUT_CALL | LAYOUT,
  target_program_id?,
  result_symbol_id?,
  child_environment_id?,
  declaration_origins
}
```

`CALL`の優先順位比較で使う長さは**開始tokenの長さ**である。子が最終的に消費する領域全体の長さではない。

同じprimitive token・同じ長さでも、異なる子プログラムや異なる子環境を起動する候補は同一視しない。意味的に同じ呼出しであることを証明できるdescriptorだけをinternする。

### 6.4 起動を確定した後

起動を確定して開始tokenを消費した後は、他の候補に戻らない。子が失敗しても「開始tokenを通常tokenとして返す」「別の子を試す」「入力を開始位置まで戻す」は禁止する。

これはtokenizationの決定性と、意味actionを複数回実行しない性質を保つための仕様である。`%lex`はPEGのordered choiceではない。

## 7. 生成パイプライン

```text
ソース解析
  → SymbolId / RuleOriginId / occurrence位置の確定
  → parameterized ruleとinlineの展開
  → 字句根・境界・型・参照の検証
  → main / lexical programへの分割
  → scope環境の解決（未使用ならGLOBALだけ）
  → programごとのLR構築とparser conflict解決
  → 合成token候補を開始candidateへ射影
  → lexical tie展開
  → scanner profile / dispatch conflict解決
  → 必要な状態区別と再検証
  → ACTION・GOTO・scanner・dispatch・boundary tableの出力
```

展開時にソースの字句境界を消してはならない。`%inline`が字句根そのものに指定された場合は拒否する。字句根のhelperをinlineする場合も境界検証を展開後に再実行する。

子プログラムの構文競合と親の構文競合を混ぜた件数だけを表示しない。診断にはprogram名、元の規則位置、展開由来を付ける。

### 7.1 必要なIR

| 型 | 主な内容 |
|---|---|
| `Grammar::LexicalDefinition` | logical symbol、型、根の規則、layout分類、回復方針 |
| `Grammar::ParserProgram` | program ID、start symbol、局所rules/symbols、imports |
| `Grammar::LexicalImport` | result symbol、target program、start tokens、呼出しsite |
| `State::ScanCandidate` | primitive matchとdelivery descriptor |
| `State::BoundaryAction` | ROOT_OPEN、ROOT_CLOSE、通常shiftの区別 |
| `LexicalTables` | programごとのparser tableとscanner/dispatch table |

これらは新規の責務名の提案である。既存`Grammar::Symbol`の`term?`を状況依存で変更する実装は避け、program-local symbol mappingを用いる。

### 7.2 scanner競合

通常profileは完全な候補集合に対して一意のwinnerを要求する。pairwise比較を列挙順にfoldしてwinnerを決めない。既存のcomplete conflict profile方式を、delivery descriptorを失わない候補IDへ拡張する。[D1 §3.2.7][L4]

`%lex-prec`、`%lex-tie`のoperandとして字句根Lを指定することはV1では禁止する。これらはprimitive tokenの字句集合に対する宣言であり、文脈自由な領域全体の比較とは異なる。開始token間の関係を指定させる。

fallback用の全token集合は、そのprogramから到達するprimitive tokenとlexical import、および許可されたlayoutで構成する。他の無関係な字句programを起動候補に追加しない。

## 8. 実行時アーキテクチャ

### 8.1 所有する状態

```c
/* 型名・メンバーは生成ランタイムの提案。アプリケーション公開ABIではない。 */
struct yy_lex_frame {
    unsigned program_id;
    unsigned entry_environment_id;
    unsigned parent_result_symbol;
    unsigned delivery_kind;
    size_t region_begin;
    size_t region_end;
    bool root_close_shifted;
    bool tainted;
    yy_parser_stack stack;
    yy_pending_token lookahead;
    yy_trivia_accumulator trivia;
};
```

sessionは入力buffer、論理cursor、位置情報、フレームstack、resource budgetを所有する。フレームは自分のLR stack・lookahead・layout蓄積を所有する。親は子の実行中、自分のlookahead slotを子の内部tokenに使わない。

スタックの底はmain frameである。字句呼出しはフレームpush、完了はpopで実装する。生成された`yyparse`をCから再帰的に呼び出す実装にはしない。

### 8.2 入力API

統合scannerの入力providerは同期的にbyte列を供給する。

```text
read(destination, capacity) → DATA(count>0) | END_OF_INPUT | IO_ERROR
```

EOFをbyte値0と同一視しない。NULを含む入力も長さで扱う。`DATA(0)`は契約違反としてI/Oエラーにする。非blocking入力の`NEED_MORE`はV1では扱わない。

物理read-aheadと論理消費は区別する。DFAやbuffer refillが閉じ記号より先のbyteを先読みすること自体は許可するが、それらのbyteのtoken化、action実行、論理cursorの前進は親の再開まで行わない。

### 8.3 状態遷移

```text
親: NEED_TOKEN
  → scannerがRETURNを選ぶ → 親のlookaheadを設定
  → scannerがCALLを選ぶ
       → 子frameと開始token用slotを準備
       → 開始tokenを一度だけcommit
       → 子frameをpushし、開始tokenを子lookaheadへ移譲
       → 子が解析
       → 根の終了tokenをshift
       → LOCAL_EOFで根をreduceしてaccept
       → 子の結果を親lookaheadへmove
       → 子frameをpop
  → scannerがLAYOUT_CALLを選ぶ
       → 同じ手順で子を解析
       → 正常完了した領域を親triviaへ追加
       → 子結果をdestroyし、親のNEED_TOKENへ戻る
```

### 8.4 schedulerの擬似コード

```text
while frames is not empty:
    f = frames.top

    if f has no lookahead:
        if f.root_close_shifted:
            f.lookahead = LOCAL_EOF
        else:
            result = scan(f.program_id, f.current_state, input)
            if result is CALL or LAYOUT_CALL:
                child = prepare_child_or_fail(result)
                commit_start_once_into(child, result)
                frames.push(child)
                continue
            if result is lexical_error:
                handle_lexical_error(f, result)
                continue
            f.lookahead = commit_token_once(result)

    action = validated_action(f, f.lookahead)  # 必要ならactionなしのLAC

    if action is SHIFT:
        shift_owned_token(f)
        if action has ROOT_CLOSE role:
            f.root_close_shifted = true
            f.region_end = input.committed_offset
    elif action is REDUCE:
        reduce_and_run_action_once(f)
    elif action is ACCEPT:
        if f is main:
            finish_main()
        else:
            require f.root_close_shifted
            transfer_or_discard_result(f)
            frames.pop()
    else:
        recover_or_abort(f)
```

`ROOT_CLOSE`は「token IDがend集合に含まれる」だけで設定しない。正規化された根の末尾をshiftする遷移に付けるroleである。異なるroleが同一の決定的遷移に残る場合は生成時に拒否する。

### 8.5 `LOCAL_EOF`と実EOF

`LOCAL_EOF`はscannerや外部`yylex`が返すtokenではない。現在の子だけが参照する内部sentinelであり、byte消費も意味値生成も行わない。

frameの確保は開始tokenのcommit前に行う。開始tokenの値構築中に失敗した場合も、準備済みslotの所有情報を使ってcleanupする。開始位置へ戻って別の候補を試すことはしない。

実EOFが根の終了前に現れた場合は`LEX_UNTERMINATED`である。実EOFを`LOCAL_EOF`に変換して成功させない。終了tokenのshift後、根のreduceに必要な入力は`LOCAL_EOF`だけで足りるように子programを生成する。

### 8.6 アプリケーションからの入口

新しい統合ランタイムには、既存の外部lexer用`yyparse`とは区別した`yyparse_input`を生成する。生成headerの契約は次の形とする。実際のprefixは既存のAPI prefix設定に従い、`%parse-param`は追加引数として引き継ぐ。

```c
typedef enum {
    YY_INPUT_DATA, YY_INPUT_END, YY_INPUT_ERROR
} yy_input_status;

typedef yy_input_status (*yy_read_fn)(
    void *user, unsigned char *dst, size_t capacity, size_t *count);

typedef struct {
    yy_read_fn read;
    void *user;
} yy_input;

typedef enum {
    YY_PARSE_ACCEPT,
    YY_PARSE_SYNTAX_ERROR,
    YY_PARSE_INPUT_ERROR,
    YY_PARSE_RESOURCE_ERROR,
    YY_PARSE_CONTRACT_ERROR
} yy_parse_status;

typedef struct {
    yy_parse_status status;
    size_t error_count;
    size_t consumed_bytes;
} yy_parse_result;

yy_parse_result yyparse_input(yy_input *input /*, %parse-param ... */);
```

`YY_INPUT_DATA`では`0 < count <= capacity`を要求する。providerはdstに書き込むだけで、その領域を保持しない。sessionとbufferの寿命は`yyparse_input`の呼出し内に閉じる。結果として保持するraw textは明示的に所有するコピーまたは参照オブジェクトへ移す。

回復してmainの末尾へ到達した場合でも、error_countが非ゼロならstatusはSYNTAX_ERRORである。AST等のアプリケーション結果は既存と同様にparse parameterへ格納し、`yy_parse_result`自体はアプリケーションの意味値を所有しない。

合成tokenはprogram内のterminalとして内部番号を割り当てるが、外部`yylex`から返す公開token codeとしては追加しない。diagnosticとtraceには字句根のlogical nameを使う。外部lexer用APIを利用する既存文法は変更しない。

## 9. 先読み、default reduction、LAC

親に返した合成tokenは、shiftまたは明示的な破棄まで固定する。親がそのtokenで複数回reduceしても、子の再実行や再token化は行わない。

LACとerror-repairの探索は、合成tokenを一つのterminalとして扱う。探索中に字句frameを起動したり、入力providerを呼んだり、意味actionを実行してはならない。これはBisonのLACが行う「意味actionなしの探索」と同じ分離を維持するためである。[B1]

新しい統合ランタイムでは、実装の第一段階はdefault reductionを無効にし、未圧縮の明示ACTIONからscanner候補を構成する。default reductionの存在を理由に「全terminalが受理可能」としてはならない。

将来default reductionを有効化する条件は、reduce前後でscanner profile、dispatch、layout、boundaryの観測結果が保存されることを証明できる場合に限る。旧来の外部lexerを使う文法のdefault reduction設定は変更しない。

**字句actionは、親がその合成tokenを受理する前に実行される。** 親の将来のreduce actionが設定する状態に依存した値構築を行ってはならない。この制約は、LACを入れれば消えるものではない。

## 10. 意味値、action、位置、trivia

### 10.1 actionの規則

子の`$1`、`@1`、named referenceは子の規則内だけを参照する。親frameを参照する`$0`や負の番号は、字句program内ではgeneration errorとする。parse parameterは共有できるが、字句選択は実行途中の親actionが更新する可変状態に依存させない。

開始・終了primitive tokenの`%token-action`は、tokenがcommitされる際にそれぞれ一回実行する。Lに対する値はLの根のactionが構築するため、`%token-action L`は拒否する。

| 制御操作 | 字句programでの意味 |
|---|---|
| `YYERROR` | 現在の字句frameのエラー処理。`rules`方針ならローカル回復を試みる |
| `YYABORT` | セッション全体を失敗終了する |
| 早期`YYACCEPT` | 閉領域を完成させずに成功することを禁止し、実行時契約違反として失敗する |
| `yyclearin`相当 | 現在のframeの通常lookaheadだけを破棄する。境界sentinelや終了guardを無効化できない |
| `YYBACKUP`・入力巻戻し | 非対応。新ランタイムでは提供しない |
| 直接の`yychar`改変 | サポートするAPIに含めない |

`%initial-action`はsessionのmain開始時に一回だけ実行し、子frame開始時に再実行しない。既存の`%after-shift`、`%before-reduce`等のhookはmain programにのみ適用する。字句内部の計測には、program ID・frame depth・元のsymbol/rule ID・event種別を渡す新しいprogram-aware trace hookを使用する。既存hookに局所state番号を同じ形式で混入させない。

任意のC actionの外部副作用をロールバックする仕組みは提供しない。値構築を主用途とし、親に採用された時だけ必要な外部副作用は親のactionへ置く。

### 10.2 所有権

意味値を持つslotには初期化済み／所有中／移譲済みを区別する状態を持たせる。

| イベント | 所有権処理 |
|---|---|
| primitiveをshift | lookaheadから子stackへmove |
| 通常reduce | 従来と同じくactionがRHS値の利用・解放を管理。全RHS destructorの自動実行はしない |
| 正常な字句accept | 子のroot値を親lookaheadへmove。移譲済みrootをdestroyしない |
| layout字句accept | root値を一回destroy。raw spanはtriviaとして保持可能 |
| 親が合成tokenを破棄 | Lのdestructorを一回実行 |
| frame abort | 所有中のstack値・lookahead値だけをdestroy |
| allocation失敗 | それまでに所有している全frameの値を同じ手順でcleanup |

`YYERROR`、`YYABORT`等をユーザーactionから直接呼んで離脱する場合、実行中のRHS値をaction側が管理する既存契約との整合を保つ。実行中のRHSをcleanup対象から除外する経路と、生成ランタイム自身のallocation失敗で所有中slotを全てcleanupする経路を区別する。ユーザーが管理するRHSを生成側が再びdestroyしてはならない。[B2]

### 10.3 位置情報

合成tokenのraw spanは`[開始tokenの先頭, 終了tokenの末尾)`である。先行layoutは含めず、領域内部の文字列やlayoutは含める。行・列の標準実装はbyte offsetとLFベースで定義し、既存アプリケーションは位置更新hookで別のcolumn表現を供給できる。

終了tokenをcommitした時点の位置を保存し、`LOCAL_EOF`や親への結果移譲では位置を更新しない。途中で失敗した場合は、開始位置、実際に消費した終端、問題のtoken位置を別々に保持する。

### 10.4 triviaとbuffer寿命

layoutのraw spanは、同じframeが次に返す通常tokenのleading triviaに付ける。最後に残ったtriviaはmainのEOF、または子の終了処理で回収する。子のtriviaを無条件に親tokenのleading triviaへ合流させない。

字句根のraw spanを保持する場合はbuffer chunkの参照をpinする。入れ子の各階層で同じraw bytesをコピーしない。利用者が連続文字列を要求したときだけflatten/copyする。破棄済みchunkへのpointerを意味値に残さない。

## 11. エラー処理

### 11.1 エラーの分類

| code | 条件 | 既定の結果 |
|---|---|---|
| `LEX_NO_MATCH` | 現在programの通常/fallback候補に一致しないbyte | 一byteのエラー範囲を作り、回復方針へ渡す |
| `LEX_AMBIGUOUS_FALLBACK` | fallbackの一意の選択ができない | token IDを恣意的に決めず、候補群と範囲を報告 |
| `LEX_UNTERMINATED` | 実EOFまでに終了tokenへ到達しない | 全体abort |
| `LEX_SYNTAX` | 子文法がtoken列を拒否 | `abort`または`rules` |
| `LEX_UNEXPECTED_CLOSE` | 終了tokenは現れたが子文法が閉じられない | 閉じ記号の外へ進まず失敗 |
| `LEX_RESOURCE_LIMIT` | frame、byte、stack、step上限 | 全体abort。構文エラーとは区別する |
| `LEX_IO_ERROR` | provider失敗 | 全体abort |

未知byteのエラーspanと、実際に一byte進める操作は区別する。abort経路では追加消費を要求せず、回復のdiscard経路だけがそのspanをconsumeする。

### 11.2 有効だが親で不正な字句領域

現在の親stateでLが受理できなくても、そのprogramのfallback候補から一意にLの開始を選べる場合は、Lを最後まで解析できる。正常に閉じた後、親はL全体をunexpected tokenとして報告する。

例えば不適切な位置にある`{ ... }`を、開き括弧だけではなく一つの領域として破棄できる。これは論文が`%lex`の利用例として挙げた目的である。[D1 §3.6]

fallbackから複数の異なる子を起動し得る場合は、どれかを試してはならない。`LEX_AMBIGUOUS_FALLBACK`として停止または通常のbyte/token回復へ渡す。曖昧な回復では字句actionを実行しない。

### 11.3 `abort`方針

字句frame内で最初のsyntax errorが発生した時点で、現在の字句根と開き位置を報告し、全frameをcleanupしてparse失敗を返す。下流の区切りを探すheuristicは使わない。未閉じ文字列等を安全に扱う既定値とする。

### 11.4 `rules`方針

通常の`error`規則で、**同じ字句frame内**の回復を明示できる。

```text
%lex-recovery block rules
%%
block:
    OPEN contents CLOSE
  | OPEN error CLOSE
;
```

一度エラーが起きたframeは`tainted`になる。回復規則で根まで到達しても、正常なblock tokenとして親の通常actionへ渡さない。閉じたraw spanを持つ字句エラーイベントとして親のerror経路へ渡す。

回復には次の境界を課す。

- opening checkpointより下へLR stackをpopしない。
- primitive end tokenを回復用guardとして認識し、それを飛び越して次の親tokenを探さない。
- そのend tokenで回復規則を完了できなければ全体abortする。
- 内部に現れた、一意に識別できる子の開始は通常と同じ子frameで処理する。rawな括弧カウンターで代替しない。
- 未閉じ子、I/Oエラー、resource errorは親frameへ「回復済み」として返さない。
- 自動修復による開始token・終了token・合成tokenの挿入は禁止する。存在しない入力境界を捏造しない。

子がtaintedなら、その親の字句frameもtaintedにする。mainまで戻ったイベントは既存の`error`token経路へ接続し、重複する同一診断を抑制する。error eventの所有値を破棄してから回復を進める。

この方針は「どの不正入力でも次の文へ復帰できる」保証ではない。確実な閉領域を完成できない場合にabortすることまで含めて仕様とする。

## 12. fallbackの決定性

通常候補が一つでもmatchする場合、fallbackはそれを置き換えない。通常候補なしの場合だけ、現在program・有効scopeのfallback候補を評価する。

明示的優先順位で一意になればその結果を使う。一意にならない場合はtoken宣言順では決めず、候補一覧を持つエラーとする。エラー範囲の提示には最長のmatched spanを使用できるが、それは「最長のtokenとして正常認識した」という意味ではない。

旧来のscannerを使う文法とPR既存経路のfallbackを無断で変更しない。新しい統合ランタイムを有効にした文法だけの契約変更とする。[L4][F1]

## 13. スコープ付き宣言との連携

スコープは字句パーサーの代替ではない。scopeは「どの宣言が有効か」、`%lex`は「どのパーサーが入力領域と値を所有するか」を決める。

親の開始candidateには、起動する子のentry environmentを含める。開始字句のmatchと競合解決は親の有効宣言で行い、開始を選んだ後の子のtoken選択は子environmentで行う。完了後は保存された親の状態から再開する。

子から戻す合成tokenのkind/value/spanは、scopeが変わっても再分類しない。スコープが複数候補として残り、同じ開始matchが異なる子environmentを要求する場合は、その差をdispatch conflictとして扱う。

## 14. resource、性能、互換性

### 14.1 上限

以下は初期の運用上の既定値の提案であり、実測に基づく最適値ではない。

| 設定 | 既定値 | 対象 |
|---|---:|---|
| `lex.max-depth` | 256 | 同時に存在する子frame数 |
| `lex.max-region-bytes` | 16 MiB | 一つの字句領域がconsumeするbytes |
| `lex.max-buffer-bytes` | 64 MiB | pinされた分を含むbuffer量 |
| `lex.max-total-stack` | 1,048,576 | 全frameのLR stack cell総数 |
| `lex.max-steps-without-input` | 1,000,000 | byte消費なしの連続scheduler step数 |

負数、ゼロ、表現可能範囲を超える値は設定エラーとする。sizeの加算・容量拡張時にはoverflowを検査する。上限超過時に別の構文として解析を続けない。

### 14.2 性能モデル

フレーム管理の追加処理は字句呼出しごとにpush/pop一回である。LR stack量は各active frameのstack長の和、入力保持量はpinされているchunkの和である。

DFAを使うことだけを根拠に、全入力に対する線形時間を主張しない。最長一致のためのread-aheadと後続scanによって、病的なパターンでは同じbyteを再検査し得る。検査bytes数、commit bytes数、frame数を測定する。

受入評価では、字句領域の長さ、入れ子深さ、helperの再帰方向、末尾未閉じ入力、長いtokenの不一致を別々に測る。正常系の高速化のために境界検査を省略しない。

### 14.3 互換性

`%lex`を使わない文法は従来の生成経路を維持する。外部`yylex`がすでに合成tokenを返す構成と、統合scannerがそのtokenを構築する構成は混在させない。

V1の`%lex`は統合scannerを必須とする。手書きlexerと共同で同じ入力cursorを所有するadapter、非同期入力、GLR、任意の自動修復は非対応の組合せとして明示的に拒否する。

CRuby導入は独立した検証対象とする。Rubyの改行を一般の空白としてlayoutに分類することや、encoding・heredoc・Ripper等の意味処理を同時に置き換えることは行わない。[P1]

## 15. 詳細な使用例

### 15.1 同じ文字で開始・終了する引用領域

```text
%define api.scanner integrated
%lex quoted
%token-pattern Q_OPEN  /"/
%token-pattern Q_CLOSE /"/
%token-pattern Q_TEXT  /[^"\\\n]+/
%token-pattern Q_ESC   /\\(.|\n)/
%%
start: quoted ';';
quoted: Q_OPEN parts Q_CLOSE;
parts: %empty | parts Q_TEXT | parts Q_ESC;
```

開始と終了のbytesは同じだがIDは異なる。Q_OPENは親のCALL開始として使い、子内部ではQ_CLOSEだけを終了候補として使う。Q_ESCで消費した引用符は閉じ記号ではない。

### 15.2 入れ子コメントをlayoutとして使う

```text
%define api.scanner integrated
%lex YYLAYOUT_COMMENT comment

%token-pattern C_OPEN  /\/\*/
%token-pattern C_CLOSE /\*\//
%token-pattern C_TEXT  /[^*\/]+/
%token-pattern C_SLASH /\//
%token-pattern C_STAR  /\*/

%lex-prec C_SLASH -~ C_OPEN
%lex-prec C_STAR  -~ C_CLOSE

%%
start: 'x';
YYLAYOUT_COMMENT: C_OPEN comment_parts C_CLOSE;
comment: C_OPEN comment_parts C_CLOSE;
comment_parts:
    %empty
  | comment_parts C_TEXT
  | comment_parts C_SLASH
  | comment_parts C_STAR
  | comment_parts comment
;
```

mainはYYLAYOUT_COMMENTを自動layoutとして認識する。その内部では通常の字句根commentを呼び出して入れ子を解析する。二つの根の境界規則は同じだが、起動候補はprogramごとに区別される。

この例の`C_TEXT`は長い連続文字列を一度に読む。入れ子を処理するために全入力を一文字ずつLRへ渡す必要はない。

## 16. 診断設計

```text
error[LEX_AMBIGUOUS_ENTRY]: one start match selects two lexical parsers
  program: main
  input prefix: "{"
  candidate 1: block, entered at grammar.y:18:5
  candidate 2: object_literal, entered at grammar.y:19:5
  start token: OPEN
  note: parser completion is not used to choose an entry
```

generation errorは少なくとも、宣言位置、関係するRHS occurrence、program名、primitive token、delivery、反例prefixを含める。入力prefixの表示は制御byteをescapeし、長さ制限を設ける。

runtime errorは最内frameの問題位置と、開いている領域の開始位置を表示する。深いnestingでは全frameを無制限に表示せず、先頭・末尾と省略数を示す。

## 17. テスト計画と受入条件

### 17.1 必須のテスト行列

| 分類 | 入力・設定 | 期待する結果 |
|---|---|---|
| 最小 | `{}` | 一つのblock、span長2 |
| 親境界 | `{a};x` | blockの終了位置は`;`の直前。`;`とxの子actionは実行されない |
| 入れ子 | `{a{b}c};` | 子frameを二回起動し、親には外側一tokenを返す |
| 同字句境界 | `"a\"b";` | escaped quoteで終了しない |
| 正常layout | `/*a/*b*/c*/x` | 全コメントを読み飛ばし、親はxを受け取る |
| 改行保存 | quoted内の空白 | 親のlayout設定で消えない |
| 実EOF | `{a` | `LEX_UNTERMINATED`。成功tokenを返さない |
| 空入力 | EOF | 子を起動しない |
| dispatch競合 | 同一開始で異なる二根 | generation error |
| 再帰の停止 | 非生産的字句根 | generation error |
| 親で不正 | fallbackから正しく閉じたblock | block全体をunexpectedとして報告 |
| fallback曖昧 | 同順位の異なる二根 | どちらのactionも実行せずエラー |
| local回復 | OPEN error CLOSE | taintedな閉領域を親error経路へ返す |
| 未閉じnested | 外側内の未閉じ子 | 全体abort、frame/valueを一回ずつcleanup |
| LAC | 合成tokenの受理可能性検査 | 入力read回数とaction回数が増えない |
| default reduction | 有無の比較試験 | 有効化する最適化についてtoken/dispatch traceが等しい |
| limits | 深さ・bytes・stackの上限前後 | 境界値で定義どおり失敗しoverflowしない |
| binary | 埋込みNUL | EOFと誤認しない |
| chunk境界 | 全てのbyte位置でreadを分割 | 一括入力と同じtoken、値、span、diagnostic |
| 型・destructor | success、discard、YYERROR、OOM | double free・未初期化破棄・所有値の漏れがない |

### 17.2 差分検証

最初に、字句フレームと局所EOFをそのまま実装した小さいreference interpreterを作る。生成Cとreferenceに、token trace、CALL/RETURN trace、raw span、action counter、destructor counterを出力させて比較する。

正しい括弧列だけでなく、各byte位置で切断した入力、区切りの挿入・削除、escapeの切断を生成して比較する。構文木の一致だけでなく、**消費位置と所有権イベントの一致**を合格条件にする。

### 17.3 完了条件

文法検証、全error code、二重consume防止、子の局所EOF、layout、resource cleanup、scopeとの連携、生成Cのsanitizer試験が揃うまで実験的機能とする。テストの実施結果と性能値は実装PRで追記する。本書作成時点でこれらの試験を実行済みとはしない。

## 18. 実装分割

| 段階 | 変更 | マージ条件 |
|---|---|---|
| 1 | `parser.y`、`lib/lrama/lexer.rb`、生成`parser.rb`に宣言を追加 | 新構文をIR化し、非対応例を正しい位置で拒否 |
| 2 | program分割、字句import、境界検証 | パーサー実行なしでIRのgolden testが通る |
| 3 | CALL descriptorをscanner profileへ接続 | token IDだけで潰れるdispatch競合を検出 |
| 4 | 新しい生成C schedulerと共有入力所有 | 単一字句根と親境界の差分試験 |
| 5 | 入れ子、意味値move、trivia、limits | fault injectionとsanitizer試験 |
| 6 | `rules`回復とscope連携 | エラー時のtrace・cleanup試験 |
| 7 | 文書、report、互換性試験 | `%lex`未使用の既存fixtureに意味的な差分がない |

新規ファイル候補は`grammar/lexical_definition.rb`、`grammar/parser_program.rb`、`state/scan_candidate.rb`、`template/lexical_runtime.c.erb`とする。`States`・`State`には既存のLR生成責務を残し、別のパーサー生成フレームワークを重複実装しない。

字句パーサーの生成を「複数の独立したCファイルのyyparse」に分ける代案は採用しない。symbolや入力bufferの所有権、再帰深さ、cleanupを一つのschedulerで扱う方針を優先する。

## 19. 参考資料

[D1] Joel E. Denny, *PSLR(1): Pseudo-Scannerless Minimal LR(1) for the Deterministic Parsing of Composite Languages*, 2010。主に§3.2.7、§3.5、§3.6。添付PDFの本文pp.75–76はPDF pp.82–83。公開版: `https://open.clemson.edu/cgi/viewcontent.cgi?article=1519&context=all_dissertations`

[L1] Lrama masterの入力文法。`https://github.com/ruby/lrama/blob/f58bbe406e660e2d7d2b77e827832754ccdea3c2/parser.y`

[L2] Lrama PR #774の調査時点headの入力文法。`https://github.com/ydah/lrama/blob/ab81b73f66abc605afeeea30d7842ef44aba3274/parser.y`

[L3] 同headのLR/scanner生成経路。`https://github.com/ydah/lrama/blob/ab81b73f66abc605afeeea30d7842ef44aba3274/lib/lrama/states.rb`

[L4] 同headの通常行／fallback行の解決。`https://github.com/ydah/lrama/blob/ab81b73f66abc605afeeea30d7842ef44aba3274/lib/lrama/state/scanner_accepts.rb`

[B1] GNU Bison Manual, §5.8.3 LAC。`https://www.gnu.org/software/bison/manual/html_node/LAC.html`

[B2] GNU Bison Manual, §3.7.7 Freeing Discarded Symbols。`https://www.gnu.org/software/bison/manual/html_node/Destructor-Decl.html`

[F1] Flex Manual, §7 How the Input Is Matched、§10 Start Conditions。伝統的な最長一致・宣言順と、手動start conditionの比較対象。`https://westes.github.io/flex/manual/Matching.html` / `https://westes.github.io/flex/manual/Start-Conditions.html`

[P1] 保存済み設計`lrama_pslr_design(1).md`、2026-07-05。特に§5.2、§5.6–5.7。過去の設計資料であり、2026-09-05時点の実装状態の根拠には用いない。
