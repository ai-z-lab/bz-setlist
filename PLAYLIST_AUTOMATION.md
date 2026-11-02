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
