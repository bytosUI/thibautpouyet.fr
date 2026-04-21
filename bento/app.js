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
  const v = data?.latest;
  if (!v) {
    container.innerHTML = `<div class="empty-state"><span>Pas de vidéo récente</span></div>`;
    return;
  }
  container.innerHTML = `
    <a class="yt-video" href="${esc(v.url)}" target="_blank" rel="noopener">
      <img class="yt-thumb" src="${esc(v.thumbnail)}" alt="${esc(v.title)}" loading="lazy" onerror="this.style.display='none'">
      <div class="yt-meta">
        ${v.channelAvatar ? `<img class="yt-channel-avatar" src="${esc(v.channelAvatar)}" alt="">` : `<span class="yt-channel-avatar"></span>`}
        <div style="min-width:0; flex:1">
          <div class="yt-title">${esc(v.title)}</div>
          <div class="yt-channel">${esc(v.channel)} · ${fmtRelative(v.publishedAt)}</div>
        </div>
      </div>
    </a>
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

function renderVeille(data) {
  const container = slot('veille');
  const items = data?.items ?? [];
  if (items.length === 0) {
    container.innerHTML = `<div class="empty-state"><span>Rien à lire pour l'instant</span></div>`;
    return;
  }
  container.innerHTML = `
    <div class="veille-list">
      ${items.slice(0, 4).map((a) => `
        <a class="veille-item" href="${esc(a.url)}" target="_blank" rel="noopener">
          <span class="veille-source">${esc(a.source)}</span>
          <span class="veille-title">${esc(a.title)}</span>
          <span class="veille-date">${esc(a.date)}</span>
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

    renderTwitch(data.twitch);
    renderYoutube(data.youtube);
    renderFilms(data.films);
    renderGithub(data.github);
    renderVeille(data.veille);
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
