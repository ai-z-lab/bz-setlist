# Spotify / YouTube Music プレイリスト自動化

公演のセットリスト登録後に、未作成のプレイリストを検出し、SpotifyとYouTube Music用のプレイリストを生成して`window.BZ_DATA.shows[].playlists`へリンクを戻す仕組みです。

## 安全設計

- 既存のプレイリストURLは上書きしません。
- 同じ曲順でも公演日ごとに別プレイリストを作成します。曲IDの検索結果だけを共用し、外部API呼び出しを抑えます。
- 曲の候補が一意に決まらない場合は、プレイリストを作らず`unresolved`として報告します。
- 途中までしか曲IDが解決できていないプレイリストは公開リンクとして登録しません。
- 作成済みプレイリストには`bz-setlist:<showId>`を記録し、再実行時の重複作成を防ぎます。
- `data/playlist-batch.json`に公演IDを指定すると、その公演だけを一括処理できます。
- GitHub更新は作業ブランチ、PR、squash mergeの順に行います。

## 現在の監査結果を確認

```bash
node scripts/playlist-plan.mjs --output=playlist-plan.json
```

ツアーを限定する場合：

```bash
node scripts/playlist-plan.mjs --tour="TMG SAYONARA"
```

## 認証設定

GitHub ActionsのRepository secretsへ次の値を登録します。トークンやシークレットをリポジトリへ直接保存しないでください。

### Spotify

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_REFRESH_TOKEN`

`https://ai-z-lab.github.io/bz-setlist/spotify-callback.html`を開き、Spotifyへ接続するとPKCE方式でRefresh Tokenを取得できます。Client Secretは不要です。SpotifyアプリのRedirect URIには同じURLを完全一致で登録してください。

Spotifyアプリには、公開プレイリストの場合`playlist-modify-public`、非公開プレイリストも扱う場合`playlist-modify-private`のOAuthスコープが必要です。

### YouTube / YouTube Music

- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

OAuthスコープは`https://www.googleapis.com/auth/youtube`または`https://www.googleapis.com/auth/youtube.force-ssl`を使用します。作成するプレイリストは初期状態で限定公開です。

#### ローカル実行（推奨・macOS）

1. Google Cloud ConsoleでYouTube Data API v3を有効化し、OAuthクライアント（デスクトップアプリ）のJSONをダウンロードします。
2. `node scripts/setup-youtube-auth.mjs <client_secret_*.json>` を実行し、ブラウザで許可します。認証情報はmacOSキーチェーン（`bz-setlist-youtube`）へ保存され、画面・ファイル・リポジトリには出力されません。
3. `node scripts/youtube-resolve.mjs --apply` で曲IDを解決します（検索APIは使わず、1アルバム約1ユニット）。YouTube Musicで手動保存した曲を使う場合は `--extra-playlist-title=<プレイリスト名>`、登録済みIDの再検証は `--verify-all` を付けます。

#### 曲IDの採用ルール（YouTube Music）

1. 公演アーティスト本人名義の公式配信音源を最優先します（B'z／B’z、稲葉浩志／Koshi Inaba、TMG／TAK MATSUMOTO GROUP、松本孝弘／Tak Matsumoto）。
2. 本人名義が複数ある場合も、曲名・アルバム・公式Topicチャンネルで照合します。
3. 本人名義の配信音源が無い場合だけ、原曲アーティスト版を採用します（例: TMGが演奏したMr. Big「To Be With You」）。
4. 採用するのは公式TopicチャンネルのArt Track（説明文が「Provided to YouTube by」）だけです。MV・ライブ映像・公式チャンネルの動画は採用せず、未解決として止めます。
5. 採用前に曲名・アーティスト・アルバム・再生時間（±3秒）を検証します。期待値はSpotifyの公開曲情報を使い、同名シングル収録の同一音源（再生時間が一致）だけはアルバム違いを許容します。

候補の探索順は、固定指定 → 手動保存プレイリスト → 登録アルバム → Topicのリリース一覧 → YouTubeの公開検索結果です。公開検索結果は候補IDの収集にだけ使い、採否は必ず公式APIで検証します。
4. `node scripts/playlist-sync.mjs --provider=youtubeMusic --show-ids=<公演ID,...> --apply` で作成します。

YouTube Data APIの既定クォータは1日10,000ユニットで、プレイリスト作成と1曲追加はそれぞれ50ユニットです。上限に達すると処理を止め、未完成のプレイリストはリンク登録しません。クォータ回復後（太平洋時間0時）に同じコマンドを再実行すると、`bz-setlist:<showId>`の目印で既存プレイリストを見つけ、不足分だけ追記します。

main更新時のActionsは`data/playlist-batch.json`の`provider`・`showIds`・`repairExisting`に従って適用します。YouTube Musicの作成はクォータ管理のためローカル実行を基本とし、batchの`provider`は`spotify`にしておきます。

YouTubeの自動候補選択は誤登録防止のため初期状態では無効です。検証済みの曲IDを`data/playlist-track-map.json`へ登録するか、Repository variable `YOUTUBE_AUTO_MATCH=true`を明示的に設定すると、厳密一致候補だけを自動採用します。

## 実行方法

GitHub Actionsの`Playlist sync`を手動実行できます。初回は`apply=false`で監査し、認証設定後に対象ツアーを限定して`apply=true`で試します。

毎日の自動適用はRepository variable `PLAYLIST_AUTO_APPLY=true`を設定した場合のみ有効になります。未設定時の定期実行は監査レポートを作るだけで、外部アカウントやGitHubデータを書き換えません。

## ローカルのドライラン

```bash
node scripts/playlist-sync.mjs --provider=both --tour="TMG SAYONARA"
```

実際に作成する場合：

```bash
node scripts/playlist-sync.mjs --provider=spotify --tour="TMG SAYONARA" --apply
```

結果は`playlist-sync-report.json`へ出力されます。
