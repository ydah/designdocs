---
created: 2026-09-05
title: Lrama にスコープ付き宣言を導入する
description: 文法上の非終端出現を入口として、字句・構文宣言の有限な環境を適用する機能の設計
status: draft
tags: [lrama, scoped-declarations, parser-generator, lexer, grammar]
authors: [ydah]
related: [0004-lex-directive]
updated: 2026-09-05
---

| 項目 | 内容 |
|---|---|
| Status | Proposed / 実装レビュー用の設計案 |
| Date | 2026-09-05 |
| Target | Lramaの文法、LR構築、統合scanner |
| Related | [[0004-lex-directive]] |
| 主な判断 | RHS上の非終端の出現位置を入口とし、有限の宣言環境をLR itemとlookaheadに保持する |
| 意味の基準 | scope-aware canonical構築。通常のcanonical LRだけを正解判定には使わない |
| 初期生成方式 | 参照構築と保守的な状態同値化。効率的なIELR直接構築は互換な最適化として分離する |

## 1. 要旨

スコープ付き宣言は、同じ文法を複数の部分言語から再利用しながら、字句優先順位、lexical tie、layout、構文優先順位の適用範囲を分ける機能である。

例えば`>>`を通常の式では右shiftとして認識し、template引数では二つの`>`として扱い、その内部の括弧付き式では再び右shiftとして認識する。この違いを、利用者がlexerの状態変数やscope stackを更新するactionを書かずに指定できるようにする。

本設計は、スコープを「ソースファイルの宣言ブロック」や「lexerのstart condition」と同一視しない。**文法上の特定の非終端出現から導出される範囲に、名前付き宣言環境を適用する**。

同時に複数の導出候補が存在して宣言が食い違う場合は、深いscope、先に書かれたscope、最後に見たscopeを選ばない。左文脈によって区別できるものは状態で区別し、それでも残る矛盾はgeneration errorにする。

## 2. 出典と設計の位置付け

Denny 2010 §3.7、本文pp.77–79／添付PDF pp.84–86は、namespaceによるsymbol複製と、部分文法への入口となる**RHSの非終端の特定の出現**に基づく方法を提案している。itemへのscope記録、複数scopeによる競合、状態分割、scopeごとのfallbackも述べるが、これらは将来案である。[D1]

同論文は、通常のcanonical LRがscopeを記録しないため、scope対応によってcanonical LRの状態でさえさらに分割し得ると指摘している。本書でも、未注釈のcanonical LRとの一致を最終的な意味の保証にしない。[D1 §3.7]

本書で新たに定めるのは、公開構文、静的な継承、宣言種別ごとのshadowing、FOLLOWのscope所有、scope付きFIRST/closure、競合解決、保守的で実装可能な参照構築、診断・resource制限・テストである。

調査時のLramaはmaster `f58bbe406e660e2d7d2b77e827832754ccdea3c2`と、未mergeのPR #774 head `ab81b73f66abc605afeeea30d7842ef44aba3274`に固定した。PRには統合scannerの宣言を読む経路とscanner profileの構築がある。そこに存在する`%lexer-context`やcontext分類は、本書のscopeモデルの代替として使用しない。[L1][L2][L3]

## 3. 目的、非目的、対応範囲

目的は、共有文法の宣言の分離、意味を変える状態mergeの禁止、scope境界での正しい先読み、矛盾の生成時検出、エラー時のscope情報の保持である。

V1でscope化するものは、字句優先順位、lexical tie/no-tie、layout集合、構文優先順位・結合性である。symbolの名前・token番号・型・pattern・意味actionはglobalとする。

以下は対象外とする。

- C/C++/Rubyプログラム自身の変数・型・ローカル変数表のscopeを追跡すること。
- 意味actionが書き換える実行時lexer mode、semantic predicate、scopeの動的生成。
- 同じTokenIdの正規表現や意味actionをscopeごとに変えること。
- namespace/module/import機能、任意のGLR、任意の曖昧さの自動解消。
- 最小状態数、canonical構築を経由しない生成速度、CRuby全体への即時適用。

この範囲を明示するのは、後述する有限性、同一tokenの意味の保存、先読みの固定を実装上の契約にするためである。

## 4. 公開構文

### 4.1 宣言環境の定義

```text
%scope HOST {
  %lex-prec '>' -< RSHIFT
}

%scope TEMPLATE : HOST {
  %lex-prec RSHIFT -< '>'
}
```

`GLOBAL`はトップレベル宣言から作られる予約環境である。parentを省略したscopeのparentはGLOBALとする。`GLOBAL`の再定義、重複scope名、未知parent、継承cycleはエラーにする。

`%scope`の波括弧内はC actionではなく、文法宣言の領域としてparseする。既存の`begin_c_declaration`へ渡さない。scope定義のネストは許可せず、関係は名前付きparentで指定する。

scope宣言の定義順による差をなくすため、名前解決と継承解決は文法全体を読んだ後に行う。先に定義したscopeだけを参照可能にする仕様にはしない。

### 4.2 RHSの一つの出現への適用

```text
template_atom:
    NAME '<' %with-scope TEMPLATE template_tail
;

template_tail:
    expression '>'
;
```

`%with-scope TEMPLATE template_tail`は、この**一つのtemplate_tailの出現**を入口とする。template_tailというsymbolの全使用箇所に適用する指定ではない。

形式は次のとおりである。

```text
scope-definition := "%scope" NAME [":" PARENT] "{" declaration* "}"
scoped-use       := "%with-scope" NAME nonterminal-use
nonterminal-head := NAME ["%scope" SCOPE_NAME] ":"
```

`nonterminal-use`には通常の非終端、parameterized ruleの呼出し、`%lex`字句非終端を指定できる。primitive terminal、action、`%empty`への直接指定はエラーにする。

複数の記号を一つの範囲として扱う場合はhelper非終端で囲む。`%with-scope`がその位置からalternativeの末尾までを暗黙に覆う解釈は採用しない。

### 4.3 非終端の既定環境

```text
parenthesized_contents %scope HOST:
    expression ')'
;
```

非終端のheaderにscopeを指定すると、全ての呼出しに対する既定の入口環境になる。適用順は次である。

```text
明示的なRHS出現の%with-scope
  > 呼び出される非終端のheaderの%scope
  > 呼出し元規則が現在持つ環境
```

RHS指定とheader指定が異なってもエラーではなく、RHS指定が優先する。reportにはoverrideを表示する。

### 4.4 scopeは名前解決のnamespaceではない

HOSTとTEMPLATEが同じRSHIFTを参照する場合、TokenId、pattern、意味値型、destructorは同じである。scopeごとに異なるのは宣言環境である。

公開symbolを`HOST.RSHIFT`、`TEMPLATE.RSHIFT`へ自動的に改名しない。内部に`(非終端, 環境)`のinstanceを作ることはあるが、その名前を外部lexerやC actionに要求しない。

## 5. 継承の意味

### 5.1 静的な継承を採用する

`%scope S : P`は、Pを静的parentとする。Sへ入るとき、Sをその時の呼出し元環境に重ね合わせるのではなく、あらかじめ解決したSの**完全な有効環境**を選択する。

```text
effective(S) = resolve(effective(parent(S)), declarations(S))
enter(caller, S) = effective(S)
```

これにより、同じSをHOSTから呼んでもTEMPLATEから呼んでも、Sの中の宣言の意味は同じになる。親へ戻るときはcallerの環境へ復帰するが、「戻す」という意味actionは不要である。

動的なoverlay継承を採用しない理由は、再帰的な文法呼出しのたびに異なる宣言環境を組み立てることを避け、環境集合を有限に固定するためである。呼出し元ごとに違う意味が必要なら、異なる名前のscopeを定義する。

### 5.2 有効環境の構成

```text
Environment = {
  lexical_identity_rules,
  lexical_length_rules,
  lexical_tie_edges,
  lexical_no_tie_constraints,
  lexical_tie_closure,
  enabled_layout_symbols,
  syntactic_precedence_table
}
```

宣言の意味が等しい環境はinternして同じEnvIdを割り当ててよい。ただしscope名と宣言位置は診断用のprovenanceとして失わない。

`EnvId`の同一性をscope名だけで判断せず、反対に「受理token集合が同じだから同じ環境」とも判断しない。

## 6. 宣言種別ごとの規則

| 宣言 | scope内 | 継承・解決 |
|---|---|---|
| `%lex-prec` | 許可 | identity/lengthを分離し、同じcomponent keyを局所宣言でoverride |
| `%lex-tie` | 許可 | 有効な直接edgeを求めた後にclosureを再計算 |
| `%lex-no-tie` | 許可 | 直接edgeのshadowingとno-tie制約。closureの結果と矛盾すればエラー |
| `%layout` | 許可 | 親の集合への追加ではなく、そのscopeの集合を置換 |
| `%left` / `%right` / `%nonassoc` / `%precedence` | 許可 | 一つでも局所定義するなら、そのscopeの構文優先順位表全体を定義し直す |
| `%precedence-reset` | 許可 | 局所の構文優先順位表を空から定義する。後続宣言なしなら空表 |
| `%prec` | 規則上で許可 | reduce規則instanceの環境で評価する |
| `%token` / `%type` / `%nterm` | 不許可 | globalなsymbol identity・型の定義として扱う |
| `%token-pattern` / `%token-action` | 不許可 | 同じtokenの字句集合・意味をscopeで変えない |
| `%symbol-set` | 不許可 | globalに定義し、scope内のlexical宣言から参照する |
| `%destructor` / `%printer` | 不許可 | global。意味値の破棄時に可変scopeへ依存させない |
| `%lex` / `%lex-layout` / `%lex-recovery` | 不許可 | 文法構造・frame方針としてトップレベルで定義する |
| `%expect`等 | 不許可 | scope競合を抑制する局所オプションにはしない |

### 6.1 lexical precedenceの正規化

`%lex-prec A op B`をidentity componentとlength componentへ分割する。

| operator | 同じ長さ | 異なる長さ |
|---|---|---|
| `<-` | Bを選ぶ | 指定なし |
| `-~` | 指定なし | 長いmatchを選ぶ |
| `<~` | Bを選ぶ | 長いmatchを選ぶ |
| `-<` | 指定なし | Bを選ぶ |
| `<<` | Bを選ぶ | Bを選ぶ |
| `-s` | 指定なし | 短いmatchを選ぶ |
| `<s` | Bを選ぶ | 短いmatchを選ぶ |

このoperatorの基本的な区別はDenny 2010 §3.2に基づく。本書の追加は、それらを環境ごとに解決することである。[D1]

component keyはtoken pairを正規化したものとする。方向はvalueに含める。子でlengthだけをoverrideした場合、親のidentityの指定は残る。

```text
%scope OUTER {
  %lex-prec ID <~ KEYWORD
}
%scope INNER : OUTER {
  %lex-prec ID -s KEYWORD
}
```

INNERではidentityはKEYWORD優先のまま、lengthはshortestとなる。この組合せが実際の完全競合集合で一意のwinnerを定義できるかは、別途検証する。

### 6.2 declaration specificity

同じcomponentに複数の宣言が適用される場合は、まず最も内側の**静的継承段階**を選び、その段階内でoperandのspecificityを比較する。

```text
直接token × token
  > token × symbol-set
  > symbol-set × symbol-set
```

同じ段階・同じspecificityの宣言が同じ値を与えるなら重複警告だけを出す。異なる値なら矛盾としてエラーにする。symbol-setの定義順や要素の列挙順は優先順位にならない。

子のgeneric宣言は親のspecific宣言をoverrideできる。これは「子scopeの明示的な方針を優先する」という本設計の選択であり、reportでどの宣言をshadowしたかを確認できるようにする。

### 6.3 推移性と完全競合

lexical precedenceには推移閉包を取らない。`A < B`と`B < C`だけで`A < C`を補わない。完全候補集合Mに対して、全ての他候補を**直接**上回る唯一のmatchがある場合だけ解決済みとする。[D1 §3.2.1, §3.2.4]

```text
winner(M) = m  iff  m ∈ M and every m' != m satisfies m' < m
```

未解決のpairが存在することだけでは、完全競合が未解決とは限らない。例えばA/B/Cの相互関係が不明でも、Dがそれら全てを直接上回ればwinnerはDである。負ける候補間のcycleを見ただけで、その完全競合を必ず拒否する実装にはしない。

同一tokenの複数長のmatchは、明示的な自分自身への指定がない限りlongestを使う。異なるtoken間までlongestを暗黙に拡張しない。

### 6.4 lexical tie / no-tie

環境ごとに以下の順で処理する。

```text
宣言の継承・specificity解決
  → 有効な直接tie edgeとno-tie制約
  → tieの反射・対称・推移閉包
  → no-tie制約との整合性検証
```

子のno-tieで親の直接tie edgeをshadowすることはできる。ただし、他のedgeを経由して同じ二tokenが結ばれる場合は`SCOPE_TIE_CONTRADICTION`である。closureから特定pairだけを引き算することはできない。

```text
A--B と B--C が有効であるとき、A no-tie C はエラー
```

同じscope内のtieとno-tieの直接矛盾は、同じspecificityならエラーにする。lexical tieの展開はscanner候補を増やす操作であり、parser ACTIONを増やしたりwinnerを決めたりする操作ではない。[D1 §3.3]

### 6.5 layout

```text
%scope CODE {
  %layout YYLAYOUT_WS YYLAYOUT_COMMENT
}
%scope STRING : CODE {
  %layout none
}
```

`%layout`のoperandは、globalに定義されたlayout tokenまたはlayout字句非終端に限る。通常tokenをここで黙ってlayoutに変更しない。

GLOBALの既定layout集合は`YYLAYOUT`命名のシンボルから作る。scope内で省略した場合はparentの集合を継承する。明示した場合は集合を置換する。

複数scopeが同時に有効なstateで、あるlayoutの自動消費について許可／禁止が分かれる場合は、その差が入力上で生じ得るならscope conflictにする。片方だけでskipして他方の導出候補も残すと、本来空白を許さない部分言語まで受理し得るためである。

`%lex`の内部では、この集合とframe側の`%lex-layout`許可集合の積集合を使う。scopeを変えただけで、frame側が禁止したlayoutを有効化しない。

### 6.6 構文優先順位

scope内の構文優先順位表は、局所定義がなければparentの表全体を継承する。局所定義があれば、そのscopeの表全体を空から作る。

```text
%scope NORMAL {
  %left '+'
  %left '*'
}
%scope REVERSED : NORMAL {
  %left '*'
  %left '+'
}
```

REVERSEDでは`+`が`*`より強い。NORMALの数値rankとREVERSEDの数値rankを直接比較してはならない。

同じscopeの`%left`等の行の順序は、既存の構文優先順位宣言と同じく意味を持つ。一方、scope定義そのものの列挙順序には意味を持たせない。

規則のprecedence symbolは、明示的な`%prec`があればそれを使い、なければその規則の最後のterminalを使う。そのsymbolに局所表のentryがなければprecedenceなしとする。scope専用の仮想precedence tokenを使う場合も、symbol自体はトップレベルで定義する。

## 7. 境界と先読みの所有

### 7.1 scopeは非終端のyieldだけを覆う

```text
outer:
    '(' %with-scope INNER expression ')'
;
```

INNERが覆うのはexpressionが導出する部分だけである。`'('`と`')'`はouter側の環境に属する。

この違いは、expressionが完了するために`')'`をlookaheadとして取得する場合にも維持する。reduceが実際に起きる前であっても、そのlookaheadのscanner宣言はouterのものを使う。

### 7.2 閉じ記号もscopeに含めるとき

```text
outer:
    '(' %with-scope INNER inner_tail
;
inner_tail:
    expression ')'
;
```

この場合は`)`もINNERに属する。scopeを開始・終了する空規則とC actionを挿入するのではなく、文法で所有範囲を明示する。

templateの`>`と`>>`の例では、閉じ`>`をtemplate側の優先順位で選択する必要があるため、§15の例は`template_tail: expression '>'`を使う。入口非終端のFOLLOWまで無条件に子scopeを適用する実装は採用しない。

### 7.3 空導出

`%with-scope S optional`でoptionalがεを導出する場合、Sの入力範囲は空である。次のcaller tokenのscan環境はcallerのままとする。ε非終端をreduceするためにtokenを読むことと、そのtokenをε非終端のscopeに所属させることは別である。

### 7.4 read-aheadでscopeを変更しない

一度取得したlookaheadのtoken kind、match長、意味値、dispatchは、そのtokenをshiftまたは破棄するまで固定する。reduceのたびに別scopeで再scanしない。

先読みが必要になる前後の意味actionの実行順に、宣言環境を依存させない。BisonのLACも、入力を再解釈するためにsemantic actionを実行する機構ではない。[B1]

## 8. 中間表現

### 8.1 source-level IR

```text
ScopeDefinition {
  name, parent_name, declarations, location
}

SymbolOccurrence {
  symbol_id, occurrence_id, explicit_scope_name?, named_reference?, location
}

RuleDefinition {
  rule_origin_id, lhs_symbol_id, rhs_occurrences,
  explicit_precedence_symbol?, semantic_action, location
}
```

occurrence IDはソース上の出現を識別する有限のIDである。再帰呼出し経路全体をIDやcache keyへ連結しない。

### 8.2 resolved IR

```text
RuleInstance = (RuleOriginId, BodyEnvId, ParserProgramId)
NonterminalInstance = (SymbolId, EntryEnvId, ParserProgramId)
Lookahead = (TokenId, ScanEnvId)
Item = (RuleInstanceId, DotPosition, Lookahead)
```

`Lookahead`には診断用のorigin occurrence集合も付けられるが、無限の導出履歴は保持しない。同じtokenの同じ環境に対する有限のprovenance graphとして保存する。

ruleのbody環境とlookahead環境を分けることが重要である。単に`Item#scope_id`を一つ追加するだけでは、子規則をreduceさせるcallerのlookaheadを正しく扱えない。

### 8.3 環境の有限性

公開scope定義数をSとすると、GLOBALを含む有効環境は高々S+1個である。意味が等しい環境のinternにより減ることはある。frameのlayout許可maskはprogram属性として別に持ち、再帰深さに比例した新しいEnvIdを作らない。

非終端数N、規則総RHS長Mに対し、到達する規則・非終端instanceの数は、単一programでは概ねO((N+M)(S+1))の候補範囲に収まる。ただし**LR state数はその式で線形に抑えられるわけではない**。canonical state集合の構築には別の上限を必要とする。

## 9. scope-aware FIRST、closure、goto

### 9.1 entry環境の決定

出現oが非終端Bを参照し、caller環境がEであるとする。

```text
enter(o, E) = effective(o.explicit_scope)       if explicitly annotated
            = effective(B.header_scope)       if B has a default
            = E                               otherwise
```

一つのRuleInstanceの未注釈terminalは、そのRuleInstanceのbody環境でscanされる。

### 9.2 tagged FIRST

通常のFIRST集合の要素TokenIdを、`(TokenId, ScanEnvId)`へ置き換える。terminal出現のFIRSTはそのterminalと出現のbody環境である。非終端出現のFIRSTは`enter`で決定したinstanceから計算する。

nullableなprefixを越えてsuffixへ進む場合、suffixのterminal自身の環境を使用する。suffix全体がnullableなら、呼出し元itemのtagged lookaheadをそのまま引き継ぐ。

### 9.3 closure

```text
[A_E → α • B@F β, (t, E_t)]
```

というitemに対し、Bの各規則をFのRuleInstanceとして追加する。そのlookaheadは次の集合である。

```text
FIRST_tagged(β)
  ∪ {(t, E_t)}  if β is nullable
```

ここでFは`enter`の結果であり、βの解釈環境はcallerの規則に残る。βに別のscope注釈があれば、その出現だけで`enter`を適用する。

### 9.4 goto

terminalへのgotoは、同じlogical TokenId上の遷移を集めてdotを進める。terminalの意味・patternはglobalに固定されているため、同じtokenを受け取った導出候補を通常のLRと同様に進められる。

非終端へのgotoはNonterminalInstanceをkeyにする。reduceした`(B,F)`を、同じBでも別environmentのgotoへ入れない。

goto後もRuleInstanceとtagged lookaheadを保存する。scope集合とtoken集合を独立にunionして、元々存在しなかった`(token,scope)`の組を作ってはならない。

### 9.5 canonical stateのkey

stateの同一性は、closure済みのitem集合で定義する。ruleのsource IDだけ、未注釈LR(0) coreだけ、token集合だけではkeyにしない。

これにより、通常のcanonical LRなら一致する状態でも、環境の違いによって異なる状態として保持できる。[D1 §3.7]

## 10. 構文競合とscope競合

### 10.1 S/Rの比較

state q、lookahead tでreduce rとshiftが競合するとき、reduceのbody環境とshiftの由来環境を収集する。それぞれの有効構文優先順位表で、同じ`(r,t)`を解決する。

```text
resolve_sr(environment, rule, token)
    → SHIFT | REDUCE | EXPLICIT_ERROR | UNSPECIFIED
```

全てが同じ確定結果を与えるなら採用する。異なる確定結果、または確定結果とUNSPECIFIEDが混在する場合は`SCOPE_PARSE_CONFLICT`にする。片方のscopeの数値rankをもう片方のrankと比較して決めない。

全環境でUNSPECIFIEDなら、通常のparser conflictとして報告し、通常のconflict policyに委ねる。ただしscopeの異なるrule instanceを「元の同じ規則だから同じreduce」と黙って統合しない。

### 10.2 R/Rと明示的エラー

異なるscope由来のreduce先が異なるNonterminalInstanceである場合、意味actionのソース文字列が同じという理由だけで一つにしない。異なるgotoを持つからである。同じ有効環境へintern済みのinstanceは同一視できる。

`%nonassoc`で決めた明示的ERRORはACTIONの一種として保持する。状態mergeやdefault reductionで通常reduceに置き換えない。エラー検出のためのLACからも同じtableを参照する。

### 10.3 エラーの区別

| 種別 | 意味 |
|---|---|
| declaration contradiction | 一つの有効環境を作る前に、同じ宣言keyに矛盾がある |
| scanner conflict | 一つの環境でも字句候補のwinnerが決まらない |
| scope conflict | 同じ到達可能な左文脈に適用される環境が異なる判断を要求する |
| merge-induced conflict | 別々なら問題ない状態を統合したために生じる |
| parser conflict | 文法自身に残る通常のS/R・R/R |

scope conflictを通常のS/R件数に埋め込まない。`%expect`でscope conflictを見えなくすることも許可しない。

## 11. scanner profileの構築

### 11.1 有効scopeの取り出し方

候補の根拠は、実際のterminal shiftの出現と、reduceに必要なtagged lookaheadである。dotの前後に関係なくstate内の全itemのbody環境を集める方法は採用しない。

```text
Frontier(q) = {(token, scan_environment, origin)}
```

parser conflict解決によって無効になったACTIONの根拠は除く。ただしscopeの矛盾を隠すために、矛盾を検査する前に都合の悪い候補を消してはならない。parser側のscope整合性を先に検査する。

`Frontier(q)`からprimitive候補を作り、その環境のtie closureを適用し、layoutを追加し、字句importを開始descriptorへ射影する。tieによって増やしたcandidateにparser ACTIONを追加しない。

### 11.2 tokenの受理可能性とlexical tie

例えばIDに予約語をtieした場合、現在stateが予約語を構文的に受理しなくてもscannerはその予約語を選び得る。その結果は構文エラーになる。この挙動を避けるために、LACで通る候補だけに再び絞り込んではならない。[D1 §3.3]

LACは最終的に選択されたtokenの構文的受理可能性を検査する。lexical precedenceやtieを都合よく変更する機構ではない。

### 11.3 複数環境の比較

同じ入力prefixにmatchした候補a,bについて、それぞれの由来となる環境集合を使い、各環境の有効宣言でpairwise比較を行う。

```text
compare_E(a,b) → A_WINS | B_WINS | NO_RULE
```

全環境が同じ確定結果なら、そのpairの関係を採用する。異なる結果、または確定結果とNO_RULEが混在する場合はscope競合を記録する。全てNO_RULEなら未指定のpairとして残す。

candidateにはtoken IDだけでなく、長さ、RETURN/LAYOUT/CALL、起動program、子environmentを含める。同じtokenと同じ長さでもdeliveryが異なるcandidateは別の結果である。

同じlogical token・長さ・意味action・deliveryを持つcandidateは、由来scope集合を合流して同じ観測結果として扱ってよい。異なるpatternやactionをscopeに許可しないのは、この同一性を崩さないためでもある。

### 11.4 complete conflictとしての検査

実行時に単純なpairwise foldを行ってscopeを選択するのではなく、生成時にcomplete conflict profileを探索する。profileには少なくとも次を持つ。

```text
(scanner DFA state,
 shorter candidate classes,
 selected shorter candidate or unresolved,
 current accepting candidate classes,
 environment/provenance signature)
```

候補class数とDFA state数は有限である。visited keyに同じ組が現れたら探索を止める。prefixの文字列全体はkeyではなく、診断用の短いwitnessを復元するparent pointerとして記録する。

scope間で矛盾するpairが完全競合のwinner選択に必要になる場合はエラーとする。単一環境での未解決pairと同様に、全候補を上回る同じwinnerが存在することを確認できる場合、無関係な負け候補のpairだけを理由に拒否する必要はない。ただし、layoutの許可／禁止や異なるCALL先のような**副作用・配送先の不一致**はこの例外で隠さない。

### 11.5 見えないscope選択を作らない

layoutを消費しても親のLR stackは進まない。このため、layoutの許可が異なる導出候補をstate内に残したまま、許可するscopeだけに従ってskipしてはならない。

同じ問題はCALL先やchild environmentが違う場合にもある。これらは実行する前に一意化する。後続の入力を見てscopeが判明するはずだという理由で、先にどちらかの副作用を実行しない。

## 12. 生成アルゴリズム

### 12.1 V1の採用方式

**scope-aware canonical参照構築を必ず実装し、その結果に保守的な状態同値化を適用する。** 初期段階から、通常IELRに少量のmetadataを追加しただけで正しいと仮定しない。

この選択は状態数・生成コストを優先したものではなく、scope、lookahead、scanner選択の意味を明確にし、既存実装との境界を検証可能にするためである。大きい文法に対してbudgetを超える場合は明示的に失敗し、scopeを無視してLALRへ戻さない。

新設定`%define lr.scope-construction canonical`を定義し、scope使用時の省略値もcanonicalとする。既存の`lr.type`を明示して別の生成方式を要求している場合、対応が実装されていなければ組合せエラーにする。黙って別の方式に切り替えない。

### 12.2 処理順

```text
1. 全宣言・規則をparseし、source occurrenceを固定
2. symbolとscope名を解決し、継承cycleを検査
3. 各scopeの有効環境を計算・intern
4. parameterized/inline規則を展開しscope occurrenceを保存
5. %lexがあればprogramへ分割
6. start instanceから到達するNonterminalInstanceをworklistで作成
7. tagged FIRST / nullableを不動点計算
8. tagged closure / gotoでcanonical stateを構築
9. scope-aware parser conflict解決
10. scanner candidate・tie・layout・CALL profileを構築し検証
11. fallback、boundary、report用provenanceを確定
12. 保守的状態同値化
13. table圧縮、生成C出力、整合性再検証
```

3で作った有効環境は後段から変更しない。lexical winnerを見てtie closureを削ったり、merge後の結果から宣言を再解釈したりしない。

### 12.3 canonical構築の擬似コード

```text
states = { closure(start_item) }
worklist = [start_state]

while worklist is not empty:
    state = worklist.pop()
    for transition_key in sorted(outgoing_keys(state)):
        next = closure(advance(state, transition_key))
        key = full_scoped_item_set_key(next)
        if key is new:
            enforce_generation_budget()
            intern_and_enqueue(next)
        add_transition(state, transition_key, interned(next))
```

ここでterminalのtransition keyはlogical TokenId、非終端はNonterminalInstanceである。stateのkeyは両者を区別したitem集合である。

### 12.4 保守的な状態同値化

同値化の初期partitionは、次の情報が同じ状態だけを同じgroupにする。

```text
scoped LR(0) core
各token上のACTION種別とreduce RuleInstanceId
scannerのaccept出力・長さ比較表・delivery descriptor
有効layoutとfallback descriptor
%lexの境界role
```

その後、全shift/gotoの遷移先partitionが一致するまでpartition refinementを行う。reduce後のgotoも、NonterminalInstanceを含む遷移表を通じて比較する。

scannerの同値性は「現在のaccepting stateで返すtoken」だけで判断しない。過去の短いmatchと将来の長いmatchの比較、layout消費、CALL先、fallbackまで含む同一の有限table descriptorを要求する。これは十分条件であり、意味的には等しいが表現が異なるscannerまで積極的に同一化しない。

各partitionのtableを一つにした後、失われたprovenanceは診断用の集合として保持する。内部state番号が変わる以外のtoken、action、span、error-kindのtraceを保存する。

この同値化は最小状態数を保証するアルゴリズムではない。特にerror behaviorまで一致させるため、通常IELRより多い状態が残り得る。

## 13. IELRへの効率化経路

参照構築は機能の意味とテストoracleである。大規模文法への実用化のために、canonical全体を作らずにscope-aware状態を直接構築する最適化を別PRで追加できる。

その際も、少なくとも以下の情報を既存のIELR処理へ接続する。

| 既存責務 | 追加する情報 |
|---|---|
| LR(0) core / item equality | RuleInstanceと環境を消さないcore key |
| READS / INCLUDES / LOOKBACK / FOLLOW | TokenIdだけでなくlookaheadのScanEnvIdと由来の対応 |
| inadequacy annotation | parser action、scanner winner、layout、CALLのscope依存差 |
| lane / isocore merge判定 | scope付きprofileの互換性 |
| split後のlookahead再計算 | tagged lookaheadを再生成 |
| default reduction / table圧縮 | 候補・boundary情報を保存する条件 |

PR #774の`States`には、scannerを構築してからstateをsplitし、その後lookahead、conflict、scanner acceptsを計算する接続箇所がある。ただし、その存在だけでscope付きの対応関係が保存されるとは言えない。[L3]

最適化の採用条件は、参照構築との差分試験に加えて、使用するmerge判定が観測結果を保存する十分条件であることをコードと不変条件で説明できることとする。有限のテストだけで全入力の同値性を証明したと称しない。

V1の公開機能にこの最適化を必須とはしない。実装されていない最適化を、通常IELRへ設定を戻すことで代用しない。

## 14. 実行時、LAC、error recovery

### 14.1 外部lexerとの関係

構文優先順位だけをscope化する文法は、既存の外部lexerを使用できる。lexical precedence、tie、layoutをscope化する場合は統合scannerを必須とする。外部lexerが同じ宣言環境を実装しているはずだという仮定を置かない。

runtimeで利用者がscope stackをpush/popするAPIは追加しない。生成stateとscanner profileが必要な文法環境を表す。

### 14.2 default reduction

scope使用時の初期ランタイムではdefault reductionを無効にし、明示ACTIONに従う。これは既存の全パーサーに対する変更ではない。

default reductionを後から有効化する場合、scanner profile、宣言環境、CALL境界が変わるreduceをlookaheadなしで先に実行しないことを確認する。状態table圧縮によってscannerの許可token集合が広がらないよう、scanner maskは独立した明示tableに保持する。

### 14.3 LAC

LACの一時stackもscope付きstate IDを使う。探索中にscopeを単一のglobal変数へ書き込まない。探索は入力をconsumeせず、意味actionを実行せず、`%lex`の子を起動しない。[B1]

LACの成否を理由に、すでに取得したtokenを別scopeで取り直さない。予約語等のlexical tieにより選ばれた不正tokenは、仕様どおり構文エラーにする。

### 14.4 通常のerror recovery

回復のためにstackをpopすると、復帰先のstateが次に使うprofileも変わる。別のscope変数を手動で復元しない。

取得済みlookaheadを維持したままstackをpopする場合、そのtokenは元の分類のまま維持する。破棄した後で初めて、現在stateのprofileによる新しいscanを行う。古いtokenを新しいscopeで再分類して回復を成功させない。

### 14.5 scope別fallback

各`(program, environment)`にfallback universeを生成する。そのprogramで、そのenvironmentの到達可能な規則とlayoutに属するprimitive token／字句importを含める。関係しない別programのtokenまで無条件に追加しない。

通常候補がmatchしない場合だけfallbackを評価する。複数のscopeが残っているときは各scopeの結果を比較する。

```text
全scopeが同じ token/length/delivery を選ぶ → その結果
全scopeでmatchなし                       → unknown byte
結果が異なる／一部だけmatch              → AMBIGUOUS_SCOPED_FALLBACK
```

最後のケースで、どれかのscopeのCALLや意味actionを実行しない。エラー範囲は候補の最長span等から決定的に構成できるが、tokenの意味を恣意的に選んだことにはしない。

Denny 2010 §3.7のscope別fallbackという案を具体化しつつ、PRの従来fallbackにある宣言順選択は新scope経路には持ち込まない。[D1][L4]

## 15. 動作例: templateと括弧付き式

これはC++由来の字句選択問題を再現する小さい言語であり、現代C++全体の構文仕様ではない。背景となる例はDennyのFigure 2.6とN1757にある。[D1][C1]

```text
%define api.scanner integrated
%define lr.scope-construction canonical

%token-pattern NUMBER /[0-9]+/
%token-pattern NAME   /[A-Z]+/
%token-pattern RSHIFT />>/
%lex-no-tie '>' RSHIFT

%scope HOST {
  %lex-prec '>' -< RSHIFT
}
%scope TEMPLATE : HOST {
  %lex-prec RSHIFT -< '>'
}

%%
unit %scope HOST:
    expression ';'
;
expression:
    atom
  | expression RSHIFT atom
;
atom:
    NUMBER
  | NAME '<' %with-scope TEMPLATE template_tail
  | '(' %with-scope HOST paren_tail
;
template_tail:
    expression '>'
;
paren_tail:
    expression ')'
;
```

期待するtoken列は次のとおりである。

```text
8>>1;
  NUMBER RSHIFT NUMBER ';' EOF

Y<X<(6>>1)>>;
  NAME '<' NAME '<' '(' NUMBER RSHIFT NUMBER ')' '>' '>' ';' EOF

Y<X<6>>;
  NAME '<' NAME '<' NUMBER '>' '>' ';' EOF
```

重要なのは、TEMPLATEの指定をexpressionだけでなく`template_tail`に付け、閉じ`>`もTEMPLATEでscanすることである。括弧付き式の`paren_tail`はHOSTを明示的に選択するため、その内部ではRSHIFTが使える。

`%lex-no-tie`はこの例で`>`とRSHIFTを常に一緒に候補へ追加しないことを表す。どちらも候補になる箇所の解決は、各scopeの`%lex-prec`が行う。

## 16. parameterized rules、inline、midrule action

### 16.1 parameterized rule

`%with-scope S separated_list(expr, ',')`は、展開後のlist呼出し全体への注釈とする。未注釈の引数出現はlist側の現在環境を継承する。引数のsource occurrenceに明示scopeがある場合は、それを保持する。

展開cacheはrule引数だけでscope注釈を潰さない。少なくともsource occurrenceの注釈構造と、実体化時のentry environmentが区別できる二段階IRにする。

### 16.2 inline

inline展開によってscope付き非終端の境界を取り除いてしまう場合は、内部の各出現に同じ環境情報を残す。保存を実装できていない組合せはgeneration errorにする。

単に元のRHS記号列だけをコピーする実装は不可である。scope境界を含むwrapperを生成してよいが、そのwrapperの存在でuser actionの`$n`やnamed referenceをずらさないsource mappingを用意する。

### 16.3 midrule action

midrule actionから生成するε非終端は、そのactionがあるsource位置のbody環境を持つ。これをscopeへのenter/exitのためには使用しない。

actionが実行される前にlookaheadが取得され得るため、actionが可変scopeを更新する設計にはしない。生成されるhidden symbolにも元のscope・locationをreportできるようにする。

## 17. `%lex`との組合せ

`%lex`は物理的な入力領域の所有境界、scopeは宣言の適用境界である。二つを混同しない。

```text
%lex block
%scope CODE { %layout none }
%%
statement:
    %with-scope CODE block
;
```

この場合、blockを呼ぶentry environmentはCODEである。開始tokenを親の候補として選ぶ際には、親のlexical宣言を使用する。起動後のblock内のtoken選択にはCODEを使用する。

同じblockの開始が二つのentry environmentを要求し、子の観測挙動が異なる場合は、開始時点でscope/dispatch conflictにする。親を進めてから子のenvironmentを決め直さない。

子の終了tokenをshiftした後の`LOCAL_EOF`はscannerが認識する入力tokenではない。そのsentinelのためにcallerのfallbackやlayoutを実行しない。合成tokenを返した後は、保存されている親stateから再開する。

## 18. 診断とreport

### 18.1 declaration contradiction

```text
error[SCOPE_DECLARATION_CONTRADICTION]: conflicting lexical length rules
  scope: TEMPLATE
  tokens: '>' and RSHIFT
  declaration 1: grammar.y:12:3  (prefer '>')
  declaration 2: grammar.y:15:3  (prefer RSHIFT)
  note: equal specificity in the same inheritance level
```

### 18.2 intrinsic scope conflict

```text
error[SCOPE_LEXICAL_CONFLICT]: lexical decision differs by active scope
  program: main
  state: 84
  input prefix: ">>"
  HOST:     RSHIFT, length 2
  TEMPLATE: '>',    length 1
  entry 1: grammar.y:27:8
  entry 2: grammar.y:31:8
  note: conflict remains in scope-aware canonical construction
```

「文法が曖昧」と一律に説明せず、同じ左文脈でどの二つの宣言が必要になったかを示す。必要ならscope範囲をdelimiter込みのhelperへ移す修正例を表示する。

### 18.3 merge report

```text
merge rejected:
  source states: 71, 109
  common source core: expression → expression • RSHIFT atom
  reason: scanner profile / lexical length rule
  distinguishing input prefix: ">>"
```

scope-aware canonicalに残る競合と、最適化mergeを拒否すれば消える問題は別のreport項目にする。

### 18.4 機械可読report

新しい`--report=scopes,scanner-profiles`を提案する。JSON版にはschema versionを付け、少なくとも以下を出す。

```text
scope definitions / inheritance edges
resolved environment IDs / effective declaration sources
entry occurrence → environment
rule instances / tagged lookahead origins
states before and after minimization
conflict category / candidates / witness / source locations
layout membership disagreements
fallback universe / decision disagreements
```

同じ入力文法・設定に対して、Hashの走査順やprocess seedでreport順序・state番号が変わらないよう、symbol・environment・transitionを安定順で列挙する。

## 19. resource制限と安全性

初期の既定値案を以下に示す。これらは実測による推奨値ではなく、無制限の生成を避けるための運用上限である。

| 設定 | 既定値 |
|---|---:|
| `scope.max-environments` | 256 |
| `scope.max-rule-instances` | 1,000,000 |
| `lr.max-states` | 100,000 |
| `scanner.max-conflict-profiles` | 1,000,000 |
| `scanner.max-dfa-states` | 100,000 |

有効環境、LR state、scanner profileは、追加前にbudgetを検査する。中途半端なtableを生成物として保存しない。超過時にはどのscope／entry／規則が増加に寄与したかを示す。

参照構築は最悪時に大きくなる。state数比による追加guardもCI設定として提供するが、比較元は同じ正規化文法からscope注釈だけを除いた基準生成と明記する。基準文法に競合があっても、その件数をscope機能の正しさの比較には使わない。

生成コード中の環境IDやstate IDの整数幅は、確定した最大値から選ぶ。小さな型へ暗黙に切り詰めない。diagnosticには入力字句・scope名をescapeして表示する。

## 20. 互換性と過去の設計からの差分

### 20.1 既存文法

scopeを使わない文法はGLOBALのみとして既存経路を維持する。新機能のために既存のprecedence、token番号、外部yylex ABI、actionの意味を変更しない。

scope使用時は新しいtable構築契約と診断が有効になる。現在のPRの生成モードを、scope対応済みとして無条件に使用しない。

### 20.2 過去の`%lex-scope`案

保存済み2026-07-05設計は`%lex-scope`、`%with-lex-scope`、scope内の`%token-pattern`を提案している。[P1]

本書では字句宣言だけでなく構文優先順位も扱うため、公開構文を`%scope`と`%with-scope`に統一する。過去の設計案は出荷済みAPIと仮定しない。互換aliasを無条件に追加せず、実際に配布された構文が存在すると確認できた場合だけmigration policyを別途定める。

scope内の`%token-pattern`をV1から外した理由は、同じTokenIdがscopeによって異なる字句集合を持つと、あるscopeでだけmatchしたtokenによって別scopeのLR itemまで進めてしまう危険があるためである。この場合はscanner候補だけでなく、tokenの配送とparser側の導出候補の絞り込みまで再設計する必要がある。

V1ではglobalな異なるtoken IDとpatternを定義し、それらの優先順位やtieをscope化する。未対応のpattern shadowingを「動くはず」として受理しない。

### 20.3 Ruby向け導入

最初は独立した小さい文法で導入し、その後共有非終端を持つ実例へ進める。Rubyの`lex_state`、ローカル変数判定、encodingをgeneratorが近似することは完了条件ではない。

特に改行をGLOBAL layoutにする移行を同時に行わない。既存のtoken列・位置・エラー報告との差分を採取し、変化が文法上のscope指定に由来することを確認する。[P1]

## 21. 検証計画

### 21.1 単体試験

| 対象 | 期待する結果 |
|---|---|
| forward scope reference | 定義順に依存せず解決する |
| 継承cycle | 関係するscope列と宣言位置を報告 |
| 同じcomponentの矛盾 | 同specificityならgeneration error |
| identity/lengthの別override | 片方だけ変更し、他方は継承 |
| tieのclosure | 反射・対称・推移を満たす |
| no-tieと間接path | closure後の矛盾を検出 |
| symbol-set順序 | 意味が変わらない |
| precedence table | 局所表の全置換、rankをscope間で比較しない |
| 禁止した宣言 | scope内のpattern/type/actionを位置付きで拒否 |
| 同義environment | 意味を共有し、診断用の名前は失わない |

### 21.2 構築・runtime試験

| ケース | 期待する結果 |
|---|---|
| 未注釈 | 従来経路と同じ結果 |
| shared nonterminal | 出現ごとに別環境を適用 |
| nested restore | TEMPLATE→HOST→TEMPLATEと戻る |
| nullable入口 | 後続caller tokenを子環境でscanしない |
| FOLLOWの所有 | reduce規則のbody環境とは別のlookahead環境を保存 |
| 通常canonicalでは同じcore | scope差を失わず別stateにする |
| intrinsic conflict | state splitを繰り返さず参照構築上の競合として拒否 |
| merge-induced差 | 問題のmergeを拒否して意味を保存 |
| layout許可の差 | 一方だけskipして他方まで受理しない |
| 予約語tie | LACでIDへ戻してエラーを隠さない |
| scope別fallback | 不一致なら任意のscopeを選ばない |
| `%lex`のentry環境 | 同じ開始字句でも異なるCALLを潰さない |
| error時のstack pop | 現在stateへ戻り、既取得tokenを再分類しない |
| parameterized/inline | 展開後もoccurrence scopeが保存される |
| `%nonassoc` | 明示的ERRORと報告位置を保存 |
| OOM/budget | 不完全なtableを出力しない |

### 21.3 oracleと比較するもの

参照構築と最適化構築の両方で、同じscanner規則を使用する。比較するtraceはtoken ID、match長、位置、CALL/RETURN、reduceの元rule ID、layout span、error-kind、消費終端である。最終的なaccept/rejectだけでは足りない。

ランダム試験は、小さいscope数、重なるtoken pattern、nullable helper、二つ以上のentry、親子で反転した優先順位を組み合わせて生成する。入力をbounded enumerationし、異なるchunk分割、終了位置、error挿入で実行する。

scope名のalpha-renaming、scope定義順の変更、無関係なscopeの追加は意味を変えないというmetamorphic testを行う。`%left`の行順の変更は意味を変えるので、この不変性試験の対象にしない。

### 21.4 本書作成時に確認した範囲

§15の小さい文法について、tagged FIRST・closure・gotoと先読み固定を実装した補助Pythonモデルで、掲載した三つの入力が期待するtoken列になることを確認した。このモデルのcanonical state数は43だった。

これはLramaに本機能を実装して実行した結果ではない。また、scope全体の正しさ、generalなconflict resolver、layout、error recovery、生成Cの所有権を検証したものではない。これらは実装PRの受入試験として実行する。

## 22. 実装分割と完了条件

| 段階 | 変更 | 受入条件 |
|---|---|---|
| 1 | 構文、ScopeDefinition、occurrence IR | 新構文のsource位置と適用範囲を正しく保持 |
| 2 | 静的継承と宣言resolver | 全宣言種別の単体試験、矛盾診断 |
| 3 | RuleInstanceとtagged lookahead | FIRST/closure/goto、nullable・FOLLOW試験 |
| 4 | scope-aware canonical構築 | §15とintrinsic conflict fixture |
| 5 | scoped scanner profileとlayout/CALL | 完全競合とdelivery差の検出 |
| 6 | runtime、LAC、fallback | token固定、stack pop、エラー位置の試験 |
| 7 | 安全な状態同値化、report、budget | 参照traceとの一致、生成の再現性 |
| 8 | `%lex`統合と既存文法回帰 | frame境界・scope境界が混同されない |

新規クラス候補は`Grammar::ScopeDefinition`、`Grammar::DeclarationEnvironment`、`Grammar::SymbolOccurrence`、`Grammar::RuleInstance`とする。既存の`State::Item`、`States`、`State::ScannerAccepts`に対応関係を接続し、reportにも同じIRを使う。

公開可能とする条件は、V1の対応宣言が全て実装されていること、禁止組合せを拒否すること、参照構築と生成Cの差分試験、scopeなしの互換性試験、resource failure試験が揃うことである。効率的なIELR直接構築の有無とは切り離す。

「scope IDをstateに付けた」「templateの一例が通った」だけでは完了としない。**lookaheadの環境、layoutの非消費遷移、CALL先、エラー時のtoken固定まで保存されること**を機能の完了条件とする。

## 23. 参考資料

[D1] Joel E. Denny, *PSLR(1): Pseudo-Scannerless Minimal LR(1) for the Deterministic Parsing of Composite Languages*, 2010。§3.7、本文pp.77–79／添付PDF pp.84–86。Figure 2.6は本文p.21／PDF p.28。lexical precedenceは§3.2、tiesは§3.3。公開版: `https://open.clemson.edu/cgi/viewcontent.cgi?article=1519&context=all_dissertations`

[L1] Lrama masterの入力文法。`https://github.com/ruby/lrama/blob/f58bbe406e660e2d7d2b77e827832754ccdea3c2/parser.y`

[L2] PR #774 headの入力文法。`https://github.com/ydah/lrama/blob/ab81b73f66abc605afeeea30d7842ef44aba3274/parser.y`

[L3] 同headの生成・分割・再計算経路。`https://github.com/ydah/lrama/blob/ab81b73f66abc605afeeea30d7842ef44aba3274/lib/lrama/states.rb`

[L4] 同headのscanner conflict profileとfallback。`https://github.com/ydah/lrama/blob/ab81b73f66abc605afeeea30d7842ef44aba3274/lib/lrama/state/scanner_accepts.rb`

[B1] GNU Bison Manual, §5.8.3 LAC。`https://www.gnu.org/software/bison/manual/html_node/LAC.html`

[B2] GNU Bison Manual, §3.7.7 Freeing Discarded Symbols。意味値破棄をscope-dependentな実行時選択にしない設計上の比較対象。`https://www.gnu.org/software/bison/manual/html_node/Destructor-Decl.html`

[F1] Flex Manual, §10 Start Conditions。手動のBEGIN／start-condition stackとの比較対象。`https://westes.github.io/flex/manual/Start-Conditions.html`

[C1] Daveed Vandevoorde, N1757 / 05-0017, *Right Angle Brackets*, 2005-01-14。歴史的提案であり、現代C++全体の規範文書としては使用しない。`https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2005/n1757.html`

[P1] 保存済み設計`lrama_pslr_design(1).md`、2026-07-05、§5.7など。過去の構文案・導入方針の比較にのみ使用し、現在のコードの実装状態は[L1]–[L4]で区別した。
