const POLL_MS = 30_000;

const GROUP_ORDER = ['app', 'auth', 'crowd'];
const GROUP_LABELS = {
  app: 'Flaxia App & API',
  auth: '認証 (Authentication)',
  crowd: 'Flaxia Crowd',
};

const STATUS_META = {
  operational: { cls: 'ok', label: '正常' },
  degraded: { cls: 'slow', label: '遅延・異常' },
  down: { cls: 'fail', label: '停止' },
  unknown: { cls: 'unknown', label: '不明' },
};

const el = (id) => document.getElementById(id);

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

function timeAgo(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'たった今';
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

function sparkline(history) {
  const w = 940;
  const h = 28;
  const pad = 1;
  const bw = (w - pad * 2) / Math.min(history.length, 60);
  const colors = { fail: '#dc2626', slow: '#d97706', ok: '#16a34a' };
  const rects = history
    .slice(0, 60)
    .map(
      (v, i) =>
        `<rect x="${pad + i * bw}" y="${pad}" width="${Math.max(bw - 1, 1)}" height="${h - pad * 2}" fill="${colors[v] || '#d1d5db'}" rx="1.5"/>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="直近の状態">${rects}</svg>`;
}

function uptimeLabel(a) {
  if (a == null) return '—';
  return `${a.toFixed(2)}%`;
}

function dur(ms) {
  if (ms == null) return '継続中';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分`;
  const d = Math.floor(h / 24);
  return `${d}日${h % 24}時間`;
}

function cardMarkup(check) {
  const meta = STATUS_META[check.status] || STATUS_META.unknown;
  const pillMeta = STATUS_META[check.status] || STATUS_META.unknown;
  const incident = check.incident
    ? `<div class="card-incident">⚠ インシデント発生前: ${esc(dur(Date.now() - check.incident.startedAt))}</div>`
    : '';
  return `
    <div class="card" data-check="${esc(check.name)}">
      <span class="dot ${meta.cls}"></span>
      <div class="card-body">
        <div class="card-head">
          <span class="card-title">${esc(check.label)}</span>
          <span class="status-pill ${pillMeta.cls}">${pillMeta.label}</span>
        </div>
        <div class="card-meta">
          <span>応答: ${check.latencyMs != null ? check.latencyMs + ' ms' : '—'}</span>
          <span>最終チェック: ${timeAgo(check.checkedAt)}</span>
          <span>稼働率 7日: ${uptimeLabel(check.uptime?.d7)}</span>
          <span>30日: ${uptimeLabel(check.uptime?.d30)}</span>
          <span>90日: ${uptimeLabel(check.uptime?.d90)}</span>
        </div>
        <div class="card-detail">${esc(check.detail) || '&nbsp;'}</div>
        <div class="card-sparkline">${sparkline(check.sparkline || [])}</div>
        ${incident}
      </div>
    </div>`;
}

function renderChecks(checks) {
  const groupsEl = el('groups');
  const byGroup = {};
  for (const c of checks) (byGroup[c.group] = byGroup[c.group] || []).push(c);
  groupsEl.innerHTML = GROUP_ORDER.filter((g) => byGroup[g])
    .map(
      (g) => `
        <section class="group">
          <h2>${GROUP_LABELS[g]}</h2>
          ${byGroup[g].map(cardMarkup).join('')}
        </section>`,
    )
    .join('');
}

function renderBanner(state) {
  const banner = el('banner');
  const title = el('banner-title');
  const desc = el('banner-desc');
  const counts = { down: 0, degraded: 0, operational: 0, unknown: 0 };
  for (const c of state.checks) counts[c.status] = (counts[c.status] || 0) + 1;

  banner.dataset.state = state.overall;
  if (state.overall === 'down') {
    title.textContent = '一部サービスで障害が発生しています';
    desc.textContent = `${counts.down} 件のチェックで停止を検知しています。復旧までしばらくお待ちください。`;
  } else if (state.overall === 'degraded') {
    title.textContent = '一部のサービスに遅延・異常が発生しています';
    desc.textContent = `${counts.degraded} 件のチェックで異常を検知しています。`;
  } else if (state.overall === 'operational') {
    title.textContent = '全システムが正常に稼働しています';
    desc.textContent = 'すべてのチェックが正常に完了しています。';
  } else {
    title.textContent = '状態を確認中…';
    desc.textContent = 'データを取得中です。';
  }
}

function renderIncidents(incidents) {
  const feed = el('incidents');
  const banner = el('incident-banner');
  if (incidents.length > 0) {
    banner.classList.remove('hidden');
    banner.textContent = `現在 ${incidents.length} 件のインシデントが進行中です。詳細は各カードまたは下記の履歴をご覧ください。`;
  } else {
    banner.classList.add('hidden');
  }
  if (!incidents.length) {
    feed.innerHTML = '<div class="incident-card empty">直近のインシデントはありません。</div>';
    return;
  }
  feed.innerHTML = incidents
    .map(
      (i) => `
      <div class="incident-card">
        <strong>⚠ ${esc(i.checkName)}</strong> —
        開始: ${fmtTime(i.startedAt)}（${dur(Date.now() - i.startedAt)}）・深刻度: ${esc(i.severity)}
      </div>`,
    )
    .join('');
}

function renderStatus(data) {
  renderBanner(data);
  renderChecks(data.checks);
  renderIncidents(data.incidents);
  el('last-updated').textContent = `最終更新: ${fmtTime(data.lastRunAt)}`;
  document.title = `Flaxia System Status — ${STATUS_META[data.overall]?.label ?? ''}`;
}

async function refresh() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatus(data);
  } catch {
    renderOffline();
  }
}

function renderOffline() {
  const banner = el('banner');
  banner.dataset.state = 'down';
  el('banner-title').textContent = 'Status API に接続できません';
  el('banner-desc').textContent =
    'status.flaxia.app 自体に問題がある可能性があります。しばらくしてから再読み込みしてください。';
  el('last-updated').textContent = '接続失敗';
}

refresh();
setInterval(refresh, POLL_MS);
