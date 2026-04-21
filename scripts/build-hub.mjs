#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── XML helpers (minimal regex parser for well-formed feeds) ────
const stripCdata = (s) => s?.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/m, '$1') ?? s;

function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function extractOne(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? stripCdata(m[1]).trim() : null;
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*/?>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function safeFetch(url, opts = {}, label = url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'bytosUI-hub/1.0' }, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    console.warn(`[warn] ${label}: ${err.message}`);
    return null;
  }
}

// ── Twitch ──────────────────────────────────────────────────────
async function getTwitchToken(clientId, clientSecret) {
  const res = await safeFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  }, 'twitch-oauth');
  if (!res) return null;
  const data = await res.json();
  return data.access_token;
}

async function fetchTwitch(users, clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    console.warn('[twitch] skipped — missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET');
    return { live: [], offline: users };
  }
  const token = await getTwitchToken(clientId, clientSecret);
  if (!token) return { live: [], offline: users };

  const headers = { 'client-id': clientId, authorization: `Bearer ${token}` };

  const streamsQs = users.map((u) => `user_login=${encodeURIComponent(u)}`).join('&');
  const streamsRes = await safeFetch(`https://api.twitch.tv/helix/streams?${streamsQs}`, { headers }, 'twitch-streams');
  const streams = streamsRes ? (await streamsRes.json()).data ?? [] : [];

  const usersQs = users.map((u) => `login=${encodeURIComponent(u)}`).join('&');
  const usersRes = await safeFetch(`https://api.twitch.tv/helix/users?${usersQs}`, { headers }, 'twitch-users');
  const usersData = usersRes ? (await usersRes.json()).data ?? [] : [];
  const byLogin = Object.fromEntries(usersData.map((u) => [u.login.toLowerCase(), u]));

  const live = streams
    .map((s) => {
      const u = byLogin[s.user_login.toLowerCase()];
      return {
        user: s.user_login,
        displayName: s.user_name,
        game: s.game_name || 'Streaming',
        viewers: s.viewer_count,
        avatar: u?.profile_image_url || null,
        url: `https://twitch.tv/${s.user_login}`,
      };
    })
    .sort((a, b) => b.viewers - a.viewers);

  const liveLogins = new Set(streams.map((s) => s.user_login.toLowerCase()));
  const offline = users.filter((u) => !liveLogins.has(u.toLowerCase()));

  return { live, offline };
}

// ── YouTube (RSS) ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchYouTube(channels) {
  const all = [];
  for (const ch of channels) {
    let res = await safeFetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`,
      {},
      `yt-${ch.handle}`,
    );
    // Retry once after a delay if YT rate-limited us
    if (!res) {
      await sleep(800);
      res = await safeFetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`,
        {},
        `yt-${ch.handle}-retry`,
      );
    }
    if (!res) continue;
    const xml = await res.text();
    const channelName = decodeEntities(extractOne(xml, 'title') || ch.handle);
    const entries = extractAll(xml, 'entry').slice(0, 3);
    for (const entry of entries) {
      const videoId = extractOne(entry, 'yt:videoId');
      const title = decodeEntities(extractOne(entry, 'title') || '');
      const published = extractOne(entry, 'published');
      if (!videoId || !title) continue;
      all.push({
        title,
        channel: channelName,
        channelHandle: ch.handle,
        videoId,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: published,
      });
    }
    await sleep(250);
  }
  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return {
    latest: all[0] || null,
    recent: all.slice(0, 4),
  };
}

// ── Films (static config + TMDB CDN) ────────────────────────────
function buildFilms(top5) {
  return {
    top5: top5.map((f) => ({
      title: f.title,
      year: f.year,
      poster: `https://image.tmdb.org/t/p/w342${f.posterPath}`,
      url: `https://www.themoviedb.org/movie/${f.tmdbId}`,
    })),
  };
}

// ── GitHub ──────────────────────────────────────────────────────
async function fetchGithub(username) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const reposRes = await safeFetch(
    `https://api.github.com/users/${username}/repos?sort=pushed&per_page=5&type=owner`,
    { headers },
    `gh-repos-${username}`,
  );
  if (!reposRes) return { recent: [] };
  const repos = await reposRes.json();

  const commits = [];
  for (const repo of repos.slice(0, 3)) {
    const commitsRes = await safeFetch(
      `https://api.github.com/repos/${repo.full_name}/commits?author=${username}&per_page=2`,
      { headers },
      `gh-commits-${repo.full_name}`,
    );
    if (!commitsRes) continue;
    const list = await commitsRes.json();
    for (const c of list) {
      commits.push({
        repo: repo.full_name,
        message: c.commit.message.split('\n')[0].slice(0, 100),
        time: fmtRelativeFR(c.commit.author?.date),
        publishedAt: c.commit.author?.date,
        url: c.html_url,
      });
    }
  }
  commits.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return { recent: commits.slice(0, 5).map(({ publishedAt, ...rest }) => rest) };
}

// ── Veille (RSS) ────────────────────────────────────────────────
async function fetchVeille(feeds) {
  const all = [];
  for (const feed of feeds) {
    // Some feeds (e.g. 01net) return the RSS in the body of a 301; accept 2xx/3xx with body.
    let res;
    try {
      res = await fetch(feed.url, {
        headers: { 'user-agent': 'bytosUI-hub/1.0', 'accept': '*/*' },
        redirect: 'manual',
      });
    } catch (err) {
      console.warn(`[warn] rss-${feed.source}: ${err.message}`);
      continue;
    }
    const xml = await res.text();
    if (!xml.includes('<item') && !xml.includes('<entry')) {
      console.warn(`[warn] rss-${feed.source}: no items found (HTTP ${res.status})`);
      continue;
    }
    const items = extractAll(xml, 'item').slice(0, 4);
    for (const it of items) {
      const title = decodeEntities(extractOne(it, 'title') || '');
      const link = decodeEntities(extractOne(it, 'link') || '');
      const pubDate = extractOne(it, 'pubDate');
      if (!title || !link) continue;
      all.push({
        source: feed.source,
        title,
        url: link,
        date: fmtRelativeFR(pubDate),
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      });
    }
  }
  all.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  return { items: all.slice(0, 4) };
}

// ── Utilities ───────────────────────────────────────────────────
function fmtRelativeFR(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 172800) return 'hier';
  if (diff < 604800) return `il y a ${Math.floor(diff / 86400)} j`;
  return `il y a ${Math.floor(diff / 604800)} sem`;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const configPath = resolve(__dirname, 'config.json');
  const outPath = resolve(ROOT, 'bento/data.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));

  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;

  const [twitch, youtube, github, veille] = await Promise.all([
    fetchTwitch(config.twitch.users, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET),
    fetchYouTube(config.youtube.channels),
    fetchGithub(config.github.username),
    fetchVeille(config.veille.feeds),
  ]);

  const films = buildFilms(config.films.top5);

  const data = {
    updatedAt: new Date().toISOString(),
    twitch,
    youtube,
    films,
    github,
    veille,
  };

  await writeFile(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`[ok] wrote ${outPath}`);
  console.log(`     twitch live: ${twitch.live.length}/${config.twitch.users.length}`);
  console.log(`     youtube latest: ${youtube.latest?.title ?? 'none'}`);
  console.log(`     github commits: ${github.recent.length}`);
  console.log(`     veille items: ${veille.items.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
