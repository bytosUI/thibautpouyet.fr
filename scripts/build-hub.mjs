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
  const videos = [];
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
    const entry = extractAll(xml, 'entry')[0];
    if (!entry) continue;
    const videoId = extractOne(entry, 'yt:videoId');
    const title = decodeEntities(extractOne(entry, 'title') || '');
    const published = extractOne(entry, 'published');
    if (!videoId || !title) continue;
    videos.push({
      title,
      channel: channelName,
      channelHandle: ch.handle,
      videoId,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: published,
    });
    await sleep(250);
  }
  videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return { videos };
}

// ── Films (TMDB "now playing" — à l'affiche en France) ─────────
async function fetchFilms(cfg, apiKey) {
  if (!apiKey) {
    console.warn('[films] skipped — missing TMDB_API_KEY');
    return { top5: [] };
  }
  const url = `https://api.themoviedb.org/3/movie/now_playing?api_key=${apiKey}`
    + `&language=${encodeURIComponent(cfg.language)}&region=${encodeURIComponent(cfg.region)}&page=1`;
  const res = await safeFetch(url, {}, 'tmdb-now-playing');
  if (!res) return { top5: [] };
  const data = await res.json();
  const results = (data.results || []).filter((m) => m.poster_path).slice(0, cfg.limit);
  return {
    top5: results.map((m) => ({
      title: m.title,
      year: m.release_date ? m.release_date.slice(0, 4) : null,
      poster: `https://image.tmdb.org/t/p/w342${m.poster_path}`,
      url: `https://www.themoviedb.org/movie/${m.id}`,
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

// ── Météo (Open-Meteo, no key) ──────────────────────────────────
async function fetchWeather(cfg) {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${cfg.latitude}&longitude=${cfg.longitude}`
    + `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m`
    + `&daily=temperature_2m_max,temperature_2m_min,weather_code`
    + `&timezone=${encodeURIComponent(cfg.timezone)}&forecast_days=4`;
  const res = await safeFetch(url, {}, 'open-meteo');
  if (!res) return null;
  const d = await res.json();
  const c = d.current, daily = d.daily;
  const forecast = [];
  for (let i = 0; i < (daily?.time?.length || 0); i++) {
    forecast.push({
      date: daily.time[i],
      code: daily.weather_code[i],
      tmax: Math.round(daily.temperature_2m_max[i]),
      tmin: Math.round(daily.temperature_2m_min[i]),
    });
  }
  return {
    city: cfg.city,
    current: {
      temp: Math.round(c.temperature_2m),
      feelsLike: Math.round(c.apparent_temperature),
      code: c.weather_code,
      wind: Math.round(c.wind_speed_10m),
      humidity: c.relative_humidity_2m,
    },
    forecast,
  };
}

// ── Translation (MyMemory, no key) ──────────────────────────────
async function translateEnToFr(text) {
  if (!text) return text;
  const res = await safeFetch(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr`,
    {},
    'translate-mymemory',
  );
  if (!res) return text;
  try {
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated) return text;
    // MyMemory sometimes returns error strings as translatedText
    if (/QUERY LENGTH LIMIT|MYMEMORY WARNING|INVALID/i.test(translated)) return text;
    return decodeEntities(translated);
  } catch {
    return text;
  }
}

// ── Hacker News (official Firebase API) ─────────────────────────
async function fetchHackerNews(limit) {
  const topRes = await safeFetch(
    'https://hacker-news.firebaseio.com/v0/topstories.json',
    {},
    'hn-top',
  );
  if (!topRes) return { items: [] };
  const ids = (await topRes.json()).slice(0, limit);
  const items = [];
  for (const id of ids) {
    const itemRes = await safeFetch(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
      {},
      `hn-item-${id}`,
    );
    if (!itemRes) continue;
    const it = await itemRes.json();
    if (!it || !it.title) continue;
    const storyUrl = it.url || `https://news.ycombinator.com/item?id=${it.id}`;
    let source = 'news.ycombinator.com';
    try { source = new URL(storyUrl).hostname.replace(/^www\./, ''); } catch {}
    const isoDate = it.time ? new Date(it.time * 1000).toISOString() : null;
    const titleFr = await translateEnToFr(it.title);
    items.push({
      title: titleFr,
      titleOriginal: it.title,
      url: storyUrl,
      source,
      score: it.score || 0,
      comments: it.descendants || 0,
      hnUrl: `https://news.ycombinator.com/item?id=${it.id}`,
      date: fmtRelativeFR(isoDate),
    });
    await sleep(150);
  }
  return { items };
}

// ── NBA (ESPN public API, no key) ───────────────────────────────
const NBA_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const NBA_STANDINGS_URL = 'https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings'
  + '?region=us&lang=en&contentorigin=espn&type=0&level=3';

function ymdInTZ(date, tz = 'America/New_York') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function shiftDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function parseNbaGame(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === 'home');
  const away = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const status = comp.status?.type || ev.status?.type || {};
  const isPlayoff = ev.season?.type === 3;
  const mapTeam = (t) => ({
    id: t.team?.id || null,
    abbr: t.team?.abbreviation || '',
    name: t.team?.shortDisplayName || t.team?.displayName || '',
    logo: t.team?.logo || null,
    score: t.score != null ? Number(t.score) : null,
    record: t.records?.[0]?.summary || null,
    winner: t.winner === true,
  });
  let series = null;
  if (comp.series && comp.series.type === 'playoff') {
    const winsById = Object.fromEntries((comp.series.competitors || []).map((c) => [c.id, c.wins ?? 0]));
    series = {
      summary: comp.series.summary || null,
      completed: comp.series.completed === true,
      round: comp.notes?.[0]?.headline || null,
      winsHome: winsById[home.team?.id] ?? 0,
      winsAway: winsById[away.team?.id] ?? 0,
    };
  }
  return {
    id: ev.id,
    date: ev.date,
    isPlayoff,
    state: status.state || 'pre',
    statusShort: status.shortDetail || status.detail || '',
    completed: status.completed === true,
    home: mapTeam(home),
    away: mapTeam(away),
    series,
  };
}

async function fetchNbaScoreboard(dateYmd) {
  const qs = new URLSearchParams();
  if (dateYmd) qs.set('dates', dateYmd);
  const res = await safeFetch(`${NBA_BASE}/scoreboard?${qs}`, {}, `nba-scoreboard-${dateYmd || 'today'}`);
  if (!res) return null;
  const data = await res.json();
  return { games: (data.events || []).map(parseNbaGame).filter(Boolean) };
}

async function fetchNbaResults() {
  // Walk back from yesterday to find the most recent matchday (max 6 days).
  const now = new Date();
  for (let i = 1; i <= 6; i++) {
    const d = shiftDays(now, -i);
    const sb = await fetchNbaScoreboard(ymdInTZ(d));
    if (sb && sb.games.length > 0) {
      return { date: ymdInTZ(d), games: sb.games };
    }
    await sleep(120);
  }
  return { date: null, games: [] };
}

async function fetchNbaStandings() {
  const res = await safeFetch(NBA_STANDINGS_URL, {}, 'nba-standings');
  if (!res) return null;
  const data = await res.json();
  const conferences = (data.children || []).map((conf) => {
    const entries = (conf.standings?.entries || []).map((entry) => {
      const stats = Object.fromEntries((entry.stats || []).map((s) => [s.name, s]));
      return {
        rank: stats.playoffSeed?.value ?? stats.rank?.value ?? null,
        team: entry.team?.abbreviation || '',
        teamName: entry.team?.shortDisplayName || entry.team?.displayName || '',
        logo: entry.team?.logos?.[0]?.href || null,
        wins: stats.wins?.value ?? null,
        losses: stats.losses?.value ?? null,
        pct: stats.winPercent?.displayValue ?? null,
        gb: stats.gamesBehind?.displayValue ?? null,
      };
    });
    entries.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    return {
      name: conf.shortName || conf.name || '',
      teams: entries,
    };
  });
  return { conferences };
}

function roundOrder(headline) {
  if (!headline) return 9;
  const h = headline.toLowerCase();
  if (h.includes('finals') && !h.includes('conference')) return 4;
  if (h.includes('conference finals') || h.includes('conf finals')) return 3;
  if (h.includes('semifinals') || h.includes('2nd round')) return 2;
  if (h.includes('1st round') || h.includes('first round')) return 1;
  return 9;
}

function roundLabelFR(headline) {
  if (!headline) return '';
  const h = headline.toLowerCase();
  let stage = '';
  if (h.includes('finals') && !h.includes('conference')) stage = 'Finales NBA';
  else if (h.includes('conference finals')) stage = 'Finales de conférence';
  else if (h.includes('semifinals') || h.includes('2nd round')) stage = 'Demi-finales';
  else if (h.includes('1st round') || h.includes('first round')) stage = '1er tour';
  if (h.startsWith('east')) return stage ? `Est · ${stage}` : 'Est';
  if (h.startsWith('west')) return stage ? `Ouest · ${stage}` : 'Ouest';
  return stage;
}

async function fetchNbaPlayoffs() {
  // Walk back ~30 days, collect unique playoff series (deduped by team-pair).
  // Each event already carries series.summary + wins, no manual aggregation.
  const now = new Date();
  const seriesMap = new Map();
  for (let i = 0; i <= 30; i++) {
    const d = ymdInTZ(shiftDays(now, -i));
    const sb = await fetchNbaScoreboard(d);
    for (const g of (sb?.games || [])) {
      if (!g.isPlayoff || !g.series) continue;
      if (!g.home.abbr || !g.away.abbr) continue;
      const key = [g.home.abbr, g.away.abbr].sort().join('-');
      if (seriesMap.has(key)) continue; // first hit going backwards from today = freshest state
      seriesMap.set(key, {
        teamHome: { abbr: g.home.abbr, name: g.home.name, logo: g.home.logo },
        teamAway: { abbr: g.away.abbr, name: g.away.name, logo: g.away.logo },
        winsHome: g.series.winsHome,
        winsAway: g.series.winsAway,
        summary: g.series.summary,
        completed: g.series.completed,
        round: g.series.round,
        roundLabel: roundLabelFR(g.series.round),
        roundOrder: roundOrder(g.series.round),
        lastDate: g.date,
      });
    }
    await sleep(60);
  }
  const series = [...seriesMap.values()].sort((a, b) => {
    if (a.roundOrder !== b.roundOrder) return b.roundOrder - a.roundOrder; // later rounds first
    return new Date(b.lastDate) - new Date(a.lastDate);
  });
  return { series };
}

async function fetchNba() {
  const results = await fetchNbaResults();
  const isPlayoffs = results.games.some((g) => g.isPlayoff);
  const [standings, playoffs] = await Promise.all([
    isPlayoffs ? Promise.resolve(null) : fetchNbaStandings(),
    isPlayoffs ? fetchNbaPlayoffs() : Promise.resolve(null),
  ]);
  return {
    isPlayoffs,
    resultsDate: results.date,
    results: results.games,
    standings,
    playoffs,
  };
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

  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TMDB_API_KEY } = process.env;

  const [twitch, youtube, films, github, hackernews, weather, nba] = await Promise.all([
    fetchTwitch(config.twitch.users, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET),
    fetchYouTube(config.youtube.channels),
    fetchFilms(config.films, TMDB_API_KEY),
    fetchGithub(config.github.username),
    fetchHackerNews(config.hackernews.limit),
    fetchWeather(config.weather),
    fetchNba(),
  ]);

  const data = {
    updatedAt: new Date().toISOString(),
    weather,
    twitch,
    youtube,
    films,
    github,
    hackernews,
    nba,
  };

  await writeFile(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`[ok] wrote ${outPath}`);
  console.log(`     twitch live: ${twitch.live.length}/${config.twitch.users.length}`);
  console.log(`     youtube videos: ${youtube.videos.length}/${config.youtube.channels.length} channels`);
  console.log(`     films: ${films.top5.length}`);
  console.log(`     github commits: ${github.recent.length}`);
  console.log(`     hackernews items: ${hackernews.items.length}`);
  console.log(`     weather: ${weather ? `${weather.current.temp}° @ ${weather.city}` : 'unavailable'}`);
  console.log(`     nba: ${nba.results.length} games on ${nba.resultsDate || '?'}`
    + ` · ${nba.isPlayoffs ? `${nba.playoffs?.series?.length || 0} playoff series` : `standings ${nba.standings?.conferences?.length || 0} conf`}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
