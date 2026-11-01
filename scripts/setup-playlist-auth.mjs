#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const host = "127.0.0.1";
const port = 8787;
const spotifyRedirect = `http://${host}:${port}/spotify/callback`;
const googleRedirect = `http://${host}:${port}/google/callback`;
const rl = createInterface({ input, output });

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

async function exchange(url, params, basicAuth = "") {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (basicAuth) headers.authorization = `Basic ${Buffer.from(basicAuth).toString("base64")}`;
  const response = await fetch(url, { method: "POST", headers, body: new URLSearchParams(params) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error_description || json.error || `HTTP ${response.status}`);
  return json;
}

function waitForCallback(path, expectedState) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("認証が10分以内に完了しませんでした。")), 10 * 60 * 1000);
    const handler = (req, res) => {
      const url = new URL(req.url, `http://${host}:${port}`);
      if (url.pathname !== path) return false;
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const ok = !error && state === expectedState && Boolean(code);
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(`<meta charset="utf-8"><h1>${ok ? "認証完了" : "認証に失敗しました"}</h1><p>この画面を閉じてターミナルへ戻ってください。</p>`);
      clearTimeout(timeout);
      if (!ok) reject(new Error(error || "state/codeが一致しません。"));
      else resolve(code);
      return true;
    };
    callbacks.push(handler);
  });
}

const callbacks = [];
const server = createServer((req, res) => {
  if (callbacks.some((handler) => handler(req, res))) return;
  res.writeHead(404).end();
});

try {
  await new Promise((resolve, reject) => server.listen(port, host, resolve).once("error", reject));
  console.log("\nSpotify / YouTube Music 自動化の初回認証\n");
  console.log(`SpotifyアプリのRedirect URIには次を登録してください:\n${spotifyRedirect}\n`);

  const spotifyClientId = (await rl.question("Spotify Client ID: ")).trim();
  const spotifyClientSecret = (await rl.question("Spotify Client Secret: ")).trim();
  const googleClientId = (await rl.question("Google OAuth Desktop Client ID: ")).trim();
  const googleClientSecret = (await rl.question("Google OAuth Desktop Client Secret: ")).trim();
  if (![spotifyClientId, spotifyClientSecret, googleClientId, googleClientSecret].every(Boolean)) {
    throw new Error("4項目すべて入力してください。");
  }

  const spotifyState = randomBytes(16).toString("hex");
  const spotifyCodePromise = waitForCallback("/spotify/callback", spotifyState);
  const spotifyUrl = new URL("https://accounts.spotify.com/authorize");
  spotifyUrl.search = new URLSearchParams({
    client_id: spotifyClientId,
    response_type: "code",
    redirect_uri: spotifyRedirect,
    scope: "playlist-modify-public playlist-modify-private",
    state: spotifyState,
    show_dialog: "true",
  });
  console.log("\nSpotifyの認証画面を開きます。「同意する」を押してください。\n");
  openBrowser(spotifyUrl.toString());
  const spotifyCode = await spotifyCodePromise;
  const spotifyToken = await exchange("https://accounts.spotify.com/api/token", {
    grant_type: "authorization_code",
    code: spotifyCode,
    redirect_uri: spotifyRedirect,
  }, `${spotifyClientId}:${spotifyClientSecret}`);
  if (!spotifyToken.refresh_token) throw new Error("Spotify Refresh Tokenを取得できませんでした。");

  const googleState = randomBytes(16).toString("hex");
  const googleCodePromise = waitForCallback("/google/callback", googleState);
  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.search = new URLSearchParams({
    client_id: googleClientId,
    response_type: "code",
    redirect_uri: googleRedirect,
    scope: "https://www.googleapis.com/auth/youtube.force-ssl",
    access_type: "offline",
    prompt: "consent",
    state: googleState,
  });
  console.log("Googleの認証画面を開きます。YouTubeへのアクセスを許可してください。\n");
  openBrowser(googleUrl.toString());
  const googleCode = await googleCodePromise;
  const googleToken = await exchange("https://oauth2.googleapis.com/token", {
    client_id: googleClientId,
    client_secret: googleClientSecret,
    grant_type: "authorization_code",
    code: googleCode,
    redirect_uri: googleRedirect,
  });
  if (!googleToken.refresh_token) throw new Error("Google Refresh Tokenを取得できませんでした。");

  const secrets = [
    `SPOTIFY_CLIENT_ID=${spotifyClientId}`,
    `SPOTIFY_CLIENT_SECRET=${spotifyClientSecret}`,
    `SPOTIFY_REFRESH_TOKEN=${spotifyToken.refresh_token}`,
    `YOUTUBE_CLIENT_ID=${googleClientId}`,
    `YOUTUBE_CLIENT_SECRET=${googleClientSecret}`,
    `YOUTUBE_REFRESH_TOKEN=${googleToken.refresh_token}`,
    "",
  ].join("\n");
  await writeFile("playlist-secrets.local.txt", secrets, { encoding: "utf8", mode: 0o600 });
  console.log("\n認証完了。playlist-secrets.local.txt を作成しました。");
  console.log("このファイルの6項目をGitHub ActionsのRepository secretsへ登録してください。公開・共有はしないでください。\n");
} catch (error) {
  console.error(`\nエラー: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
  server.close();
}
