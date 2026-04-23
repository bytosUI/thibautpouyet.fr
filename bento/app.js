const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtViewers = (n) => {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};

const fmtRelative = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `il y a ${Math.floor(diff / 86400)} j`;
  return `il y a ${Math.floor(diff / 604800)} sem`;
};

const slot = (name) => $(`[data-slot="${name}"] [data-content]`);

const WMO_ICON = (code) => {
  if (code === 0 || code === 1) return 'mdi:weather-sunny';
  if (code === 2) return 'mdi:weather-partly-cloudy';
  if (code === 3) return 'mdi:weather-cloudy';
  if (code === 45 || code === 48) return 'mdi:weather-fog';
  if (code >= 51 && code <= 57) return 'mdi:weather-partly-rainy';
  if (code >= 61 && code <= 65) return 'mdi:weather-rainy';
  if (code === 66 || code === 67) return 'mdi:weather-snowy-rainy';
  if (code >= 71 && code <= 77) return 'mdi:weather-snowy';
  if (code >= 80 && code <= 82) return 'mdi:weather-pouring';
  if (code === 85 || code === 86) return 'mdi:weather-snowy-heavy';
  if (code >= 95) return 'mdi:weather-lightning';
  return 'mdi:weather-partly-cloudy';
};

const WMO_LABEL = (code) => {
  if (code === 0) return 'Ciel dégagé';
  if (code === 1) return 'Ciel clair';
  if (code === 2) return 'Partiellement nuageux';
  if (code === 3) return 'Nuageux';
  if (code === 45 || code === 48) return 'Brouillard';
  if (code >= 51 && code <= 57) return 'Bruine';
  if (code >= 61 && code <= 65) return 'Pluie';
  if (code === 66 || code === 67) return 'Pluie verglaçante';
  if (code >= 71 && code <= 77) return 'Neige';
  if (code >= 80 && code <= 82) return 'Averses';
  if (code === 85 || code === 86) return 'Averses de neige';
  if (code >= 95) return 'Orage';
  return '';
};

const WEEKDAY_FR = (iso) => {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'Auj.';
  if (diff === 1) return 'Demain';
  return ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][d.getDay()];
};

function renderWeather(data) {
  const container = slot('weather');
  if (!data || !data.current) {
    container.innerHTML = `<div class="empty-state"><span>Météo indisponible</span></div>`;
    return;
  }
  const c = data.current;
  const forecast = (data.forecast || []).slice(1, 4);
  container.innerHTML = `
    <div class="weather-row">
      <div class="weather-now">
        <span class="weather-now-icon">
          <iconify-icon icon="${WMO_ICON(c.code)}" width="48"></iconify-icon>
        </span>
        <div class="weather-now-main">
          <div class="weather-now-city">${esc(data.city)}</div>
          <div class="weather-now-temp">${c.temp}°</div>
          <div class="weather-now-desc">${esc(WMO_LABEL(c.code))} · ressenti ${c.feelsLike}°</div>
        </div>
      </div>
      <div class="weather-meta">
        <span><iconify-icon icon="mdi:weather-windy" width="14"></iconify-icon> ${c.wind} km/h</span>
        <span><iconify-icon icon="mdi:water-percent" width="14"></iconify-icon> ${c.humidity}%</span>
      </div>
      <div class="weather-forecast">
        ${forecast.map((d) => `
          <div class="weather-day">
            <div class="weather-day-label">${WEEKDAY_FR(d.date)}</div>
            <div class="weather-day-icon"><iconify-icon icon="${WMO_ICON(d.code)}" width="22"></iconify-icon></div>
            <div class="weather-day-temp"><span class="max">${d.tmax}°</span><span class="sep">/</span>${d.tmin}°</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderTwitch(data) {
  const container = slot('twitch');
  if (!data || !data.live || data.live.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <iconify-icon icon="mdi:twitch" width="28" style="opacity:.3"></iconify-icon>
        <span>Personne en live pour l'instant</span>
      </div>`;
    return;
  }
  const avatar = (s) => s.avatar
    ? `<img class="live-avatar" src="${esc(s.avatar)}" alt="${esc(s.displayName)}" onerror="this.outerHTML='<span class=\\'live-avatar-fallback\\'>${esc(s.displayName[0])}</span>'">`
    : `<span class="live-avatar-fallback">${esc(s.displayName[0])}</span>`;

  container.innerHTML = data.live.map((s) => `
    <a class="live-stream" href="${esc(s.url)}" target="_blank" rel="noopener">
      ${avatar(s)}
      <div class="live-info">
        <div class="live-user">${esc(s.displayName)}</div>
        <div class="live-game">${esc(s.game)}</div>
        <div class="live-meta">
          <span class="badge-live">Live</span>
          <span class="live-viewers">${fmtViewers(s.viewers)} viewers</span>
        </div>
      </div>
    </a>
  `).join('');
}

function renderYoutube(data) {
  const container = slot('youtube');
  const videos = (data?.videos ?? []).slice(0, 6);
  if (videos.length === 0) {
    container.innerHTML = `<div class="empty-state"><span>Pas de vidéo récente</span></div>`;
    return;
  }
  container.innerHTML = `
    <div class="yt-list">
      ${videos.map((v) => `
        <a class="yt-row" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(v.title)}">
          <img class="yt-row-thumb" src="${esc(v.thumbnail)}" alt="" loading="lazy" onerror="this.style.opacity=.1">
          <div class="yt-row-body">
            <div class="yt-row-title">${esc(v.title)}</div>
            <div class="yt-row-meta">${esc(v.channel)} · ${fmtRelative(v.publishedAt)}</div>
          </div>
        </a>
      `).join('')}
    </div>
  `;
}

function renderFilms(data) {
  const container = slot('films');
  const list = data?.top5 ?? [];
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><span>Rien à voir ici</span></div>`;
    return;
  }
  container.innerHTML = `
    <div class="poster-strip">
      ${list.map((f, i) => `
        <a class="poster" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.title)} (${f.year})">
          <span class="poster-rank">${i + 1}</span>
          <img src="${esc(f.poster)}" alt="${esc(f.title)}" loading="lazy">
        </a>
      `).join('')}
    </div>
  `;
}

function renderGithub(data) {
  const container = slot('github');
  const list = data?.recent ?? [];
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><span>Pas d'activité récente</span></div>`;
    return;
  }
  container.innerHTML = `
    <div class="gh-list">
      ${list.map((e) => `
        <a class="gh-item" href="${esc(e.url)}" target="_blank" rel="noopener">
          <iconify-icon class="gh-icon" icon="mdi:source-commit" width="16"></iconify-icon>
          <div class="gh-text">
            <div class="gh-repo">${esc(e.repo)}</div>
            <div class="gh-msg">${esc(e.message)}</div>
          </div>
          <span class="gh-time">${esc(e.time)}</span>
        </a>
      `).join('')}
    </div>
  `;
}

function renderHackerNews(data) {
  const container = slot('hackernews');
  const items = data?.items ?? [];
  if (items.length === 0) {
    container.innerHTML = `<div class="empty-state"><span>Rien à lire pour l'instant</span></div>`;
    return;
  }
  container.innerHTML = `
    <div class="hn-list">
      ${items.slice(0, 4).map((a) => `
        <a class="hn-item" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.titleOriginal || a.title)}">
          <span class="hn-source">${esc(a.source)}</span>
          <span class="hn-title">${esc(a.title)}</span>
          <span class="hn-meta">
            <span>▲ ${a.score}</span>
            <span class="dot-sep">·</span>
            <span>${a.comments} comm.</span>
            <span class="dot-sep">·</span>
            <span>${esc(a.date)}</span>
          </span>
        </a>
      `).join('')}
    </div>
  `;
}

function renderUpdatedAt(iso) {
  const el = $('[data-updated]');
  if (el && iso) el.textContent = fmtRelative(iso);
}

async function init() {
  try {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    renderWeather(data.weather);
    renderTwitch(data.twitch);
    renderYoutube(data.youtube);
    renderFilms(data.films);
    renderGithub(data.github);
    renderHackerNews(data.hackernews);
    renderUpdatedAt(data.updatedAt);
  } catch (err) {
    console.error('Failed to load hub data', err);
    $$('[data-content]').forEach((el) => {
      el.innerHTML = `<div class="empty-state">
        <iconify-icon icon="heroicons:exclamation-triangle" width="20" style="opacity:.5"></iconify-icon>
        <span>Données indisponibles</span>
      </div>`;
    });
  }
}

init();
