[English](../README.md) · [한국어](./README.ko.md) · **日本語** · [简体中文](./README.zh-CN.md)

# ultracodex

> **Claude がオーケストレーションし、Codex がクロスチェックする。**
> Codex の headless（ヘッドレス）ノード（`codex exec`）を Claude Code 自身の Workflow
> （*ultracode*）オーケストレーションに組み込む。これにより、本当に異なるモデルファミリーが、
> 同一モデル同士の合意が最も信頼しにくい箇所で、検証し、判定し、疑いの目を向ける。

`ultracodex` はオープンソースの Claude Code プラグインであり、単一のスキル
`codex-workflow` を提供する。このスキルは、
[Codex](https://github.com/openai/codex) の headless ノードを **Workflow** に組み込む方法を
Claude に教える。Workflow とは、Claude Code の `agent()` / `pipeline()` / `parallel()`
オーケストレーションツール、すなわち *ultracode* のことだ。オーケストレーションのロジックは
Claude の JavaScript 内にとどまり、選択したノードで *誰が作業を行うか* だけが変わる。これが
**「Pattern A」** であり、既存の構成に追加するものであって、モデルを切り替えるものではない。両方のファミリーが
1 つの Workflow 内で動く。

```
Workflow (Claude JS orchestration)
 ├─ find / generate / synthesize .. Claude agent()  ← broad, fast, cache-warm
 └─ verify / judge / 2nd-opinion ... codex node     ← GPT, independent failure modes
```

> **GPT-5.6 対応済み。** 設計上モデル非依存であるため、GPT-5.6 世代
> （**Sol / Terra / Luna**、Codex CLI ≥ 0.144.0）はリリース当日に無変更で
> ultracodex 上で動作した。ドキュメントにはノード単位の**ティアと effort**の
> ガイダンスが追加された — 広い verify ファンアウトには安価なティアを、判定が
> 決定的なノードにはフラッグシップ（`max` まで、Sol/Terra では `ultra` も）を —
> 選択はオーケストレーションするモデルに委ねられる。

> **ultracode モードが必要。** このスキルは Workflow を *記述して実行する* ため、
> **Workflow** オーケストレーションツールが利用可能でなければならない。Claude Code においては、
> これは **ultracode モード** を意味する（`/effort` → ultracode で有効化すると、動的な
> ワークフローオーケストレーションがオンになる）。これがないとプラグイン自体は読み込まれてスキルも
> 見つかるが、駆動すべき Workflow ツールが存在しない。[前提条件](#prerequisites) を参照。

## なぜ存在するのか — その哲学

*同一の* モデルから検証者を増やしても、そのモデルの盲点を共有しがちであり、同じ
**相関した偽陽性（correlated false positives）** を互いに再確認するだけになる。異なるモデル
ファミリーは異なる入力で失敗するため、同一モデルのレビュアーなら追認してしまうものを反証できる。
これが核心となる発想だ。

- **置き換えではなく、多様性。** 利点は *独立したモデル間の不一致* から生まれる。だから目標は両方の
  ファミリーを 1 回の実行に残すことであり、Claude を外すことではない。「セカンドオピニオンを足す」
  は正しいが、「代わりに GPT を使う」は要点を外している。
- **独立した失敗モードは、同種を増やすことに勝る。** verify / judge ノードを Codex にルーティング
  することで *相関した* エラーを減らせる。これは、同じ箇所で失敗する Claude の検証者を N 個増やしても
  捕まえられない種類のエラーだ。
- **オーケストレーションは Claude にとどまる。** Claude がコンテキスト、スキーマ、ファンアウト、
  そして統合（synthesis）を保持する。codex ノードは通常の `agent()` にすぎず、そのサブエージェントが
  `codex exec` の実行を中継するだけだ。Workflow のプリミティブは何も変わらない。これはクロスモデルの
  価値を得るための、表面積の小さい手法である。
- **第二のモデルは真実の源（source of truth）ではない。** それは *もう一つの失敗モード分布* であり、
  テスト、エビデンス、厳格なスキーマ、そして最終的な Claude の統合と組み合わせるのが最善だ。
  「独立している」というのも相対的な話で、共有されたプロンプト、共有されたエビデンス、あるいは緩い
  スキーマは依然としてエラーを相関させ得る。だから Codex は、検証すべき検証可能な成果物がある場所で、
  意図的に使うこと。

## 得られるもの

- **同一モデルのレビューを生き延びた偽陽性を捕捉する** — 異なるモデルファミリーは、ある所見や主張に
  基づいて行動する前に、Claude の相関したエラーの *一部* を反証 *できる*（これは相関エラーの低減で
  あって、保証ではない）。
- **リスクの高い結論に対する、より信頼度の高い判定** — 重要な結果を、それを生み出していないモデルで
  クロスチェックしてから報告・出荷する。
- **真に多様な判定パネル** — どのモデルも自分の作業だけを判定することのない陪審で候補をスコアリング
  し、LLM-as-judge の構成における自己選好バイアスを削減する。
- **生成における真の解の多様性** — N 通りのパネルにおける Codex の試行は、別ファミリーの答えであり、
  Claude の答えを言い換えたものではない。
- **新たな仕組みなしの、大規模コンテキスト・複数ファイル検証** — Codex をツリーに向ける
  （`cwd` / `-C`; read-only は書き込みをブロックするが読み取りはブロックしない）と、大きな diff や
  ファイルを Codex 自身が読む。プロンプトに貼り付ける必要はない。
- **ノード単位のティア・effort ルーティング** — すべての codex ノードは `model` / `effort` を
  開かれた選択肢として受け取る：広い verify ファンアウトには `gpt-5.6-luna` + `low`、1 つの判定が
  決定的なら `gpt-5.6-sol` + `xhigh`/`max`（または `ultra`）。何もハードコードされず、
  オーケストレーションするモデルがノードごとに選ぶ。
- **コピペですぐ使える** — 4 つの完全な Workflow テンプレート（cross-model レビュー、混成判定パネル、
  単一結論のクロスチェック、loop-until-dry）に加え、正準的な `codexNode` ヘルパーを同梱。空ファイル
  からではなく、動くスクリプトから始められる。
- **変更範囲は最小限** — すべての Workflow プリミティブをそのまま保ち、選択したノードだけ担当を切り替える。

## 最も ROI の高い使い方: 敵対的検証

Claude が広く所見を見つけ、Codex が各所見の **反証** を試みる（確信が持てない場合は「反証された
（refuted）」をデフォルトとする）。生き残ったものは、異なるモデルファミリーが打ち崩せなかった所見だ。
パイプライン 1 本で済み、特別な障壁はない。

```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.findPrompt, { phase: 'Find', schema: FINDINGS }),         // Claude finds
  review => parallel((review?.findings ?? []).map(f => () =>
    codexNode(`Adversarially verify, defaulting to refuted=true if uncertain:\n${f.title}\n${f.detail}`,
      { schema: VERDICT, phase: 'Verify', label: `codex:${f.id}` })       // Codex refutes
      .then(v => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean)
  .filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false)
```

混成 **判定パネル** と単一結論の **セカンドオピニオン** は次の段階だ。完全なスクリプトは
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md)
にある。

## 使うべきとき — そして使わないべきとき

cross-model はシグナルだが、タダのシグナルではない。*第二の独立したモデル* が結果のリスクを実質的に
下げるとき — 所見の検証、候補の判定、パネルにおける独立した試行、リスクの高い結論の妥当性確認 — に
codex ノードに手を伸ばすこと。

**次の場合はブレンドを見送る。**

- 大量処理のスループット作業のとき（Claude のサブエージェントの方が安く、速く、cache-warm だ）。
- **相関したチェック** のとき — Codex は同じエビデンスから再導出するだけで、セカンドオピニオンでは
  なくエコーになる。
- **盲目的なチェック** のとき — そのノードでは、Codex が独立して検証するのに必要なものを与えられない。
- 検証可能・判定可能な成果物がないとき（自由形式のアイデア出し）— 多様性はシグナルではなくノイズを
  足してしまう。

## 前提条件

- **ultracode モード — Workflow ツール。** このスキルは Workflow を *記述して実行する* ため、
  **Workflow** ツール（`agent()`/`pipeline()`/`parallel()`）が利用可能でなければならない。
  Claude Code においてそれは **ultracode モード** を意味する。`/effort` → ultracode で有効化する
  （xhigh + 動的ワークフローオーケストレーション）。このスキルは Workflow を *記述する* ための
  ノウハウを提供するだけで、ツール自体を **追加しない**。だから ultracode モードがなければ、駆動する
  対象が何もない。
- **インストール済みかつ認証済みの Codex CLI。** 確認してから、ログインする（対話形式で、headless
  では実行できない）。
  ```bash
  command -v codex && codex --version
  codex login
  ```
- 中継ノード用の **POSIX シェル**（`bash`/`zsh`）。

> このスキルは Codex のバージョンやデフォルトモデルを **一切** ハードコードしない。環境はそれぞれ
> 異なるからだ。代わりに、安価な **preflight**（CLI の存在、認証の有効性、構造化出力のパス）を同梱し、
> どのノードを信頼する前にも一度実行できるようにしている。

## インストール

`ultracodex` はそれ自体が単一プラグインのマーケットプレイスだ。追加し、プラグインをインストールし、
リロードする。

```text
/plugin marketplace add KingGyuSuh/ultracodex
/plugin install ultracodex@ultracodex
/reload-plugins
```

非対話（CLI）での同等手順:

```bash
claude plugin marketplace add KingGyuSuh/ultracodex
claude plugin install ultracodex@ultracodex
# then restart Claude Code, or run /reload-plugins in an existing session
```

> インストール時の `@ultracodex` というサフィックスはマーケットプレイスの **名前**
> （`.claude-plugin/marketplace.json` のトップレベル `name`）であり、リポジトリ名とは独立している。
> ここではたまたま一致しているだけだ。

### インストールせずに試す

```bash
claude --plugin-dir ./plugins/ultracodex
```

## 使い方

第二のモデルをループに組み込んだカスタム Workflow としてタスクを実行するよう Claude に頼むと、
スキルは自動的に起動する。起動させる言い回しの例は以下のとおり。

- "Run this as a custom workflow that mixes in codex."
- "Have codex adversarially verify the findings."
- "Use codex as a juror / second opinion in the workflow."
- "Cross-model verify this while you orchestrate."

すると Claude は、verify / judge ノードが `codex exec` にシェルアウトし、find / generate /
synthesize は Claude 上にとどまる Workflow を、テンプレートを起点に記述する。

## 仕組み — codex ノード

Workflow スクリプトの JS 本体には **ファイルシステムへのアクセスがない**。そのため codex ノードは
自身の JSON Schema を文字列として埋め込み、Bash を実行できるラッパーサブエージェントにそれを一時
ファイルへ書き出させる。1 つの `schema` オブジェクトが唯一の真実の源（single source of truth）と
なり、Codex の `--output-schema` に渡されると同時に、`revalidate` が true のときは `agent()` の
再検証にも使われる。デフォルトの `revalidate: true` ではノードはパース済みオブジェクトを返し、
`revalidate: false` では呼び出し側が `JSON.parse` するための生の JSON テキストを中継する。
その契約は次のとおり。

```
codexNode(taskText, { schema, sandbox='read-only', model, cwd, effort, revalidate=true, phase, label })
  → Promise<parsedObject>   // revalidate:true (default)
  → Promise<string>         // revalidate:false — you JSON.parse it
  → { _codex_error: true }  // on failure
```

3 つのルールが要（load-bearing）となる。

1. **ソルバーではなく、リレー。** ラップしている Claude サブエージェントは賢いため、ただ自分で質問に
   答えてしまいたくなる。そうすると cross-model ノードがこっそり Claude ノードへと退化してしまう。
   プロンプトはこれを禁じている。フルの強度のまま保つこと。
2. **stdout ではなく `-o` ファイルから抽出する。** stdout にはセッションの装飾（chrome）が混ざる。
   `-o` がクリーンな JSON を得る唯一のパスだ。
3. **プロンプトは stdin で渡す**（`- < "$TASK"`）。これでクォート、`$`、バッククォートが壊れたり
   展開されたりしない。

コピペ可能な完全なヘルパーは、正準的には
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md)
にある。メカニクス、フラグ、sandbox の階層、トラブルシューティング、エスカレーションのパターンは
[`codex-headless.md`](./plugins/ultracodex/skills/codex-workflow/references/codex-headless.md) にある。

### ルーティング: Codex ノード vs Claude ノード

| ノードの仕事 | 実行先 | 理由 |
| --- | --- | --- |
| Find / generate / 広く探索する | **Claude** | 速く、cache-warm で、安価なファンアウト |
| 所見を敵対的に検証する | **Codex** | 異なる失敗モードが相関した偽陽性を減らせる |
| 候補を判定 / スコアリングする | **Codex**（または混成パネル） | その候補を書いていない陪審員 |
| 多様なパネルでの 1 回の試行 | **mix** | 真の解の多様性であって、Claude の言い換えではない |
| 統合 / 決定 / 報告書作成 | **Claude** | オーケストレーションのコンテキストを保持している |

## コスト、並行性、エスカレーション

- **課金対象は 2 つある。** すべての codex ノードでは、Anthropic のラッパーのターン *に加えて* Codex/OpenAI
  の実行にも料金が発生する。ラッパーは中継するだけだが、それでもサブエージェントとしての固定オーバーヘッドが
  ある。気軽に何百ものファンアウトをしないこと。代わりに小さな項目を **バッチ** にまとめる。
- **codex ノードは短く保つ。** 各ノードは、ラッパーがブロッキングする Bash 呼び出しでアイドル状態に
  なっている間、Codex の全実行時間にわたって Workflow の並行スロット（`min(16, cores−2)`）を 1 つ
  占有する。read-only の verify / judge / 小規模生成のみに使うこと。
- **長い作業はエスカレートする。** 数分から数時間に及ぶ、並列、あるいは再開可能な Codex ジョブは
  Pattern A では **ない**。バックグラウンドのワーカープール、または単発のハンドオフ（スキル内で説明）を
  使うこと。Workflow 内の長いノードは決して使わない。

## 同梱物

単一のスキル `codex-workflow`:

- **`SKILL.md`** — メンタルモデル、`codexNode` の契約、要となるルール、ルーティング、
  コスト / 並行性、そして preflight。
- **`references/codex-headless.md`** — `codex exec` のフラグ、sandbox の階層、出力の抽出、
  落とし穴、トラブルシューティング、`_codex_error` の運用規律、そしてエスカレーションのパターン。
- **`references/workflow-templates.md`** — 正準的な `codexNode` ヘルパーと 4 つの完全な Workflow
  スクリプト、加えてバッチノードと大容量ペイロードのバリアント。

```
ultracodex/                              # repo root = marketplace root
├── .claude-plugin/
│   └── marketplace.json                 # single-plugin marketplace catalog
├── plugins/
│   └── ultracodex/                      # the plugin
│       ├── .claude-plugin/
│       │   └── plugin.json              # plugin manifest
│       ├── README.md
│       └── skills/
│           └── codex-workflow/
│               ├── SKILL.md
│               └── references/
│                   ├── codex-headless.md
│                   └── workflow-templates.md
├── docs/                                # README translations (ko / ja / zh-CN)
├── LICENSE                              # Apache-2.0
├── NOTICE
└── README.md
```

スコープは意図的に **スキルのみ** に絞っている。コマンド、エージェント、フック、MCP サーバーは含まない。

## 開発

```bash
claude plugin validate ./plugins/ultracodex   # plugin manifest + skill frontmatter
claude plugin validate .                       # marketplace manifest
claude plugin tag ./plugins/ultracodex         # cut a release tag (manifests must agree)
```

## 謝辞

`codex-workflow` スキルは、同名のリポジトリ内プライベートスキルをオープンソース化して一般化した
ものだ。本リリースでは環境固有の事実（代わりに preflight する）とプライベートなパス参照を取り除いて
おり、開発そのものも、プラグイン自身のブレンドされた Claude+Codex ワークフローを使って行い、
クロスチェックした。この README も、クロスモデルで起草・校正されている。

## ライセンス

[Apache-2.0](./LICENSE) © 2026 KingGyuSuh
