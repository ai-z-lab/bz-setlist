#!/usr/bin/env node
// YouTube Data APIのOAuth初回認証。GoogleのDesktop OAuthクライアントJSONを読み、
// Refresh TokenなどをmacOSキーチェーンへ保存する。値は画面・ファイルへ出力しない。
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { KEYCHAIN_SERVICE, refreshYouTubeAccessToken } from "./lib/youtube.mjs";

const clientFile = process.argv[2];
if (!clientFile) {
  console.error("使い方: node scripts/setup-youtube-auth.mjs <ダウンロードしたclient_secret_*.json>");
  process.exit(1);
}
if (process.platform !== "darwin") {
  console.error("このスクリプトはmacOSキーチェーンへ保存します。macOSで実行してください。");
  process.exit(1);
}

const json = JSON.parse(await readFile(clientFile, "utf8"));
const client = json.installed || json.web;
if (!client?.client_id || !client?.client_secret) throw new Error("client_id / client_secret がJSONにありません。");
if (!json.installed) console.warn("注意: 「デスクトップアプリ」種類のOAuthクライアントJSONを推奨します。");

const state = randomBytes(16).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const code = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("認証が10分以内に完了しませんでした。")), 10 * 60 * 1000);
  server.on("request", (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const ok = !url.searchParams.get("error") && url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(`<meta charset="utf-8"><h1>${ok ? "認証完了" : "認証に失敗しました"}</h1><p>この画面を閉じてください。</p>`);
    clearTimeout(timeout);
    if (ok) resolve(url.searchParams.get("code"));
    else reject(new Error(url.searchParams.get("error") || "stateが一致しません。"));
  });
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.force-ssl",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  console.log("ブラウザでGoogleの認証画面を開きます。プレイリストを作成するアカウントを選び、許可してください。");
  // --incognito: 別アカウントのログイン状態を引き継がないようChromeのシークレットウィンドウで開く
  const openArgs = process.argv.includes("--incognito") ? ["-na", "Google Chrome", "--args", "--incognito", authUrl.toString()] : [authUrl.toString()];
  spawn("open", openArgs, { detached: true, stdio: "ignore" }).unref();
}).finally(() => server.close());

const response = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
});
const token = await response.json();
if (!response.ok || !token.refresh_token) throw new Error(`Refresh Tokenを取得できませんでした: ${token.error || response.status}`);

const values = { YOUTUBE_CLIENT_ID: client.client_id, YOUTUBE_CLIENT_SECRET: client.client_secret, YOUTUBE_REFRESH_TOKEN: token.refresh_token };
for (const [name, value] of Object.entries(values)) {
  execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value], { stdio: "ignore" });
}

const access = await refreshYouTubeAccessToken({});
const channel = await (await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${access}` } })).json();
console.log(`認証完了: キーチェーン「${KEYCHAIN_SERVICE}」へ保存しました。`);
console.log(`接続したYouTubeチャンネル: ${channel.items?.[0]?.snippet?.title || "(チャンネル未作成)"}`);
