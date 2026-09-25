<h1 align="center">Codex & Claude Code 用 ChatGPT Web — Enhanced</h1>

<p align="center">
  <strong>ChatGPT Web（Pro を含む）を Codex のネイティブモデルとして使用。</strong><br>
  モデルの利用枠を切り替えて、いつものワークフローを維持できます。
</p>

<p align="center">
  <a href="https://github.com/Evanlau1798/codex-chatgpt-web/releases/download/v6.0.0-Enhanced.1/codex-web-gpt-6.0.0-Enhanced.1-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/Evanlau1798/codex-chatgpt-web/releases/download/v6.0.0-Enhanced.1/codex-web-gpt-6.0.0-Enhanced.1-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/Evanlau1798/codex-chatgpt-web/releases/download/v6.0.0-Enhanced.1/codex-web-gpt-6.0.0-Enhanced.1-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/Evanlau1798/codex-chatgpt-web/releases/download/v6.0.0-Enhanced.1/codex-web-gpt-6.0.0-Enhanced.1-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/Evanlau1798/codex-chatgpt-web/releases/latest">すべてのリリース</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

> **開発候補版：`6.0.0-Enhanced.1`。** ダウンロードボタンは公開済みの Enhanced パッケージを指します。このブランチはリリース公開を意味しません。

<p align="center">
  <a href="TROUBLESHOOTING.md">トラブルシューティング</a> · <a href="SECURITY.md">セキュリティ</a> · <a href="CONTRIBUTING.md">コントリビューション</a>
</p>

<p align="center">
  <a href="https://github.com/Evanlau1798/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/Evanlau1798/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT ライセンス"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black?logo=apple" alt="macOS arm64 および x64">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows11" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x64-fcc624?logo=linux&logoColor=black" alt="Linux x64">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="API 料金なしの AI">
</p>

この独立管理の **Enhanced** fork は上流リリースを追跡し、長時間実行する Codex／Claude Code
タスク向けの Web セッションライフサイクルを追加します。fork のバージョンは
`<upstream>-Enhanced.<revision>` 形式で、`3.0.1-Enhanced.1` から始まりました。

Free および Go アカウントでは、Codex のネイティブモデル選択画面に
**ChatGPT Web — Luna** が追加されます。reasoning セレクターが表示されるアカウントでは、
サブスクリプションで利用可能な **Instant**、**Medium**、**High**、**Extra High**、**Pro** を使用できます。
ブリッジは、コンパイル済みの現在の Codex タスクコンテキストを新しい ChatGPT 一時チャットへ送り、
画像を添付し、表示される reasoning、ツールアクティビティ、Markdown を同じ Codex タスクへストリーミングします。

<p align="center">
  <img src="assets/demo.gif" alt="ネイティブ Codex ハーネスを使用する ChatGPT Web ターン" width="960">
</p>

```text
Codex タスク ──Responses + SSE──▶ codex-chatgpt-web ──内蔵ブラウザー──▶ ChatGPT
      ▲                                  │                              │
      └──── ネイティブ UI、コンテキスト、画像、トレース、ツールライフサイクル ────┘
```

Codex はネイティブのタスク、コンテキストライフサイクル、UI、ツールハーネスを維持します。
ローカル Responses ブリッジは、選択されたモデルのタスクだけをタスクに紐付いた ChatGPT 会話（既定では一時チャット）へルーティングします。
Full モードでは、次のコンパクション境界まで、MCP が ChatGPT を同じ Codex タスクのツールへ接続します。

1. **ランチャーをインストール**：上のボタンから、お使いの OS 向けのアプリをダウンロードします。
2. **ChatGPT にサインイン**：内蔵ブラウザーでログインし、ブラウザーのスモークテストを実行します。
3. **モデルをインストール**：Codex を一度再起動します。自動モードでは、名前の末尾が **(Web)** のモデルを選択します。Pro はバージョン別の項目、Sol の推論レベルは Effort で選択します。Zero Risk は専用の項目を引き続き使用します。
4. **ツールを使って開発する場合**：ランチャーの **MCP** を開き、下記の Full ハーネス設定を完了します。

## 主な特長

- **Codex のネイティブモデル。** ChatGPT Web は Codex のモデル選択画面から実行され、元のタスク UI、
  コンテキストライフサイクル、ストリーミング、トレース、ツール表示はそのまま維持されます。
- **MCP 経由の完全な Codex ハーネス。** Full モードでは、Pro を含め、サインイン中のアカウントで
  利用可能なすべての effort から、実行中タスクのファイルシステム、シェル、画像、承認、設定済みツール／アプリを使用できます。
- **継続的なタスクセッションとネイティブコンパクション。** 連続するメッセージは、タスクに紐付いた
  1 つのタスク会話を 30 分間再利用し、差分だけを送ります。既定では一時チャットを使用します。Codex Desktop は安定した native session key
  で会話を維持するため、毎ターン再構築される base instructions で TTL 内の tab は破棄されません。
  現在の developer／environment 更新は差分に含まれます。安定した識別子を持たない client は system instructions
  の変更時に新しいチャットを開始します。コンテキスト境界に達すると、
  保持中のエージェントがチェックポイントを書き、
  その後 Codex が新しいチャットを開始します。チャットが閉じられていた場合は、正規の Codex 履歴がフォールバックになります。
- **1 つのクロスプラットフォームランチャー。** macOS、Windows、Linux 向けアプリが、サインイン、
  モデル設定、MCP ガイド、ヘルスチェック、安全な診断、Enhanced モードで最大 6 件のタスク紐付きブラウザータブを管理します。
- **Fail-closed 動作。** モデルやツールの欠落、ChatGPT UI の変更が発生した場合、ルートや機能を黙って切り替えず、
  明示的なエラーを返します。エンドツーエンドの対象範囲は
  [リリース検証](docs/release-validation.md)に記載されています。

一時チャットは ChatGPT のプライバシーモードであり、匿名化やローカル推論ではありません。
プロンプトは引き続き OpenAI によって処理され、アカウント設定および OpenAI の
[一時チャットポリシー](https://help.openai.com/en/articles/8914046-temporary-chat-faq)が適用されます。
このプロジェクトは非公式です。適用される OpenAI の利用規約とワークスペースポリシーを守る責任は利用者にあります。

## クイックスタート

デスクトップランチャーをインストールまたは更新します。既存のインストールを更新・修復する場合は、
ランチャーを終了して同じコマンドをもう一度実行してください。ChatGPT プロファイルとランチャー設定を保持したまま、
アプリケーションと内蔵ランタイムが置き換えられます。

**macOS または Linux**

```bash
curl -fsSL https://github.com/Evanlau1798/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/Evanlau1798/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

アプリ内で次の 3 項目を完了します。

1. 既定ではランチャー内でサインインします。Passkey が必要な場合は **Use Chrome for passkey** を選択します。
   Chrome で一時チャットを検証した後、ランチャーは非 partitioned の ChatGPT／OpenAI セッション Cookie のみを
   Electron の非公開プロファイルへ取り込み、composer を再検証します。
2. ブラウザーのスモークテストを実行します。
3. **Codex にインストール**または **Claude Code にインストール**を選び、使用するクライアントを再起動します。

セットアップ時に、ランチャーが現在のアカウントの ChatGPT コントロールを検出します。
Free/Go アカウントでは Luna のみが表示され、Pro はサインイン中のアカウントで利用可能な場合にのみ表示されます。
独立した **MCP** ページは任意で、ターミナルコマンドを使わずに Full ハーネスの設定を案内します。

パッケージ版ランチャーは、サインインと ChatGPT モデルのターンを内蔵ブラウザーで処理します。
モデル API キー、インストール済みの Chrome/Chromium、システムの Node/Bun、
プロジェクト管理のブラウザーダウンロードは不要です。

**ソースから実行**

```bash
git clone https://github.com/Evanlau1798/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

Zero Risk は ChatGPT ページを読み取ったり操作したりしません。モデルと `Codex Zero Risk` コネクタを自分で選び、用意されたプロンプトを貼り付けて送信し、ランチャーで **Sent** を確認してください。名前の末尾が **(Web)** の自動モデルでは、対応する Effort を Codex で選択できます。コンテキスト上限を維持するため、Instant と各 Pro バージョンは別の項目になります。既存のタスクに保存された旧モデル項目は、従来の固定モードを維持します。

この方法には Bun 1.4.0 が必要です。コマンドはロックされた依存関係をインストールしてアプリを開きます。

## モード

| モード | モデル | ローカル Codex ツール | 追加設定 |
| --- | --- | --- | --- |
| **Browser-only** | Free/Go: Luna、Plus: Instant～High、Pro: Extra High と Pro を追加 | なし。Codex が警告を表示 | なし |
| **Full harness（自動操作）** | Free/Go: Luna、Plus: Instant～High、Pro: Extra High と Pro を追加 | Pro を含むすべての表示 effort で使用可能 | OpenAI トンネル + ChatGPT コネクタ |
| **Zero Risk** | ChatGPT のモデルと effort を手動選択。任意で Pro コンテキスト | 使用可能。ターン紐付き Codex harness を維持 | 個別 OpenAI トンネル + `Codex Zero Risk` コネクタ。貼り付けと送信は手動 |

新しい **(Web)** 項目は対応する Effort のみを公開し、Instant と各 Pro family は個別の context budget を維持します。
旧項目は固定モードを保持します。送信前に要求された family と effort を検証し、未対応の選択では明示的に失敗します。
Full モードでは、利用可能なすべての effort が同じターン紐付き MCP capability を受け取ります。
Pro 専用の制限や縮小されたツール契約はありません。

Zero Risk はローカル Responses bridge と完全な Codex harness を維持しますが、ChatGPT ページを
読み書きせず、プロンプトも自動送信しません。ランチャーはプロンプトの準備とコピーだけを行い、
モデル、effort、`Codex Zero Risk` コネクタ、貼り付け、送信は利用者が手動で行います。

Enhanced の自動ツールターンでは、**Web Agent 出力を MCP Tunnel 経由で転送** が既定で有効です。
利用者向けの進捗、reasoning summary、最終回答は既存の Native2 tunnel を通って返され、ChatGPT の
ツールカードは通常どおり表示されます。成功時はターン状態だけを継続監視し、tunnel に最終回答が
ない場合は、同じページで完了済みの応答を検証して prompt の再送は行いません。Enhanced を無効に
するか Zero Risk を選ぶと、設定値を保持したままこの転送経路を無効にします。

### 会話設定、Limits と API

**Save chats in ChatGPT** は既定で無効です。Codex／Claude のタスク会話を保存できますが、API の直接送信と native tool bridge は常に Temporary Chat を使い、`store:true` を拒否します。無効化しても既存の履歴は削除しません。

**New browser chat for each turn** は既定で無効で、Original Automatic のみで使用できます。Enhanced と Zero Risk では UI、launcher、config、adapter の各境界で無効にし、古い設定からの再有効化も防ぎます。履歴保存とは独立した設定です。

**Limits** は opt-in のローカル使用量推定で、公式の残り枠や Account Safety の代替ではありません。受理された実際の送信を一度だけ記録し、記録失敗による再送はしません。Zero Risk では自動のアカウント検査や追跡を行いません。
API `reasoning_effort` は新しい route の対応値だけを受け入れ、旧 route は固定の意味を維持します。同じ native Web generation のツール継続で有効な family／effort を変更できません。

### コンテキスト設定の違い

**Enhanced Web セッションモード**は、ツールラウンド、steering、compaction をまたいで 1 つの
タスク紐付き ChatGPT 会話を保持します。変更するのは会話の連続性だけで、コンテキストウィンドウを
拡大したり compaction を無効にしたりはしません。**Bigger Context** とは同時に有効化できません。
Bigger Context は合計 1、2、6 件のメッセージを使います。6 件の場合は 5 件のステージングと
1 件の最終実行メッセージです。各メッセージは実際の ChatGPT リクエストで、利用枠を消費する場合が
あります。Codex に公開するコンテキストと compaction しきい値は 3 倍になりますが、ChatGPT の
メッセージ、モデル、コンポーザー、転送、サービス上限は残ります。

**No Context Window** は、Codex が読むモデルカタログから ChatGPT Web のコンテキストウィンドウと
自動 compaction しきい値だけを取り除きます。無制限のコンテキストを作る機能ではなく、ChatGPT の
上限、Token 計測、サイズ超過時の fail-closed 動作は変わりません。別の仕組みが compaction を
意図的に管理する場合だけ使用してください。

## Full ハーネス

Full モードは、公式の [OpenAI tunnel-client](https://github.com/openai/tunnel-client) を通じて、
ChatGPT のツール呼び出しを現在の Codex タスクへ接続します。トンネルは外向きであり、公開 IP の露出、
受信ポートの開放、ルーターのポート転送は不要です。

> **Limits**
>
> **GPT-5.6 Sol Pro** と **GPT-6 Astra** の現在の ChatGPT メッセージ上限については、
> [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) を参照してください。
> Token コンテキスト上限は、アカウント種別と選択した effort によって異なります。Plus の
> Medium/High は実測 90,000-token ウィンドウを使用し、実験的な **3× context** を有効にすると
> 最大 270,000 tokens まで拡張されます。いずれの場合もネイティブ Codex compaction に対応します。

1. ランチャーの必須セットアップを完了します。
2. ランチャーで **MCP** を開きます。ChatGPT コネクタを使用するものと同じ OpenAI アカウントで
   Tunnel と通常の API キーを作成します。キーの作成は無料で、モデル API クレジットを消費しません。
3. Tunnel ID と API キーを貼り付け、**ハーネスを接続**を押します。
4. ChatGPT の設定で **Developer Mode** を有効にします。**Tunnel** を使う**新しい**コネクタを作成し、
   対象の Tunnel を選択して、**Authentication** を **None**、名前を正確に **Codex Native2** に設定します。
5. **Codex Native2** の **Permissions** で **Allow all actions** を選択します。
   **Allow low-risk actions** では、コマンドとパッチがこのランタイムへ到達する前にブロックされます。
   外側の Codex ハーネスでは、引き続きサンドボックスと承認が適用されます。
6. **ランタイムを検証**を実行し、**Codex Native2** が接続済みで利用可能であることを確認します。

書き込み／変更操作には、ChatGPT ワークスペースと管理者ポリシー側での許可も必要です。
[Developer Mode と MCP アプリ](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)を参照してください。
予期しない承認プロンプトは、`--auto-approve-tool-calls` が明示的に有効でない限り fail-closed になります。
このオプションが押すのは **Allow once** だけで、永続的な許可は付与しません。

## 運用

安全なローカル診断には **アクティビティ**、エンドツーエンドのヘルスチェックには
**設定 → 診断を実行**を使用します。設定から、保持中のブラウザーターンのキャンセルや、
アンインストール前の Codex 統合削除も行えます。すべてのブラウザーチェックポイントでスクリーンショットが必要な場合にのみ、
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` を設定してください。

新規インストールでは、クロスバックエンドのサブエージェントに **Compatibility V1** を使用します。
**Native** は Codex 独自の機能設定を維持し、プレーンテキストの Web-to-Web V2 delegation を有効にします。
プロトコル変更後は Codex を再起動し、新しいタスクを開始してください。

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

## 制限とセキュリティ

- これは非公式のブラウザー自動化であり、OpenAI API ではありません。ChatGPT UI の変更によりセレクターが壊れる可能性があります。
  差異が発生した場合、モデルや転送方式を黙って切り替えず、明示的に失敗します。
- ブラウザー状態は機密性の高いログイン情報です。また、loopback リスナーには同じローカルユーザーで動作する
  プロセスからアクセスできます。ランチャープロファイルを共有せず、信頼できるワークステーションを使用してください。
- リリースパッケージは現在、macOS 13+（arm64/x64）、Windows x64、Linux x64 を対象としています。
  ランタイム、テスト、パッケージングは CI で 3 プラットフォームすべてに対して検証されます。
  アカウント依存のブラウザー／MCP フローには、個別の[リリース検証](docs/release-validation.md)を使用します。
- ビルドはまだプラットフォーム署名されていないため、Gatekeeper または SmartScreen が警告を表示する場合があります。
  インストーラーは、インストール前に公開 SHA-256 マニフェストを検証します。

Full モードを有効にする前に、完全な[アーキテクチャ](docs/architecture.md)と
[セキュリティモデル](docs/security-model.md)をお読みください。脆弱性は [SECURITY.md](SECURITY.md) から報告してください。

## 開発

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` は `~/.codex-chatgpt-web-dev` に 2 つ目のランチャープロファイルを作成します。
Electron state、ブラウザーの cookie／ログイン、ChatGPT アカウント、設定、サンドボックス化された `CODEX_HOME`、
チャット、診断、broker、トンネルプロファイルは本番環境から分離されます。通常のランチャーと同時に実行でき、
Responses daemon の起動や Codex の変更は行いません。任意の Full セットアップでは、独立した ChatGPT コネクタ名
`Codex Native2 DEV` を使用し、隔離された MCP トンネルのみを起動・監視します。

`dev:chat` は名前付きの永続的な synthetic outer-Codex ハーネスです。現在の作業ツリーを、隔離されたランチャーの
ブラウザー、一時チャット、プロンプトコンパイラー、Responses parser、コンパクションハンドラーを通して実行します。
任意の Full セットアップでは MCP コネクタと broker も検証され、ツールの効果は明示的なシミュレーション結果になります。
Browser-only チャットは外側のツールを公開しません。Responses リスナーを開いたり、`openai_base_url` を変更したり、
稼働中 daemon を停止したり、ポート 17841 を使用したりすることもありません。
メッセージなしで実行すると、`/status`、`/fill 30000`、`/compact`、`/model`、`/reset` コマンドを使用できます。
**DEV** と表示されたウィンドウ内で一度サインインし、プロファイルを初期化してください。
シミュレーションツールのターンが必要な場合にのみ、任意の Full ハーネスを設定します。
ランチャーは DEV トンネルを使用可能な状態に保ち、名前付きチャットは必要に応じて broker を接続します。
本番の認証情報や `Codex Native2` コネクタが暗黙的に再利用されることはありません。
[DEV chat ハーネス](docs/dev-chat.md)を参照してください。

- [アーキテクチャ](docs/architecture.md)
- [DEV chat ハーネス](docs/dev-chat.md)
- [セキュリティモデル](docs/security-model.md)
- [トラブルシューティング](TROUBLESHOOTING.md)
- [コントリビューションガイド](CONTRIBUTING.md)

## Star の履歴

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star 履歴チャート" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

## 免責事項

これは独立したソフトウェアであり、OpenAI との提携や OpenAI による推奨を受けたものではありません。
ご自身のアカウントで、適用される[利用規約](https://openai.com/policies/terms-of-use/)と
ワークスペースポリシーに従って使用してください。認証やアクセス制御を回避するものではありません。
