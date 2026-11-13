# YouTube Raid Auto Shoutout (Tampermonkey版) インストールガイド

Chrome拡張機能（Manifest V3）版と同等の機能を、単一のユーザースクリプト（`yt-raid-auto-shoutout.user.js`）に統合したバージョンです。

## ファイル構成

```text
yt-raid-auto-shoutout-userscript/
├── yt-raid-auto-shoutout.user.js
└── INSTALL_GUIDE.md
```

## インストール手順

1. **Tampermonkey の導入**
   - ブラウザ（Chrome / Edge / Brave / Firefox 等）に [Tampermonkey](https://www.tampermonkey.net/) 拡張機能をインストールします。
2. **新規スクリプトの作成**
   - Tampermonkey アイコンをクリックし、「新規スクリプトを作成...」を選択します。
   - エディタ内の既存テンプレートをすべて削除し、`yt-raid-auto-shoutout.user.js` の中身をすべて貼り付けて保存（`Ctrl+S` / `Cmd+S`）します。
   - （または、ローカルファイルをドラッグ＆ドロップして Tampermonkey に読み込むことも可能です）
3. **権限の確認**
   - スクリプトは `https://www.youtube.com/live_chat*` および `https://studio.youtube.com/live_chat*` 上で動作し、`@handle` URL 解決のために `GM_xmlhttpRequest` で `www.youtube.com` へ通信します（初回アクセス時に Tampermonkey がドメイン接続許可を求める場合は「常に許可」を選択してください）。

## 使い方

1. YouTube にログインした状態で、ライブ配信ページまたは YouTube Studio のライブ配信管理画面を開き、ライブチャットを表示します。
2. チャット欄右下に表示される **「Raid設定」** ボタン（または Tampermonkey メニューの **「⚙️ Raid Auto Shoutout 設定」**）をクリックして設定モーダルを開きます。
3. 以下の設定を調整できます：
   - **ON / OFF**: 自動投稿の有効・無効切り替え
   - **投稿メッセージテンプレート**: `{channel}`（紹介元チャンネル名）、`{url}`（`https://www.youtube.com/@...`）が利用可能（200文字制限対応）
   - **投稿遅延（秒） / 重複防止（秒）**
   - **テストモード**: チャットへ送信せず検知履歴のみ記録
   - **テスト投稿ボタン**: 現在のライブチャット欄で動作テストを実行
   - **検知・投稿履歴**: 直近50件のログ確認・クリア

## Chrome拡張機能版からの主な移植ポイント

- `injected.js` + `content.js`: `unsafeWindow` を介した `fetch` / `XMLHttpRequest` / `ytInitialData` フックと `MutationObserver` を単一スクリプトに統合
- `background.js`: `GM_xmlhttpRequest`（`@connect www.youtube.com`）によるクロスオリジン対応 `@handle` 解決、および `GM_getValue` / `GM_setValue` による設定・履歴の永続化に置換
- `popup.*`: YouTube の Trusted Types CSP に完全準拠した DOM 生成によるページ内設定モーダル＆Tampermonkey メニューコマンドへ統合
