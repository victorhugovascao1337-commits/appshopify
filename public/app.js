/* Painel Contingência — frontend */

const state = {
  range: 'today',
  store: 'all',
  currency: 'BRL',
  metrics: null,
  lastLiveAt: null,
  chartMode: 'total',
  tab: 'overview',
};

const STORE_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
const storeColorIndex = new Map(); // cor segue a loja, nunca a posição na lista filtrada

const $ = (id) => document.getElementById(id);

/* ---------- formatação ---------- */

function fmtMoney(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: state.currency, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
}
function fmtMoneyCompact(v) {
  if (Math.abs(v) >= 1000) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: state.currency, notation: 'compact', maximumFractionDigits: 1 }).format(v);
  }
  return fmtMoney(v);
}
function fmtInt(v) {
  return new Intl.NumberFormat('pt-BR').format(v);
}
function deltaHtml(cur, prev, label) {
  if (!prev) return `<span class="muted">— vs ${label}</span>`;
  const pct = ((cur - prev) / prev) * 100;
  const cls = pct >= 0 ? 'up' : 'down';
  const arrow = pct >= 0 ? '↑' : '↓';
  return `<span class="${cls}">${arrow} ${Math.abs(pct).toFixed(1).replace('.', ',')}%</span> vs ${label}`;
}

const PREV_LABEL = { today: 'ontem (mesmo horário)', yesterday: 'anteontem', '7d': '7 dias anteriores', '30d': '30 dias anteriores' };

/* ---------- data no topo ---------- */

{
  const d = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('heroDate').textContent = d.charAt(0).toUpperCase() + d.slice(1);
}

function timeAgo(date) {
  const s = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return 'agora';
  const min = Math.round(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

const STATUS_LABEL = {
  paid: ['PAGO', 'st-paid'],
  partially_paid: ['PARCIAL', 'st-pending'],
  pending: ['PENDENTE', 'st-pending'],
  authorized: ['AUTORIZADO', 'st-pending'],
  refunded: ['REEMBOLSADO', 'st-refunded'],
  partially_refunded: ['REEMB. PARCIAL', 'st-refunded'],
};
function statusBadge(st) {
  const [label, cls] = STATUS_LABEL[st] || [String(st || '—').toUpperCase(), 'st-other'];
  return `<span class="status-badge ${cls}">${esc(label)}</span>`;
}

/* ---------- carregamento ---------- */

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

async function loadStores() {
  const { stores } = await api('/api/stores');
  const sel = $('storeFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">Todas as lojas</option>';
  stores.forEach((s) => {
    if (!storeColorIndex.has(s.id)) storeColorIndex.set(s.id, storeColorIndex.size % 8);
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  $('storeCount').textContent = stores.length
    ? `${stores.length} loja${stores.length > 1 ? 's' : ''} conectada${stores.length > 1 ? 's' : ''}`
    : 'Nenhuma loja conectada';
  return stores;
}

async function loadMetrics() {
  try {
    const m = await api(`/api/metrics?range=${state.range}&store=${state.store}`);
    state.metrics = m;
    state.currency = m.currency || 'BRL';
    $('errorBanner').hidden = true;

    $('tSales').textContent = fmtMoney(m.totals.sales);
    $('tOrders').textContent = fmtInt(m.totals.orders);
    $('tAov').textContent = fmtMoney(m.totals.aov);
    $('tItems').textContent = fmtInt(m.totals.itemsSold);
    const lbl = PREV_LABEL[state.range];
    $('tSalesDelta').innerHTML = deltaHtml(m.totals.sales, m.previous.sales, lbl);
    $('tOrdersDelta').innerHTML = deltaHtml(m.totals.orders, m.previous.orders, lbl);
    $('tAovDelta').innerHTML = deltaHtml(m.totals.aov, m.previous.aov, lbl);
    $('tItemsSub').textContent = m.truncated ? 'volume alto — parcial' : '';

    renderChart(m);
    renderGoal(m);
    renderStoresCard(m);
    renderRecentTable(m);
    renderStoreTable(m);
    renderProductTable(m);
    renderCommand(m);

    // mostra o motivo real que a Shopify deu, e não um palpite sobre o token
    const errs = m.byStore.filter((s) => s.error);
    if (errs.length) {
      $('errorBanner').hidden = false;
      $('errorBanner').innerHTML = errs
        .map((e) => `<div class="eb-item"><strong>${esc(e.name)}</strong> — ${esc(e.error)}</div>`)
        .join('');
    }
  } catch (e) {
    $('errorBanner').hidden = false;
    $('errorBanner').textContent = `Erro ao carregar métricas: ${e.message}`;
  }
}

/* ---------- notificação de novo pedido ---------- */

const seenOrders = new Set();
let liveInitialized = false;
let audioCtx;

function chaChing() {
  if (localStorage.getItem('soundOff') === '1') return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [[1318.5, 0], [1760, 0.09]].forEach(([freq, dt]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.55);
    });
  } catch { /* áudio bloqueado até o primeiro clique — silencia */ }
}

function showToast(o) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.innerHTML = `<div class="toast-title">🛒 Novo pedido!</div>
    <div class="toast-body">${esc(o.store)} · ${esc(o.number)}${o.city ? ' · ' + esc(o.city) : ''} — <span class="toast-total">${fmtMoney(o.total)}</span></div>`;
  $('toasts').appendChild(div);
  setTimeout(() => {
    div.classList.add('leaving');
    setTimeout(() => div.remove(), 350);
  }, 6000);
}

function syncSoundBtn() {
  const off = localStorage.getItem('soundOff') === '1';
  const b = $('soundToggle');
  b.classList.toggle('off', off);
  b.textContent = off ? '🔕' : '🔔';
}
$('soundToggle').addEventListener('click', () => {
  const off = localStorage.getItem('soundOff') === '1';
  if (off) {
    localStorage.removeItem('soundOff');
    chaChing(); // preview do som ao reativar
  } else {
    localStorage.setItem('soundOff', '1');
  }
  syncSoundBtn();
});
syncSoundBtn();

async function loadLive() {
  try {
    const l = await api(`/api/live?store=${state.store}`);
    state.lastLiveAt = Date.now();
    $('liveOrders').textContent = fmtInt(l.orders60m);
    $('liveSales').textContent = fmtMoney(l.sales60m);
    for (const o of [...l.recent].reverse()) {
      const key = `${o.storeId}|${o.number}`;
      if (!seenOrders.has(key)) {
        seenOrders.add(key);
        if (liveInitialized) {
          chaChing();
          showToast(o);
          if (o.lat != null && o.lng != null) {
            globe.points.push({ lat: o.lat, lng: o.lng, t: Date.now() });
            globe.pings.push({ lat: o.lat, lng: o.lng, born: performance.now() });
          }
        }
      }
    }
    liveInitialized = true;
    renderLiveFeed2(l);
    const feed = $('liveFeed');
    if (!l.recent.length) {
      feed.innerHTML = '<li class="feed-empty">Nenhum pedido na última hora.</li>';
    } else {
      feed.innerHTML = l.recent
        .map(
          (o) => `<li>
            <span class="feed-ico">✓</span>
            <div class="feed-main">
              <div class="feed-title">Pedido ${esc(o.number)} pago</div>
              <div class="feed-meta">${esc(o.store)}${o.city ? ' · ' + esc(o.city) : ''} · ${timeAgo(o.createdAt)}</div>
            </div>
            <span class="feed-total">${fmtMoney(o.total)}</span>
          </li>`
        )
        .join('');
    }
  } catch {
    /* mantém o último estado do feed */
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

setInterval(() => {
  if (!state.lastLiveAt) return;
  const s = Math.round((Date.now() - state.lastLiveAt) / 1000);
  const txt = s < 5 ? 'atualizado agora' : `atualizado há ${s}s`;
  $('liveUpdated').textContent = txt;
  $('liveUpdated2').textContent = txt;
}, 1000);

/* ---------- meta do dia ---------- */

function renderGoal(m) {
  const goal = parseFloat(localStorage.getItem('dailyGoal')) || 0;
  const isToday = state.range === 'today';
  $('goalEdit').hidden = !isToday;
  const meter = $('goalMeter');
  if (!goal || !isToday) {
    meter.hidden = true;
    return;
  }
  const pct = Math.min(100, (m.totals.sales / goal) * 100);
  meter.hidden = false;
  $('goalFill').style.width = `${pct}%`;
  $('goalFill').classList.toggle('done', pct >= 100);
  $('goalText').textContent = pct >= 100
    ? `Meta do dia batida! (${fmtMoney(goal)})`
    : `${pct.toFixed(0)}% da meta do dia (${fmtMoney(goal)})`;
}

$('goalEdit').addEventListener('click', () => {
  const cur = localStorage.getItem('dailyGoal') || '';
  const v = prompt(`Meta de vendas do dia (em ${state.currency}).\nDeixe vazio para remover:`, cur);
  if (v === null) return;
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));
  if (!v.trim() || !isFinite(n) || n <= 0) localStorage.removeItem('dailyGoal');
  else localStorage.setItem('dailyGoal', String(n));
  if (state.metrics) renderGoal(state.metrics);
});

/* ---------- card "Suas lojas" ---------- */

function renderStoresCard(m) {
  const ul = $('storesCard');
  const errs = m.byStore.filter((s) => s.error).length;
  $('storesConnected').textContent = m.byStore.length
    ? `${m.byStore.length - errs}/${m.byStore.length} conectada${m.byStore.length > 1 ? 's' : ''}`
    : '';
  if (!m.byStore.length) {
    ul.innerHTML = '<li class="sc-empty">Nenhuma loja ainda — conecte a primeira abaixo.</li>';
    return;
  }
  ul.innerHTML = m.byStore
    .map((s) => {
      const color = STORE_COLORS[storeColorIndex.get(s.id) ?? 0];
      return `<li>
        <span class="sc-dot" style="background:${color};color:${color}"></span>
        <div class="sc-info">
          <div class="sc-name">${esc(s.name)}</div>
          <div class="sc-domain">${s.error ? 'falha na conexão' : 'admin API'}</div>
        </div>
        <span class="badge ${s.error ? 'badge-err' : 'badge-ok'}">${s.error ? '✗ ERRO' : '● CONECTADA'}</span>
        <div class="sc-right">
          <div class="sc-sales">${fmtMoney(s.sales)}</div>
          <div class="sc-orders">${fmtInt(s.orders)} pedido${s.orders === 1 ? '' : 's'}</div>
        </div>
      </li>`;
    })
    .join('');
}

$('connectBtn').addEventListener('click', () => {
  $('modalOverlay').hidden = false;
  renderStoreList();
});

/* ---------- tabela de pedidos recentes ---------- */

const RANGE_LABEL = { today: 'hoje', yesterday: 'ontem', '7d': 'últimos 7 dias', '30d': 'últimos 30 dias' };

function renderRecentTable(m) {
  $('recentSub').textContent = RANGE_LABEL[state.range] || '';
  const tbody = $('recentTable').querySelector('tbody');
  if (!m.recentOrders || !m.recentOrders.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="feed-empty">Sem pedidos no período.</td></tr>';
    return;
  }
  tbody.innerHTML = m.recentOrders
    .map((o) => {
      const color = STORE_COLORS[storeColorIndex.get(o.storeId) ?? 0];
      return `<tr>
        <td class="mono">${esc(o.number)}</td>
        <td><div class="store-cell"><span class="store-dot" style="background:${color};color:${color}"></span>${esc(o.store)}</div></td>
        <td>${esc(o.city || '—')}</td>
        <td class="num">${fmtMoney(o.total)}</td>
        <td>${statusBadge(o.status)}</td>
        <td class="num">${timeAgo(o.createdAt)}</td>
      </tr>`;
    })
    .join('');
}

/* ---------- tabelas ---------- */

function renderStoreTable(m) {
  const tbody = $('storeTable').querySelector('tbody');
  const max = Math.max(1, ...m.byStore.map((s) => s.sales));
  const total = m.byStore.reduce((a, s) => a + s.sales, 0) || 1;
  tbody.innerHTML = m.byStore
    .slice()
    .sort((a, b) => b.sales - a.sales)
    .map((s) => {
      const ci = storeColorIndex.get(s.id) ?? 0;
      const pct = (s.sales / total) * 100;
      return `<tr>
        <td><div class="store-cell"><span class="store-dot" style="background:${STORE_COLORS[ci]};color:${STORE_COLORS[ci]}"></span>
          <span>${esc(s.name)}${s.error ? ' <span class="store-err">(erro)</span>' : ''}</span></div></td>
        <td class="num">${fmtInt(s.orders)}</td>
        <td class="num">${fmtMoney(s.sales)}</td>
        <td class="num">${fmtMoney(s.aov)}</td>
        <td><div class="share-bar"><div class="share-fill" style="width:${(s.sales / max) * 100}%;background:${STORE_COLORS[ci]}"></div></div>
          <span class="tile-delta" style="font-size:11.5px">${pct.toFixed(1).replace('.', ',')}%</span></td>
      </tr>`;
    })
    .join('');
}

function renderProductTable(m) {
  const tbody = $('productTable').querySelector('tbody');
  if (!m.topProducts.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="feed-empty">Sem vendas no período.</td></tr>';
    return;
  }
  tbody.innerHTML = m.topProducts
    .map(
      (p) => `<tr>
        <td>${esc(p.title)}</td>
        <td class="num">${fmtInt(p.qty)}</td>
        <td class="num">${fmtMoney(p.sales)}</td>
      </tr>`
    )
    .join('');
}

/* ---------- gráfico SVG ---------- */

const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function storeColor(id) {
  return cssVar(`--s${(storeColorIndex.get(id) ?? 0) + 1}`);
}

function updateLegend(items) {
  $('chartLegend').innerHTML = items
    .map((it) => `<span class="legend-item"><span class="key" style="border-color:${it.color}"></span>${esc(it.name)}</span>`)
    .join('');
}

function renderChart(m) {
  const wrap = $('chartWrap');
  const svg = $('chart');
  svg.innerHTML = '';
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (!W || !H) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const PAD = { top: 12, right: 14, bottom: 26, left: 56 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;

  const labels = m.series.labels;
  const n = labels.length;

  const colGrid = cssVar('--grid');
  const colBase = cssVar('--baseline');
  const colMuted = cssVar('--text-muted');
  const colAccent = cssVar('--accent');
  const colPrev = cssVar('--prev-line');
  const colSurface = cssVar('--surface');

  // séries a desenhar, conforme o modo (total × por loja)
  const storeMode = state.chartMode === 'stores' && m.series.byStore && m.series.byStore.length > 0;
  let series;
  if (storeMode) {
    series = m.series.byStore.map((s) => ({
      name: s.name,
      values: s.values,
      color: storeColor(s.id),
      area: false,
      main: true,
    }));
    updateLegend(series);
  } else {
    series = [
      { name: 'Período anterior', values: m.series.previous, color: colPrev, area: false, main: false },
      { name: 'Período atual', values: m.series.current, color: colAccent, area: true, main: true },
    ];
    updateLegend([series[1], series[0]]);
  }

  const maxV = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(maxV);
  const yMax = ticks[ticks.length - 1];

  const x = (i) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PAD.top + ih - (v / yMax) * ih;

  // gridlines horizontais (hairline, sólidas, recessivas)
  for (const t of ticks) {
    svg.appendChild(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), stroke: t === 0 ? colBase : colGrid, 'stroke-width': 1 }));
    const lbl = el('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: colMuted });
    lbl.textContent = fmtMoneyCompact(t);
    svg.appendChild(lbl);
  }

  // rótulos do eixo x (esparsos)
  const every = Math.ceil(n / (iw > 700 ? 10 : 6));
  for (let i = 0; i < n; i += every) {
    const lbl = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: colMuted });
    lbl.textContent = labels[i];
    svg.appendChild(lbl);
  }

  const linePath = (data) => data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  for (const s of series) {
    if (s.area) {
      // área em gradiente + glow difuso sob a linha principal
      const defs = el('defs', {});
      defs.innerHTML = `<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${s.color}" stop-opacity="0.18"/>
        <stop offset="1" stop-color="${s.color}" stop-opacity="0"/>
      </linearGradient>`;
      svg.appendChild(defs);
      const area = `${linePath(s.values)}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
      svg.appendChild(el('path', { d: area, fill: 'url(#areaGrad)', stroke: 'none' }));
    }
    svg.appendChild(el('path', { d: linePath(s.values), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  // marcador do último ponto (anel na cor da superfície)
  for (const s of series) {
    if (!s.main) continue;
    svg.appendChild(el('circle', { cx: x(n - 1), cy: y(s.values[n - 1]), r: 4.5, fill: s.color, stroke: colSurface, 'stroke-width': 2 }));
  }

  /* camada de hover: crosshair + tooltip */
  const hoverLine = el('line', { y1: PAD.top, y2: PAD.top + ih, stroke: colBase, 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(hoverLine);
  const hoverDots = series.map((s) => {
    const dot = el('circle', { r: s.main ? 4.5 : 4, fill: s.color, stroke: colSurface, 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(dot);
    return dot;
  });

  const tt = $('chartTooltip');
  const hit = el('rect', { x: PAD.left, y: PAD.top, width: iw, height: ih, fill: 'transparent' });
  svg.appendChild(hit);

  hit.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((mx - PAD.left) / iw) * (n - 1))));
    hoverLine.setAttribute('x1', x(i));
    hoverLine.setAttribute('x2', x(i));
    hoverLine.setAttribute('visibility', 'visible');
    series.forEach((s, si) => {
      hoverDots[si].setAttribute('cx', x(i));
      hoverDots[si].setAttribute('cy', y(s.values[i] || 0));
      hoverDots[si].setAttribute('visibility', 'visible');
    });
    const rows = (storeMode ? [...series].sort((a, b) => (b.values[i] || 0) - (a.values[i] || 0)) : [...series].reverse())
      .map((s) => `<div class="tt-row"><span class="key" style="border-color:${s.color}"></span>${esc(s.name)}<span class="tt-val">${fmtMoney(s.values[i] || 0)}</span></div>`)
      .join('');
    tt.hidden = false;
    tt.innerHTML = `<div class="tt-label">${esc(labels[i])}</div>${rows}`;
    const anchorY = Math.min(...series.map((s) => y(s.values[i] || 0)));
    const px = (x(i) / W) * rect.width;
    tt.style.left = `${Math.min(px + 14, rect.width - tt.offsetWidth - 6)}px`;
    tt.style.top = `${Math.max(0, (anchorY / H) * rect.height - 10)}px`;
  });
  hit.addEventListener('mouseleave', () => {
    tt.hidden = true;
    hoverLine.setAttribute('visibility', 'hidden');
    for (const d of hoverDots) d.setAttribute('visibility', 'hidden');
  });
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.metrics && renderChart(state.metrics), 150);
});

/* ---------- controles ---------- */

document.querySelectorAll('.segmented button[data-range]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented button[data-range]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.range = btn.dataset.range;
    loadMetrics();
  });
});

document.querySelectorAll('.segmented-mini button[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented-mini button[data-mode]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.chartMode = btn.dataset.mode;
    if (state.metrics) renderChart(state.metrics);
  });
});

$('storeFilter').addEventListener('change', (e) => {
  state.store = e.target.value;
  liveInitialized = false; // repovoa o feed sem disparar notificações
  loadMetrics();
  loadLive();
});

/* ---------- modal gerenciar lojas ---------- */

const overlay = $('modalOverlay');
$('manageBtn').addEventListener('click', () => {
  overlay.hidden = false;
  renderStoreList();
});
$('modalClose').addEventListener('click', () => (overlay.hidden = true));
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.hidden = true;
});

async function renderStoreList() {
  const { stores } = await api('/api/stores');
  const ul = $('storeList');
  if (!stores.length) {
    ul.innerHTML = '<li class="sl-empty">Nenhuma loja cadastrada. Adicione sua primeira loja abaixo.</li>';
    return;
  }
  ul.innerHTML = stores
    .map(
      (s, i) => `<li>
        <span class="store-dot" style="background:${STORE_COLORS[storeColorIndex.get(s.id) ?? i % 8]}"></span>
        <div><div class="sl-name">${esc(s.name)}</div><div class="sl-domain">${esc(s.domain)} · ${esc(s.currency)}</div></div>
        <button class="sl-del" data-id="${s.id}">Remover</button>
      </li>`
    )
    .join('');
  ul.querySelectorAll('.sl-del').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remover esta loja do painel?')) return;
      await fetch(`/api/stores/${b.dataset.id}`, { method: 'DELETE' });
      await refreshAll();
      renderStoreList();
    })
  );
}

function setFormStatus(msg, ok) {
  const s = $('formStatus');
  s.textContent = msg;
  s.className = `form-status ${ok ? 'ok' : 'err'}`;
}

$('testBtn').addEventListener('click', async () => {
  setFormStatus('Testando…', true);
  try {
    const res = await fetch('/api/stores/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: $('fDomain').value, token: $('fToken').value }),
    });
    const data = await res.json();
    if (data.ok) setFormStatus(`✓ Conectado: ${data.shop.name} (${data.shop.currency})`, true);
    else setFormStatus(`✗ ${data.error}`, false);
  } catch (e) {
    setFormStatus(`✗ ${e.message}`, false);
  }
});

$('addStoreForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setFormStatus('Adicionando…', true);
  try {
    const res = await fetch('/api/stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('fName').value, domain: $('fDomain').value, token: $('fToken').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao adicionar.');
    setFormStatus(`✓ ${data.store.name} adicionada!`, true);
    $('fName').value = '';
    $('fDomain').value = '';
    $('fToken').value = '';
    await refreshAll();
    renderStoreList();
  } catch (err) {
    setFormStatus(`✗ ${err.message}`, false);
  }
});

/* ================= COMMAND CENTER ================= */

const PAGES = { overview: 'page-overview', lojas: 'page-lojas', command: 'page-command', flow: 'page-flow' };

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    for (const [tab, id] of Object.entries(PAGES)) $(id).hidden = state.tab !== tab;
    // Lojas e Flow têm cabeçalho próprio — some com o hero/controles globais
    document.querySelector('.hero').hidden = state.tab === 'lojas' || state.tab === 'flow';
    if (state.tab === 'flow') {
      // sempre entra no conteúdo principal do Flow (não na sub-view Analytics)
      if ($('flow-analytics')) $('flow-analytics').hidden = true;
      if ($('flow-main')) $('flow-main').hidden = false;
      amLoad().then(loadFlowView);
      ppLoad();
      scLoad();
    }
    if (state.tab === 'lojas') loadLojas();
  });
});

function flagEmoji(code) {
  if (!code || String(code).length !== 2) return '🌐';
  return String.fromCodePoint(...[...String(code).toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}

/* ---------- alertas ---------- */

function computeAlerts(m) {
  const alerts = [];
  for (const s of m.byStore) {
    if (s.error) {
      alerts.push({ level: 'crit', ico: '⛔', title: `${s.name}: falha de conexão`, desc: 'Verifique o token em Gerenciar lojas.' });
      continue;
    }
    if (s.lastOrderAt) {
      const h = (Date.now() - new Date(s.lastOrderAt).getTime()) / 36e5;
      if (h >= 6) alerts.push({ level: 'crit', ico: '🔴', title: `${s.name} sem vender há ${Math.floor(h)}h`, desc: 'Confira checkout, gateway e campanhas.' });
      else if (h >= 3) alerts.push({ level: 'warn', ico: '🟡', title: `${s.name} sem pedidos há ${Math.floor(h)}h`, desc: 'Vale monitorar de perto.' });
    } else {
      alerts.push({ level: 'warn', ico: '🟡', title: `${s.name} sem pedidos na janela consultada`, desc: 'Nenhum pedido no período analisado.' });
    }
  }
  if (m.previous.sales > 0 && m.totals.sales < m.previous.sales * 0.6) {
    alerts.push({ level: 'warn', ico: '📉', title: 'Vendas 40%+ abaixo do período anterior', desc: `${fmtMoney(m.totals.sales)} agora vs ${fmtMoney(m.previous.sales)} antes.` });
  }
  return alerts;
}

function renderAlerts(m) {
  const alerts = computeAlerts(m);
  $('alertCount').textContent = alerts.length ? `⚠ ${alerts.length}` : '✓ 0';
  const ul = $('alertList');
  if (!alerts.length) {
    ul.innerHTML = '<li class="alert-ok"><span class="al-ico">✓</span><div><div class="al-title">Tudo saudável</div><div class="al-desc">Nenhum alerta nas suas lojas agora.</div></div></li>';
    return;
  }
  ul.innerHTML = alerts
    .map(
      (a) => `<li class="alert-${a.level === 'crit' ? 'crit' : 'warn'}">
        <span class="al-ico">${a.ico}</span>
        <div><div class="al-title">${esc(a.title)}</div><div class="al-desc">${esc(a.desc)}</div></div>
      </li>`
    )
    .join('');
}

/* ---------- saúde por loja ---------- */

function riskPill(s) {
  if (s.error) return '<span class="risk-pill risk-crit">Crítico</span>';
  if (!s.lastOrderAt) return '<span class="risk-pill risk-warn">Atenção</span>';
  const h = (Date.now() - new Date(s.lastOrderAt).getTime()) / 36e5;
  if (h >= 6) return '<span class="risk-pill risk-crit">Crítico</span>';
  if (h >= 3) return '<span class="risk-pill risk-warn">Atenção</span>';
  return '<span class="risk-pill risk-ok">Saudável</span>';
}

function renderHealth(m) {
  const tbody = $('healthTable').querySelector('tbody');
  tbody.innerHTML = m.byStore
    .map((s) => {
      const color = STORE_COLORS[storeColorIndex.get(s.id) ?? 0];
      return `<tr>
        <td><div class="store-cell"><span class="store-dot" style="background:${color};color:${color}"></span>${esc(s.name)}</div></td>
        <td><span class="badge ${s.error ? 'badge-err' : 'badge-ok'}">${s.error ? '✗ ERRO' : '● OK'}</span></td>
        <td class="num">${fmtMoney(s.sales)}</td>
        <td class="num">${fmtInt(s.orders)}</td>
        <td class="num">${s.lastOrderAt ? timeAgo(s.lastOrderAt) : '—'}</td>
        <td>${riskPill(s)}</td>
      </tr>`;
    })
    .join('');
}

/* ---------- por país + feed com bandeira ---------- */

function renderCountries(m) {
  const ul = $('countryList');
  if (!m.topCountries || !m.topCountries.length) {
    ul.innerHTML = '<li class="feed-empty">Sem dados de país no período.</li>';
    return;
  }
  const max = Math.max(...m.topCountries.map((c) => c.sales));
  ul.innerHTML = m.topCountries
    .map(
      (c) => `<li>
        <span class="cl-flag">${flagEmoji(c.code)}</span>
        <span class="cl-name">${esc(c.country)}</span>
        <span class="cl-bar-wrap"><span class="cl-bar" style="display:block;width:${(c.sales / max) * 100}%"></span></span>
        <span class="cl-val">${fmtMoney(c.sales)}</span>
      </li>`
    )
    .join('');
}

function renderLiveFeed2(l) {
  const feed = $('liveFeed2');
  if (!l.recent.length) {
    feed.innerHTML = '<li class="feed-empty">Nenhum pedido na última hora.</li>';
  } else {
    feed.innerHTML = l.recent
      .map(
        (o) => `<li>
          <span class="feed-ico">${flagEmoji(o.countryCode)}</span>
          <div class="feed-main">
            <div class="feed-title">Pedido ${esc(o.number)} pago</div>
            <div class="feed-meta">${esc(o.country || '—')}${o.city ? ' · ' + esc(o.city) : ''} · ${esc(o.store)} · ${timeAgo(o.createdAt)}</div>
          </div>
          <span class="feed-total">${fmtMoney(o.total)}</span>
        </li>`
      )
      .join('');
  }
  const last = l.recent[0];
  if (last) {
    $('globeCaption').innerHTML = `Último pedido: ${flagEmoji(last.countryCode)} <span class="gc-strong">${esc(last.city || '')}${last.city && last.country ? ', ' : ''}${esc(last.country || '')}</span> — ${fmtMoney(last.total)} · ${timeAgo(last.createdAt)}`;
  }
}

function renderCommand(m) {
  renderAlerts(m);
  renderHealth(m);
  renderCountries(m);
  globe.points = (m.geoPoints || []).slice();
  $('globeSub').textContent = `${globe.points.length} pedido${globe.points.length === 1 ? '' : 's'} no mapa · ${RANGE_LABEL[state.range] || ''}`;
}

/* ---------- flow de contingência ---------- */

async function loadFlowView() {
  try {
    const fl = await api('/api/flow');
    renderFlow(fl);
  } catch (e) {
    showLojaToast('Erro no flow', e.message);
  }
}

async function postFlow(path, body) {
  await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  await loadFlowView();
}

let drFlowState = null; // último /api/flow para recalcular rotas em resize

function drInitials(name) {
  return (String(name || '?').trim().slice(0, 2) || 'PR').toUpperCase();
}

function drCardHtml(s, i, total) {
  const pct = Math.min(100, s.limit ? (s.sales / s.limit) * 100 : 0);
  const barColor = s.active ? 'from-emerald-400 to-cyan-500' : pct >= 100 ? 'from-rose-500 to-red-600' : 'from-blue-500 to-cyan-500';
  const pctColor = s.active ? 'text-emerald-400' : pct >= 100 ? 'text-rose-400' : 'text-blue-400';
  const cardBorder = s.paused
    ? 'border-amber-500/40 ring-2 ring-amber-500/20'
    : s.active
      ? 'border-emerald-500/40 ring-2 ring-emerald-500/30 shadow-[0_0_0_1px_rgba(16,185,129,.2),0_0_30px_rgba(16,185,129,.15)]'
      : s.next ? 'border-blue-500/30' : 'border-white/[0.06] opacity-60 hover:opacity-100';
  const dailyOn = s.dailyLimit > 0;
  const amStore = amState && amState.stats ? amState.stats.stores.find((x) => x.id === s.id) : null;
  return `<div class="relative group pool-sortable-item ${s.active ? 'active-node' : ''}" id="node-dest-${i}" data-pool-id="${esc(s.id)}">
    <div class="dr-node-card relative bg-gradient-to-br from-[#0d1117] to-[#0a0c10] border ${cardBorder} rounded-2xl overflow-hidden">
      <!-- Top Bar -->
      <div class="flex items-center justify-between px-3 py-2.5 bg-white/[0.02] border-b border-white/[0.04]">
        <div class="flex items-center gap-1.5 min-w-0 overflow-hidden">
          <span class="drag-handle p-1 rounded hover:bg-white/5" title="Arraste para reordenar"><svg class="w-4 h-4 text-gray-600" fill="currentColor" viewBox="0 0 24 24"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></span>
          <span class="text-[10px] font-bold text-gray-500 uppercase tracking-wider">#${i + 1}</span>
          ${s.paused ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/30">Pausada</span>'
            : s.blocked ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-orange-500/20 text-orange-400 border border-orange-500/30">Limite diário</span>'
            : s.active ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Ativa</span>'
            : s.next ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-blue-500/20 text-blue-400 border border-blue-500/30">Próxima</span>' : ''}
        </div>
        <div class="flex items-center gap-1.5 justify-end flex-shrink-0">
          <button data-act="health" data-id="${esc(s.id)}" class="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 flex items-center justify-center transition-all group/health" title="Verificar saúde da loja"><svg class="w-3.5 h-3.5 group-hover/health:rotate-180 transition-transform duration-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>
          <button data-act="pause" data-id="${esc(s.id)}" data-paused="${s.paused ? '1' : '0'}" class="w-7 h-7 rounded-lg ${s.paused ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20'} flex items-center justify-center transition-all" title="${s.paused ? 'Retomar loja' : 'Pausar loja'}">${s.paused ? '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' : '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'}</button>
          <button data-act="force" data-id="${esc(s.id)}" ${s.active ? 'disabled' : ''} class="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center transition-all ${s.active ? 'opacity-40 cursor-not-allowed' : 'hover:text-emerald-300 hover:bg-emerald-500/20'}" title="${s.active ? 'Já está ativa' : 'Forçar como ativa'}"><span class="material-symbols-outlined text-sm">bolt</span></button>
          <button data-act="reset" data-id="${esc(s.id)}" class="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 flex items-center justify-center transition-all" title="Zerar contadores desta loja"><span class="material-symbols-outlined text-sm">restart_alt</span></button>
          <button data-act="remove" data-id="${esc(s.id)}" class="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 flex items-center justify-center transition-all" title="Remover do pool"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
        </div>
      </div>
      <!-- Main Content -->
      <div class="p-4">
        <div class="flex items-center gap-3 mb-4">
          <div class="relative">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-900/20 flex items-center justify-center border border-white/10"><span class="text-lg font-black text-emerald-400">${esc(drInitials(s.name))}</span></div>
            <div class="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-500 border-2 border-[#0d1117] ${s.active ? 'animate-pulse' : ''}"></div>
          </div>
          <div class="flex-1 min-w-0"><h4 class="text-sm font-bold text-white truncate mb-0.5">${esc(s.name)}</h4><p class="text-[11px] text-gray-500 truncate font-mono">${esc(s.domain)}</p></div>
        </div>
        <!-- Stats Grid -->
        <div class="grid grid-cols-3 gap-2 mb-4">
          <div class="bg-white/[0.02] rounded-xl p-2.5 border border-white/[0.04] text-center"><p class="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Vendas</p><p class="text-sm font-bold text-white">${fmtInt(s.sales)}</p><p class="text-[9px] text-gray-600">/ ${fmtInt(s.limit)}</p></div>
          <div class="bg-white/[0.02] rounded-xl p-2.5 border border-white/[0.04] text-center"><p class="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Receita</p><p class="text-sm font-bold text-white">${fmtMoneyCompact(s.revenue || 0)}</p></div>
          <div class="bg-white/[0.02] rounded-xl p-2.5 border border-white/[0.04] text-center"><p class="text-[9px] text-gray-500 uppercase tracking-wider mb-1">Hoje</p><p class="text-sm font-bold text-white">${fmtInt(s.todayCount || 0)}</p></div>
        </div>
        <!-- Rotation Criteria Selector -->
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2"><span class="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Critério de Rotação</span></div>
          <div class="flex gap-1.5 p-1 rounded-xl bg-white/[0.02] border border-white/[0.04]">
            <button data-act="editlimit" data-id="${esc(s.id)}" class="flex-1 py-2 px-3 rounded-lg transition-all duration-300 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400"><div class="flex items-center justify-center gap-1.5"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"/></svg><span class="text-[10px] font-bold uppercase tracking-wide">Vendas</span></div><div class="text-[11px] font-bold mt-0.5 text-white">${fmtInt(s.sales)}<span class="text-[9px] font-normal opacity-50">/ ${fmtInt(s.limit)}</span></div></button>
            <button data-act="illustrative" class="flex-1 py-2 px-3 rounded-lg transition-all duration-300 text-gray-500 hover:bg-white/5 hover:text-white"><div class="flex items-center justify-center gap-1.5"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span class="text-[10px] font-bold uppercase tracking-wide">Receita</span></div><div class="text-[11px] font-bold mt-0.5 text-gray-600">R$0<span class="text-[9px] font-normal opacity-50">/ ∞</span></div></button>
          </div>
          <div class="mt-3">
            <div class="flex justify-between items-center mb-1"><span class="text-[9px] text-gray-600">Progresso de Vendas</span><span class="text-[10px] font-bold ${pctColor}">${Math.round(pct)}%</span></div>
            <div class="h-1.5 bg-white/5 rounded-full overflow-hidden"><div class="h-full bg-gradient-to-r ${barColor} rounded-full transition-all duration-700 relative" style="width:${pct}%"><div class="absolute inset-0 dr-shimmer" style="background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.3) 50%,transparent 100%)"></div></div></div>
          </div>
        </div>
        <!-- Limite Diário (real) -->
        <div class="mb-4 p-3 rounded-xl bg-gradient-to-br from-white/[0.02] to-transparent border border-white/[0.04]">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2"><svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span class="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Limite Diário</span></div>
            ${dailyOn ? `<span class="text-[10px] font-bold ${s.blocked ? 'text-orange-400' : 'text-emerald-400'}">${fmtInt(s.todayCount)}/${fmtInt(s.dailyLimit)}</span>` : ''}
          </div>
          <div class="flex items-center gap-2">
            <button data-act="daily" data-id="${esc(s.id)}" data-on="${dailyOn ? '1' : '0'}" class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${dailyOn ? 'bg-emerald-500' : 'bg-gray-400'}" title="${dailyOn ? 'Desativar limite diário' : 'Ativar limite diário'}"><span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${dailyOn ? 'translate-x-4' : 'translate-x-0'}"></span></button>
            <div class="flex-1 flex items-center gap-2">
              <input type="number" value="${dailyOn ? s.dailyLimit : 10}" min="1" max="1000" data-dailyinput="${esc(s.id)}" class="w-16 bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-white text-center text-xs font-bold focus:outline-none focus:border-emerald-500/50 ${dailyOn ? '' : 'opacity-50'}" ${dailyOn ? '' : 'disabled'}>
              <span class="text-[10px] text-gray-500">vendas/dia</span>
            </div>
          </div>
        </div>
        <!-- AutoMatch: mapeamento real desta loja -->
        <div class="flex items-center justify-between gap-2 py-2 px-3 rounded-xl bg-white/[0.02] border border-white/[0.04] mb-3">
          ${amStore
            ? `<div class="flex items-center gap-2 ${amStore.error ? 'text-rose-400' : amStore.unmatched ? 'text-amber-400' : 'text-emerald-400'}"><svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg><span class="text-[11px] font-medium">${amStore.error ? 'Falha no AutoMatch' : `${fmtInt(amStore.matched)} produtos mapeados${amStore.unmatched ? ` · ${fmtInt(amStore.unmatched)} sem match` : ''}`}</span></div>`
            : '<span class="text-[11px] text-gray-500">AutoMatch ainda não rodou</span>'}
          <button data-act="mapping" data-id="${esc(s.id)}" data-name="${esc(s.name)}" class="text-[10px] text-gray-500 hover:text-purple-400 transition-colors font-medium whitespace-nowrap">Ver mapeamento →</button>
        </div>
        <!-- Action Buttons -->
        <div class="grid grid-cols-2 gap-2">
          <button data-act="health" data-id="${esc(s.id)}" class="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-400/50 text-emerald-400 hover:text-emerald-300 transition-all group/sync"><svg class="w-4 h-4 group-hover/sync:rotate-180 transition-transform duration-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg><span class="text-[11px] font-bold uppercase tracking-wide">Testar conexão</span></button>
          <button data-act="reset" data-id="${esc(s.id)}" class="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-white/5 hover:bg-amber-500/10 border border-white/10 hover:border-amber-500/30 text-gray-500 hover:text-amber-400 transition-all"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg><span class="text-[11px] font-bold uppercase tracking-wide">Resetar</span></button>
        </div>
      </div>
      ${s.active ? '<div class="px-4 py-2.5 bg-emerald-500/[0.08] border-t border-emerald-500/20 flex items-center justify-center gap-2"><span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span></span><span class="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.15em]">Recebendo Tráfego</span></div>' : ''}
    </div>
  </div>`;
}

function updateFlowPaths() {
  const canvas = $('flow-canvas');
  const sourceNode = $('source-node');
  if (!canvas || !sourceNode || !drFlowState) return;
  const cRect = canvas.getBoundingClientRect();
  if (!cRect.width || !cRect.height) return; // aba oculta
  const sRect = sourceNode.getBoundingClientRect();
  const x1 = (sRect.left + sRect.width / 2) - cRect.left;
  const y1 = sRect.bottom - cRect.top;
  const n = drFlowState.checkout.length;
  for (let i = 0; i < n; i++) {
    const dest = $(`node-dest-${i}`);
    const path = $(`path-${i}`);
    if (!dest || !path) continue;
    const dRect = dest.getBoundingClientRect();
    const x2 = (dRect.left + dRect.width / 2) - cRect.left;
    const y2 = dRect.top - cRect.top;
    const cy = y1 + (y2 - y1) * 0.5;
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`);
  }
}

function renderFlow(fl) {
  drFlowState = fl;
  const active = fl.checkout.find((s) => s.active) || null;
  const totalSales = fl.checkout.reduce((sum, s) => sum + (s.sales || 0), 0);
  const ago = timeAgo(fl.activatedAt);
  const agoTxt = ago === 'agora' ? 'agora' : `${ago.replace('há ', '')} atrás`;
  const paused = !!fl.paused;

  // header
  $('dr-title').textContent = fl.vitrine ? fl.vitrine.name : 'Centro de Roteamento';
  $('dr-subtitle').textContent = fl.vitrine ? `${fl.vitrine.domain} → Pool de Checkout` : 'vitrine → Pool de Checkout';
  $('dr-crumb').textContent = fl.vitrine ? fl.vitrine.name : 'Flow';

  // HUD
  $('dr-vitrine-name').textContent = fl.vitrine ? fl.vitrine.name : '—';
  $('dr-vitrine-domain').textContent = fl.vitrine ? fl.vitrine.domain : '—';
  $('dr-source-name').textContent = fl.vitrine ? fl.vitrine.name : '—';
  $('dr-source-domain').textContent = fl.vitrine ? fl.vitrine.domain : '—';
  $('dr-pool-badge').textContent = fmtInt(fl.checkout.length);
  $('dr-online').textContent = fl.checkout.length ? `${fl.checkout.length}/${fl.checkout.length} Online` : '0/0 Online';
  $('dr-checkout-domain').textContent = active ? active.domain : (fl.checkout[0] ? fl.checkout[0].domain : '—');

  // stats
  $('dr-created').textContent = agoTxt;
  $('dr-updated').textContent = new Date(fl.activatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('dr-stores').textContent = fmtInt(fl.stores.length);
  $('dr-views').textContent = fmtInt(6664); // ilustrativo (sem analytics de impressões)
  $('dr-clicks').textContent = fmtInt(1081); // ilustrativo
  $('dr-sales').textContent = fmtInt(totalSales);

  drSetStatus(!paused);

  // seletor de vitrine
  const sel = $('vitrineSelect');
  sel.innerHTML = fl.stores.map((s) => `<option value="${s.id}" ${fl.vitrine && s.id === fl.vitrine.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  sel.onchange = () => postFlow('/api/flow/config', { vitrineId: sel.value });

  // grade de checkout + rotas SVG
  const grid = $('destination-grid');
  const svg = $('flow-canvas');
  if (!fl.checkout.length) {
    grid.innerHTML = '<div class="col-span-full text-center text-gray-500 text-sm border border-dashed border-white/10 rounded-2xl py-10">Adicione pelo menos 2 lojas — uma vitrine e uma (ou mais) de checkout.</div>';
    svg.innerHTML = '';
    return;
  }
  grid.innerHTML = fl.checkout.map((s, i) => drCardHtml(s, i, fl.checkout.length)).join('') +
    `<button onclick="drGoAddStore()" class="relative border-2 border-dashed border-white/10 rounded-2xl p-6 flex flex-col items-center justify-center gap-4 hover:border-emerald-500/40 hover:bg-emerald-500/5 transition-all group min-h-[220px]">
      <div class="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center group-hover:scale-110 group-hover:rotate-90 transition-all duration-500 border border-white/10 group-hover:border-emerald-500/40"><span class="material-symbols-outlined text-3xl text-gray-600 group-hover:text-emerald-400 transition-colors">add</span></div>
      <div class="text-center"><span class="text-xs font-black text-gray-600 group-hover:text-emerald-400 uppercase tracking-widest transition-colors block">Adicionar</span><span class="text-[10px] text-gray-700">Novo checkout ao pool</span></div>
    </button>`;

  // paths SVG (um por checkout), com pulso na ativa
  svg.innerHTML = fl.checkout.map((s, i) =>
    `<path id="path-${i}" class="flow-path ${s.active ? 'active' : ''}"></path>` +
    (s.active ? `<circle r="2.5" class="flow-pulse"><animateMotion dur="2s" repeatCount="indefinite"><mpath href="#path-${i}"></mpath></animateMotion></circle>` : '')
  ).join('');

  // wiring dos botões/inputs
  grid.querySelectorAll('[data-limit-id]').forEach((inp) => inp.addEventListener('change', () => {
    const val = parseInt(inp.value, 10);
    if (val >= 1) postFlow('/api/flow/config', { limits: { [inp.dataset.limitId]: val } });
  }));
  grid.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (act === 'skip') {
      localStorage.setItem('flowSkips', String(parseInt(localStorage.getItem('flowSkips') || '0', 10) + 1));
      postFlow('/api/flow/skip');
    } else if (act === 'force') {
      postFlow('/api/flow/activate', { id });
    } else if (act === 'pause') {
      postFlow(`/api/flow/pool/${id}/pause`, { paused: btn.dataset.paused !== '1' });
    } else if (act === 'reset') {
      if (!confirm('Zerar os contadores desta loja? A contagem de vendas da rotação recomeça agora.')) return;
      postFlow(`/api/flow/pool/${id}/reset`);
    } else if (act === 'remove') {
      if (!confirm('Remover esta loja do pool de checkout? Ela continua cadastrada em Lojas.')) return;
      await fetch(`/api/flow/pool/${id}`, { method: 'DELETE' });
      loadFlowView();
    } else if (act === 'daily') {
      const on = btn.dataset.on === '1';
      if (on) {
        postFlow(`/api/flow/pool/${id}/daily-limit`, { dailyLimit: 0 });
      } else {
        const inp = grid.querySelector(`[data-dailyinput="${id}"]`);
        const v = parseInt(inp && inp.value, 10) || 10;
        postFlow(`/api/flow/pool/${id}/daily-limit`, { dailyLimit: v });
      }
    } else if (act === 'editlimit') {
      const cur = (drFlowState.checkout.find((s) => s.id === id) || {}).limit || 10;
      const v = prompt('Vendas para pular para a próxima loja:', cur);
      if (v === null) return;
      const val = parseInt(v, 10);
      if (val >= 1) postFlow(`/api/flow/pool/${id}/limit`, { limit: val });
      else showLojaToast('Valor inválido', 'Informe um número de vendas maior que zero.');
    } else if (act === 'mapping') {
      amShowMapping(id, btn.dataset.name);
    } else if (act === 'health') {
      showLojaToast('Testando conexão…', 'Consultando a Shopify.');
      try {
        const { health } = await api('/api/flow/health');
        const h = health.find((x) => x.id === id);
        if (h && h.ok) showLojaToast('✓ Loja online', `${h.name || 'Conectada'} respondeu pela Admin API.`);
        else showLojaToast('✗ Falha na loja', (h && h.error) || 'Sem resposta da Shopify.');
      } catch (e) { showLojaToast('✗ Erro', e.message); }
    }
  }));
  grid.querySelectorAll('[data-dailyinput]').forEach((inp) => inp.addEventListener('change', () => {
    const v = parseInt(inp.value, 10);
    if (v >= 1) postFlow(`/api/flow/pool/${inp.dataset.dailyinput}/daily-limit`, { dailyLimit: v });
  }));

  // drag para reordenar → salva a ordem real da rotação
  if (typeof Sortable !== 'undefined' && !grid.dataset.sortable) {
    grid.dataset.sortable = '1';
    Sortable.create(grid, {
      animation: 150, handle: '.drag-handle', draggable: '.pool-sortable-item',
      ghostClass: 'sortable-ghost', dragClass: 'sortable-drag',
      onEnd: () => {
        const ids = [...grid.querySelectorAll('.pool-sortable-item')].map((el) => el.dataset.poolId);
        postFlow('/api/flow/pool/order', { ids });
        showLojaToast('Ordem salva', 'A rotação vai seguir a nova ordem do pool.');
      },
    });
  }

  // entrada animada dos cards (só translateY — opacidade fica com o CSS/Tailwind)
  if (typeof anime !== 'undefined') {
    anime({ targets: '#destination-grid .pool-sortable-item', translateY: [24, 0], delay: anime.stagger(70), easing: 'easeOutCubic', duration: 600 });
  }

  requestAnimationFrame(updateFlowPaths);
  setTimeout(updateFlowPaths, 120);
  setTimeout(updateFlowPaths, 450);
}

function drSetStatus(running) {
  const btn = $('status-toggle-btn');
  const knob = $('status-toggle-knob');
  const box = $('status-text-container');
  const hud = $('dr-hud-status');
  const link = $('dr-status-link');
  const cap = $('dr-active-caption');
  if (btn) btn.dataset.status = running ? 'running' : 'paused';
  if (btn) btn.className = 'relative inline-flex h-8 w-16 flex-shrink-0 cursor-pointer items-center rounded-full transition-all duration-300 border ' + (running ? 'bg-gradient-to-r from-emerald-600 to-green-500 shadow-[0_0_20px_rgba(16,185,129,0.4)] border-emerald-500/30' : 'bg-white/10 border-white/10');
  if (knob) knob.className = 'inline-block h-6 w-6 rounded-full bg-white shadow-lg transform transition-all duration-300 ' + (running ? 'translate-x-9' : 'translate-x-1');
  if (box) box.className = 'flex items-center gap-3 p-4 rounded-2xl border ' + (running ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-white/5 border-white/5');
  if (box) box.innerHTML = running
    ? '<span class="flex h-3 w-3 relative"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span></span><span class="text-sm font-bold text-emerald-400">Operação Ativa e Roteando</span>'
    : '<span class="w-3 h-3 rounded-full bg-gray-500"></span><span class="text-sm font-bold text-gray-400">Operação Pausada</span>';
  if (hud) hud.textContent = running ? 'ROTEAMENTO ATIVO' : 'ROTEAMENTO PAUSADO';
  if (link) link.textContent = running ? 'Pausar Operação' : 'Retomar Operação';
  if (cap) cap.textContent = running ? 'Clientes são redirecionados para o checkout' : 'Nenhum redirecionamento ativo';
}

function drToggleStatus() {
  const wasPaused = !!(drFlowState && drFlowState.paused);
  postFlow('/api/flow/status', { paused: !wasPaused });
  showLojaToast(wasPaused ? '▶️ Operação retomada' : '⏸️ Operação pausada', wasPaused ? 'A rotação voltou a avançar entre as lojas.' : 'A rotação parou — nenhuma loja será trocada até retomar.');
}

// adiciona uma loja já cadastrada ao pool; se não houver nenhuma sobrando, abre o wizard de conexão
async function drGoAddStore() {
  const avail = (drFlowState && drFlowState.available) || [];
  if (!avail.length) {
    document.querySelector('.tab-btn[data-tab="lojas"]').click();
    openWizard();
    return;
  }
  if (avail.length === 1) {
    if (!confirm(`Adicionar "${avail[0].name}" ao pool de checkout?`)) return;
    postFlow('/api/flow/pool/add', { id: avail[0].id });
    return;
  }
  const list = avail.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  const pick = prompt(`Qual loja adicionar ao pool?\n\n${list}\n\nDigite o número:`);
  if (pick === null) return;
  const idx = parseInt(pick, 10) - 1;
  if (avail[idx]) postFlow('/api/flow/pool/add', { id: avail[idx].id });
  else showLojaToast('Opção inválida', 'Digite o número de uma das lojas da lista.');
}

function drIllustrative() {
  showLojaToast('Em breve', 'Este painel ainda é ilustrativo nesta build.');
}

/* ---------- AutoMatch por SKU (real) ---------- */

let amState = null;

function amRender(a) {
  amState = a;
  const cfg = a.config || {};
  if ($('amSuffix')) $('amSuffix').value = cfg.skuSuffixLength ?? 4;
  if ($('amStrategy')) $('amStrategy').value = cfg.strategy || 'suffix';
  if ($('amEnabled')) $('amEnabled').checked = cfg.enabled !== false;
  $('amSuffix').disabled = cfg.strategy === 'exact';

  const st = a.stats;
  $('amUpdated').textContent = a.lastSyncAt ? `sincronizado ${timeAgo(a.lastSyncAt)}` : 'nunca sincronizado';
  if (!st) {
    ['amMapped', 'amUnmapped', 'amGroups', 'amVitrine', 'amPool', 'amCovManual', 'amCovExact', 'amCovPartial', 'amCovConsol', 'amCovUnmapped'].forEach((id) => { $(id).textContent = '—'; });
    $('amCovPercent').textContent = '—';
    $('amCovBar').style.width = '0%';
    return;
  }
  $('amMapped').textContent = fmtInt(st.mapped);
  $('amUnmapped').textContent = fmtInt(st.unmapped);
  $('amGroups').textContent = fmtInt(st.groups.count);
  $('amVitrine').textContent = fmtInt(st.groups.vitrineVariants);
  $('amPool').textContent = fmtInt(st.groups.poolVariants);
  $('amCovPercent').textContent = `${st.coverage.percent}%`;
  $('amCovBar').style.width = `${st.coverage.percent}%`;
  $('amCovManual').textContent = fmtInt(st.coverage.manual || 0);
  $('amCovExact').textContent = fmtInt(st.coverage.exact);
  $('amCovPartial').textContent = fmtInt(st.coverage.partial);
  $('amCovConsol').textContent = fmtInt(st.coverage.consolidation);
  $('amCovUnmapped').textContent = fmtInt(st.coverage.unmapped);
}

async function amLoad() {
  try {
    amRender(await api('/api/automatch'));
  } catch (e) { /* painel fica com — */ }
}

async function amSaveConfig() {
  try {
    const body = {
      skuSuffixLength: parseInt($('amSuffix').value, 10),
      strategy: $('amStrategy').value,
      enabled: $('amEnabled').checked,
    };
    const res = await fetch('/api/automatch/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.config) { amState = { ...(amState || {}), config: data.config }; amRender(amState); }
    showLojaToast('✓ Configuração salva', 'Rode o AutoMatch de novo para aplicar a nova regra.');
  } catch (e) { showLojaToast('✗ Erro', e.message); }
}

async function amSync(btn) {
  const original = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined text-lg animate-spin">sync</span><span>Sincronizando…</span>'; }
  showLojaToast('↻ AutoMatch rodando', 'Buscando produtos da vitrine e das lojas do pool na Shopify…');
  try {
    const res = await fetch('/api/automatch/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha no AutoMatch.');
    amRender(await api('/api/automatch'));
    const st = data.stats;
    showLojaToast('✓ AutoMatch concluído', `${fmtInt(st.mapped)} mapeados · ${fmtInt(st.unmapped)} sem match · cobertura ${st.coverage.percent}%`);
    loadFlowView();
  } catch (e) {
    showLojaToast('✗ AutoMatch falhou', e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

/* ---------- Redirect da vitrine (ScriptTag) ---------- */

let scState = null;

function scRender(d) {
  scState = d;
  const c = d.config || {};
  $('scEnabled').checked = !!c.enabled;
  $('scMode').value = c.mode || 'ads';
  $('scKeep').checked = c.keepParams !== false;
  $('scSrc').textContent = d.src || '—';
  $('scVitrine').textContent = d.vitrine ? d.vitrine.name : 'vitrine';

  const local = !/^https:/.test(d.src || '');
  const status = $('scStatusText');
  if (!d.vitrine) {
    status.innerHTML = '<span class="text-amber-400">Sem vitrine</span> <span class="text-gray-600">— defina no Flow</span>';
  } else if (d.error) {
    status.innerHTML = `<span class="text-rose-400">Erro</span> <span class="text-gray-600">— ${esc(d.error.slice(0, 60))}</span>`;
  } else if (d.installed && c.enabled) {
    status.innerHTML = '<span class="text-emerald-400">✓ Ativo na vitrine</span>';
  } else if (d.installed && !c.enabled) {
    status.innerHTML = '<span class="text-amber-400">Instalado, mas desligado</span>';
  } else {
    status.innerHTML = '<span class="text-gray-400">Não instalado</span>';
  }

  $('scInstallBtn').hidden = !!d.installed;
  $('scRemoveBtn').hidden = !d.installed;
  if (d.installed) {
    $('scInstallTitle').textContent = 'Script instalado na vitrine';
    $('scInstallTitle').className = 'text-sm font-bold text-emerald-400';
    $('scInstallDesc').textContent = 'A Shopify carrega este arquivo nas páginas da loja.';
  } else if (local) {
    $('scInstallTitle').textContent = 'Instale pelo painel publicado';
    $('scInstallTitle').className = 'text-sm font-bold text-amber-400';
    $('scInstallDesc').textContent = 'A Shopify só aceita script em HTTPS — abra o painel na Vercel e instale de lá.';
  } else {
    $('scInstallTitle').textContent = 'Script ainda não instalado';
    $('scInstallTitle').className = 'text-sm font-bold text-gray-200';
    $('scInstallDesc').textContent = 'Precisa do escopo write_script_tags na loja vitrine.';
  }
}

async function scLoad() {
  try { scRender(await api('/api/script/status')); } catch { /* painel fica como está */ }
}

async function scSaveConfig() {
  try {
    const res = await fetch('/api/script/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: $('scEnabled').checked, mode: $('scMode').value, keepParams: $('scKeep').checked }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Falha ao salvar.');
    showLojaToast('✓ Salvo', $('scEnabled').checked ? 'Redirect ligado.' : 'Redirect desligado — o script fica inerte.');
    scLoad();
  } catch (e) { showLojaToast('✗ Erro', e.message); scLoad(); }
}

async function scInstall(remover) {
  const btn = remover ? $('scRemoveBtn') : $('scInstallBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/script/${remover ? 'remove' : 'install'}`, { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Falha.');
    showLojaToast(remover ? '✓ Script removido' : '✓ Script instalado', remover ? 'A vitrine não redireciona mais.' : 'A vitrine já está redirecionando os produtos mapeados.');
    scLoad();
  } catch (e) {
    showLojaToast('✗ Erro', e.message);
  } finally { btn.disabled = false; }
}

/* ---------- Pós-compra digital (real) ---------- */

let ppState = null;

function ppRender(d) {
  ppState = d;
  const c = d.config || {};
  $('ppEnabled').checked = !!c.enabled;
  $('ppQty').value = c.quantity || 1;
  $('ppTag').value = c.orderTag || 'dr:auto-digital';

  // opções de produto digital (SKUs presentes nas lojas do pool)
  const sel = $('ppVariant');
  sel.innerHTML = '<option value="">Selecione o produto digital</option>' +
    (d.variants || []).map((v) => {
      const price = v.price ? ` — ${fmtMoney(parseFloat(v.price) || 0)}` : '';
      return `<option value="${esc(v.sku)}" ${c.sku && v.sku.toUpperCase() === c.sku.toUpperCase() ? 'selected' : ''}>${esc(v.title)}${price} · SKU: ${esc(v.sku)}</option>`;
    }).join('');
  if (!(d.variants || []).length) {
    sel.innerHTML = '<option value="">Nenhum produto com SKU nas lojas do pool</option>';
  }

  $('ppStatusText').textContent = c.enabled
    ? `Ativo desde ${timeAgo(c.startAt)} — só processa pedidos a partir daí`
    : 'Inativo — ative para criar o pedido digital automático';

  // cobertura
  const cov = d.coverage || { total: 0, withSku: 0, missing: [] };
  const wrap = $('ppCoverageWrap'), txt = $('ppCoverageText'), miss = $('ppCoverageMissing');
  if (!c.sku) {
    wrap.className = 'rounded-xl border border-white/10 bg-black/25 px-3 py-2';
    txt.className = 'text-[11px] text-gray-400';
    txt.textContent = 'Escolha o produto digital para checar a cobertura no pool.';
    miss.textContent = '';
  } else if (!cov.total) {
    wrap.className = 'rounded-xl border border-white/10 bg-black/25 px-3 py-2';
    txt.className = 'text-[11px] text-gray-400';
    txt.textContent = 'Sem lojas no pool para validar a cobertura.';
    miss.textContent = '';
  } else if (!cov.missing.length) {
    wrap.className = 'rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2';
    txt.className = 'text-[11px] text-emerald-300';
    txt.textContent = `Cobertura OK: o SKU existe em ${cov.withSku}/${cov.total} loja(s) do pool.`;
    miss.textContent = '';
  } else {
    wrap.className = 'rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2';
    txt.className = 'text-[11px] text-amber-300';
    txt.textContent = `Cobertura parcial: ${cov.withSku}/${cov.total} loja(s) têm esse SKU.`;
    miss.textContent = `Sem o produto: ${cov.missing.map((m) => m.name).join(', ')}`;
  }

  // última execução + estatísticas
  const st = d.stats || { created: 0, failed: 0, total: 0 };
  $('ppExecStats').textContent = `Total: ${st.total} | Criados: ${st.created} | Falhas: ${st.failed}`;
  const e = d.lastExecution;
  const title = $('ppExecTitle'), det = $('ppExecDetails');
  if (!e) {
    title.textContent = 'Ainda sem execuções';
    title.className = 'text-xs font-bold text-gray-300';
    det.textContent = 'Nenhum pedido digital foi gerado até agora.';
  } else if (e.status === 'created') {
    title.textContent = 'Último pedido digital: criado';
    title.className = 'text-xs font-bold text-emerald-400';
    det.textContent = `${e.storeName} · origem ${e.sourceOrderId} → gerado ${e.createdOrderId} · ${timeAgo(e.at)}`;
  } else {
    title.textContent = 'Última tentativa: falhou';
    title.className = 'text-xs font-bold text-rose-400';
    det.textContent = `${e.storeName} · origem ${e.sourceOrderId} · ${timeAgo(e.at)} · ${e.error || ''}`;
  }
}

async function ppLoad() {
  try { ppRender(await api('/api/post-purchase')); } catch { /* painel fica no estado inicial */ }
}

async function ppSave({ runNow = false } = {}) {
  const body = {
    enabled: $('ppEnabled').checked,
    sku: $('ppVariant').value,
    quantity: parseInt($('ppQty').value, 10) || 1,
    orderTag: $('ppTag').value,
  };
  try {
    const res = await fetch('/api/post-purchase', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar.');
    if (runNow && data.config.enabled) {
      showLojaToast('↻ Rodando pós-compra', 'Procurando pedidos pagos novos nas lojas do pool…');
      const r = await fetch('/api/post-purchase/run', { method: 'POST' });
      const rd = await r.json();
      if (rd.created) showLojaToast('✓ Pedidos digitais criados', `${rd.created} pedido(s) gerado(s) agora.`);
      else showLojaToast('✓ Pós-compra ativo', 'Nenhum pedido pago novo por enquanto — ele roda sozinho a cada 60s.');
    } else {
      showLojaToast('✓ Configuração salva', data.config.enabled ? 'Pós-compra digital ativo.' : 'Pós-compra digital desativado.');
    }
    await ppLoad();
  } catch (e) {
    showLojaToast('✗ Erro', e.message);
    await ppLoad(); // volta o toggle ao estado real
  }
}

/* modal simples para mapeamento/grupos */
function drModal(title, html) {
  const o = $('drModal');
  $('drModalTitle').textContent = title;
  $('drModalBody').innerHTML = html;
  o.hidden = false;
}
function drModalClose() { $('drModal').hidden = true; }

const MATCH_LABEL = {
  exact: ['SKU exato', 'st-paid'],
  partial: ['SKU parcial', 'st-pending'],
  consolidation: ['Consolidado', 'st-other'],
  manual: ['Manual', 'st-manual'],
};

function amMatchBadge(matchType) {
  const [lbl, cls] = MATCH_LABEL[matchType] || ['Sem match', 'st-refunded'];
  return `<span class="status-badge ${cls}">${lbl}</span>`;
}

/*
 * Editor de mapeamento: para cada produto da vitrine, escolher para qual
 * produto da loja de checkout ele aponta (ou deixar no automático por SKU).
 */
async function amShowMapping(storeId, storeName) {
  try {
    const [{ rows, lastSyncAt }, { variants }] = await Promise.all([
      api(`/api/automatch/mapping?store=${storeId}`),
      api(`/api/automatch/variants?store=${storeId}`),
    ]);
    if (!rows.length) {
      return drModal(`Mapeamento — ${storeName}`,
        '<p class="hint">Nenhum mapeamento ainda. Rode o <strong>AutoMatch</strong> primeiro (botão "Sincronizar Produtos" ou "Executar Consolidação SKU") — depois você pode ajustar cada par aqui à mão.</p>');
    }
    const opts = (row) => {
      const autoLabel = row.matchType && row.matchType !== 'manual' && row.storeTitle
        ? `Automático por SKU → ${row.storeTitle}`
        : 'Automático por SKU (sem match)';
      const isManual = row.matchType === 'manual';
      return `<option value="" ${isManual ? '' : 'selected'}>${esc(autoLabel)}</option>` +
        variants.map((v) => `<option value="${v.variantId}" ${isManual && String(row.storeVariantId) === String(v.variantId) ? 'selected' : ''}>${esc(v.title)}${v.sku ? ` · SKU: ${esc(v.sku)}` : ''}</option>`).join('');
    };
    const body = `<p class="hint">Sincronizado ${timeAgo(lastSyncAt)} · ${rows.length} produto(s) da vitrine · escolha à mão para onde cada um aponta nesta loja de checkout. O par manual <strong>sobrepõe</strong> a regra de SKU.</p>
      <div class="table-scroll"><table class="data-table map-table"><thead><tr><th>Produto da vitrine</th><th>SKU</th><th>Vai para (checkout)</th><th>Match</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-vid="${esc(String(r.vitrineVariantId))}">
        <td>${esc(r.vitrineTitle)}</td>
        <td class="mono">${esc(r.vitrineSku || '—')}</td>
        <td><select class="map-select" data-store="${esc(storeId)}" data-vid="${esc(String(r.vitrineVariantId))}">${opts(r)}</select></td>
        <td class="map-badge">${amMatchBadge(r.matchType)}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
    drModal(`Mapeamento — ${storeName}`, body);

    $('drModalBody').querySelectorAll('.map-select').forEach((sel) => sel.addEventListener('change', async () => {
      const tr = sel.closest('tr');
      const badge = tr.querySelector('.map-badge');
      badge.innerHTML = '<span class="status-badge st-other">salvando…</span>';
      try {
        const res = await fetch('/api/automatch/override', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId: sel.dataset.store, vitrineVariantId: sel.dataset.vid, storeVariantId: sel.value || null }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar o par.');
        badge.innerHTML = amMatchBadge(sel.value ? 'manual' : null);
        if (data.stats) { amState = { ...(amState || {}), stats: data.stats }; amRender(amState); }
        showLojaToast(sel.value ? '✓ Par manual salvo' : '✓ Voltou ao automático', sel.value ? 'Esse produto da vitrine aponta para o que você escolheu.' : 'A regra de SKU volta a valer no próximo AutoMatch.');
        loadFlowView();
      } catch (e) {
        badge.innerHTML = '<span class="status-badge st-refunded">erro</span>';
        showLojaToast('✗ Erro', e.message);
      }
    }));
  } catch (e) { showLojaToast('✗ Erro', e.message); }
}

async function amShowGroups() {
  if (!amState || !amState.stats) return showLojaToast('Sem dados', 'Rode o AutoMatch primeiro.');
  try {
    const { mapping } = await api('/api/automatch/mapping');
    const bySku = new Map();
    const first = Object.values(mapping)[0] || [];
    for (const r of first) {
      const k = (r.vitrineSku || '').toUpperCase();
      if (!k) continue;
      if (!bySku.has(k)) bySku.set(k, []);
      bySku.get(k).push(r);
    }
    const groups = [...bySku.entries()].sort((a, b) => b[1].length - a[1].length);
    const body = `<p class="hint">${groups.length} grupo(s) de SKU na vitrine · grupos com mais de 1 produto são consolidados (many-to-one).</p>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>SKU</th><th class="num">Produtos na vitrine</th><th>Tipo</th></tr></thead><tbody>
      ${groups.map(([sku, list]) => `<tr><td class="mono">${esc(sku)}</td><td class="num">${list.length}</td><td>${list.length > 1 ? '<span class="status-badge st-other">Consolidado</span>' : '<span class="status-badge st-paid">Único</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
    drModal('Grupos de SKU da vitrine', body);
  } catch (e) { showLojaToast('✗ Erro', e.message); }
}

function amShowCoverage() {
  if (!amState || !amState.stats) return showLojaToast('Sem dados', 'Rode o AutoMatch primeiro.');
  const st = amState.stats;
  const body = `<p class="hint">Vitrine: <strong>${esc(st.vitrine.name)}</strong> · ${fmtInt(st.vitrine.withSku)} de ${fmtInt(st.vitrine.variants)} variantes têm SKU.</p>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Loja do pool</th><th class="num">Mapeados</th><th class="num">Sem match</th><th>Status</th></tr></thead><tbody>
    ${st.stores.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${fmtInt(s.matched)}</td><td class="num">${fmtInt(s.unmatched)}</td><td>${s.error ? `<span class="store-err">${esc(s.error)}</span>` : '<span class="status-badge st-paid">OK</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
  drModal('Relatório de cobertura', body);
}

// persistência dos toggles (checkbox) e ações do header do flow
document.querySelectorAll('#page-flow [data-persist]').forEach((cb) => {
  const key = `flowtg_${cb.dataset.persist}`;
  const saved = localStorage.getItem(key);
  if (saved === '1') cb.checked = true;
  else if (saved === '0') cb.checked = false;
  cb.addEventListener('change', () => localStorage.setItem(key, cb.checked ? '1' : '0'));
});
$('flowSyncBtn').addEventListener('click', () => { showLojaToast('↻ Sincronizando', 'Atualizando estado do flow…'); loadFlowView(); });
$('flowAnalyticsBtn').addEventListener('click', drShowAnalytics);
$('flowPayBtn').addEventListener('click', drIllustrative);

// AutoMatch: config + sync + modais
$('amSuffix').addEventListener('change', amSaveConfig);
$('amStrategy').addEventListener('change', amSaveConfig);
$('amEnabled').addEventListener('change', amSaveConfig);
$('amSyncBtn').addEventListener('click', () => amSync($('amSyncBtn')));
$('amSyncProductsBtn').addEventListener('click', () => amSync($('amSyncProductsBtn')));
$('amViewGroups').addEventListener('click', amShowGroups);
$('amViewDetails').addEventListener('click', amShowCoverage);

// Redirect da vitrine
$('scEnabled').addEventListener('change', scSaveConfig);
$('scMode').addEventListener('change', scSaveConfig);
$('scKeep').addEventListener('change', scSaveConfig);
$('scInstallBtn').addEventListener('click', () => scInstall(false));
$('scRemoveBtn').addEventListener('click', () => scInstall(true));

// Pós-compra digital
$('ppEnabled').addEventListener('change', () => ppSave({ runNow: true }));
$('ppVariant').addEventListener('change', () => ppSave());
$('ppSaveBtn').addEventListener('click', () => ppSave({ runNow: true }));
$('drModal').addEventListener('click', (e) => { if (e.target === $('drModal')) drModalClose(); });
window.addEventListener('resize', () => { if (state.tab === 'flow') updateFlowPaths(); });

/* ================= ANALYTICS (sub-view do Flow) ================= */

let anRange = 'today';

function drShowAnalytics() {
  $('flow-main').hidden = true;
  $('flow-analytics').hidden = false;
  window.scrollTo(0, 0);
  renderAnalytics();
}
function drHideAnalytics() {
  $('flow-analytics').hidden = true;
  $('flow-main').hidden = false;
  requestAnimationFrame(updateFlowPaths);
}

document.querySelectorAll('#an-ranges [data-anrange]').forEach((b) => b.addEventListener('click', () => {
  anRange = b.dataset.anrange;
  document.querySelectorAll('#an-ranges [data-anrange]').forEach((x) => {
    const on = x === b;
    x.className = `px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${on ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-white/10 text-gray-400 hover:text-gray-700'}`;
  });
  renderAnalytics();
}));

function anStat(id, val) { const el = $(id); if (el) el.textContent = val; }

async function renderAnalytics() {
  try {
    const [m, fl, live] = await Promise.all([
      api(`/api/metrics?range=${anRange}&store=all`),
      api('/api/flow').catch(() => null),
      api('/api/live?store=all').catch(() => null),
    ]);
    state.currency = m.currency || 'BRL';
    $('an-sub').textContent = `${fl && fl.vitrine ? fl.vitrine.name + ' · ' : ''}Centro de Inteligência`;

    // Resultados de vendas
    anStat('an-vendas', fmtInt(m.totals.orders));
    anStat('an-faturamento', fmtMoney(m.totals.sales));
    anStat('an-ticket', fmtMoney(m.totals.aov));
    anStat('an-rotacoes', fmtInt(parseInt(localStorage.getItem('flowSkips') || '0', 10)));
    anStat('an-boletos', '0');

    // Funil de conversão (impressões ilustrativas; cliques = pedidos)
    const impressions = 17 + m.totals.orders * 13;
    const clicks = m.totals.orders;
    anStat('an-impressoes', fmtInt(impressions));
    anStat('an-cliques', fmtInt(clicks));
    anStat('an-taxaclique', `${((clicks / Math.max(1, impressions)) * 100).toFixed(1).replace('.', ',')}%`);
    anStat('an-conversao', `${((m.totals.orders / Math.max(1, impressions)) * 100).toFixed(1).replace('.', ',')}%`);

    // Performance de redirecionamento
    const checkout = (fl && fl.checkout) || [];
    const activeIdx = checkout.findIndex((s) => s.active);
    anStat('an-redirok', fmtInt(m.totals.orders));
    anStat('an-taxasucesso', '100%');
    anStat('an-poolredir', fmtInt(m.totals.orders));
    anStat('an-poolstatus', `${checkout.length ? activeIdx + 1 : 0}/${checkout.length}`);

    // Visitantes 60min
    anStat('an-60orders', fmtInt(live ? live.orders60m : 0));
    anStat('an-60revenue', fmtMoney(live ? live.sales60m : 0));
    anStat('an-totalviews', fmtInt(impressions));
    anStat('an-sessions', fmtInt(clicks + Math.round(impressions * 0.6)));

    // Top países
    $('an-paises').innerHTML = (m.topCountries || []).length
      ? m.topCountries.map((c) => `<div class="flex items-center justify-between py-1 text-xs"><span class="flex items-center gap-2 min-w-0"><span>${flagEmoji(c.code)}</span><span class="text-gray-600 truncate">${esc(c.country)}</span></span><span class="font-bold tabular-nums">${fmtInt(c.orders)}</span></div>`).join('')
      : '<div class="text-xs text-gray-400 py-1">Sem dados no período.</div>';

    // Top cidades (agregadas dos pedidos recentes)
    const cityMap = new Map();
    for (const o of (m.recentOrders || [])) { if (!o.city) continue; cityMap.set(o.city, (cityMap.get(o.city) || 0) + 1); }
    const cities = [...cityMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('an-cidades').innerHTML = cities.length
      ? cities.map(([city, n]) => `<div class="flex items-center justify-between py-1 text-xs"><span class="text-gray-600 truncate">${esc(city)}</span><span class="font-bold tabular-nums">${fmtInt(n)}</span></div>`).join('')
      : '<div class="text-xs text-gray-400 py-1">Sem dados no período.</div>';

    // Eventos recentes
    $('an-timeline').innerHTML = (m.recentOrders || []).length
      ? m.recentOrders.slice(0, 8).map((o) => `<div class="flex items-center gap-3 py-2 border-t border-[var(--grid)] first:border-t-0"><span class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined text-emerald-400 text-base">shopping_bag</span></span><div class="flex-1 min-w-0"><div class="text-xs font-bold truncate">${esc(o.number)} · ${esc(o.store)}</div><div class="text-[11px] text-gray-500">${esc(o.city || '—')} · ${timeAgo(o.createdAt)}</div></div><span class="text-xs font-bold text-emerald-600">${fmtMoney(o.total)}</span></div>`).join('')
      : '<div class="text-center text-gray-400 text-sm py-8">Nenhuma atividade registrada no período.</div>';

    // Checkout pool
    anStat('an-poolcount', `${checkout.length} loja${checkout.length === 1 ? '' : 's'}`);
    $('an-pool').innerHTML = checkout.length
      ? checkout.map((s, i) => {
          const pct = Math.min(100, s.limit ? (s.sales / s.limit) * 100 : 0);
          const barc = s.active ? 'var(--live)' : pct >= 100 ? 'var(--bad)' : 'var(--accent)';
          return `<div><div class="flex items-center justify-between mb-1"><span class="flex items-center gap-2 text-xs font-bold min-w-0"><span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${barc}"></span><span class="truncate">${esc(s.name)}</span>${s.active ? '<span class="text-[9px] text-emerald-600">ATIVA</span>' : ''}</span><span class="text-xs font-bold tabular-nums">${fmtInt(s.sales)}/${fmtInt(s.limit)}</span></div><div class="h-1.5 rounded-full overflow-hidden" style="background:var(--track)"><div class="h-full rounded-full" style="width:${pct}%;background:${barc}"></div></div></div>`;
        }).join('')
      : '<div class="text-xs text-gray-400">Sem lojas de checkout no pool.</div>';

    renderAnChart(m.series);
    drawVisitorMap(m.geoPoints || []);
  } catch (e) {
    anStat('an-faturamento', '—');
  }
}

function renderAnChart(series) {
  const wrap = $('anChartWrap');
  const svg = $('anChart');
  svg.innerHTML = '';
  svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block';
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const PAD = { top: 12, right: 14, bottom: 24, left: 50 };
  const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
  const values = series.current, labels = series.labels, n = labels.length;
  const colGrid = cssVar('--grid'), colBase = cssVar('--baseline'), colMuted = cssVar('--text-muted'), colGood = cssVar('--good');
  const ticks = niceTicks(Math.max(1, ...values)), yMax = ticks[ticks.length - 1];
  const x = (i) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PAD.top + ih - (v / yMax) * ih;
  for (const t of ticks) {
    svg.appendChild(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), stroke: t === 0 ? colBase : colGrid, 'stroke-width': 1 }));
    const lbl = el('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: colMuted });
    lbl.textContent = fmtMoneyCompact(t);
    svg.appendChild(lbl);
  }
  const every = Math.ceil(n / (iw > 600 ? 10 : 6));
  for (let i = 0; i < n; i += every) {
    const lbl = el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: colMuted });
    lbl.textContent = labels[i];
    svg.appendChild(lbl);
  }
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const defs = el('defs', {});
  defs.innerHTML = `<linearGradient id="anAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colGood}" stop-opacity="0.18"/><stop offset="1" stop-color="${colGood}" stop-opacity="0"/></linearGradient>`;
  svg.appendChild(defs);
  svg.appendChild(el('path', { d: `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`, fill: 'url(#anAreaGrad)', stroke: 'none' }));
  svg.appendChild(el('path', { d: line, fill: 'none', stroke: colGood, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

function drawVisitorMap(points) {
  const canvas = $('anGlobe');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const proj = (lat, lng) => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
  // terra (land dots)
  ctx.fillStyle = cssVar('--baseline');
  for (const d of globe.land) {
    const la = d.lat ?? d[0], lo = d.lng ?? d[1];
    if (la == null || lo == null) continue;
    const [px, py] = proj(la, lo);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(px, py, 1.2, 1.2);
  }
  ctx.globalAlpha = 1;
  // pedidos (pontos verdes com glow)
  const good = cssVar('--live');
  for (const p of points) {
    if (p.lat == null || p.lng == null) continue;
    const [px, py] = proj(p.lat, p.lng);
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(18,183,106,0.15)'; ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = good; ctx.fill();
  }
}

setInterval(() => {
  if (state.tab !== 'flow') return;
  if ($('flow-analytics') && !$('flow-analytics').hidden) renderAnalytics();
  else loadFlowView();
}, 30000);

/* ---------- globo (canvas, projeção ortográfica) ---------- */

const globe = { land: [], points: [], pings: [], rot: 0.8, last: 0 };

async function initGlobe() {
  try {
    globe.land = await (await fetch('/land-dots.json')).json();
  } catch {
    globe.land = [];
  }
  requestAnimationFrame(globeTick);
}

const TILT = -0.45; // inclina para o hemisfério sul (Brasil em evidência)

function project3d(latDeg, lngDeg, R) {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lngDeg * Math.PI) / 180 + globe.rot;
  const x = Math.cos(la) * Math.sin(lo);
  const y = Math.sin(la);
  const z = Math.cos(la) * Math.cos(lo);
  const y2 = y * Math.cos(TILT) - z * Math.sin(TILT);
  const z2 = y * Math.sin(TILT) + z * Math.cos(TILT);
  return { x: x * R, y: -y2 * R, z: z2 };
}

function globeTick(ts) {
  requestAnimationFrame(globeTick);
  const dt = globe.last ? Math.min(0.1, (ts - globe.last) / 1000) : 0;
  globe.last = ts;
  if (state.tab !== 'command') return; // pausa fora da aba

  const canvas = $('globe');
  const wrap = canvas.parentElement;
  const size = Math.min(wrap.clientWidth, wrap.clientHeight || 999, 460);
  if (size < 60) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  globe.rot += dt * 0.10; // rotação lenta

  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.42;

  // halo suave (estilo airy light)
  let g = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.22);
  g.addColorStop(0, 'rgba(42, 120, 214, 0)');
  g.addColorStop(0.55, 'rgba(42, 120, 214, 0.10)');
  g.addColorStop(1, 'rgba(42, 120, 214, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2);
  ctx.fill();

  // esfera clara
  g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#e3edfb');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // borda
  ctx.strokeStyle = 'rgba(42, 120, 214, 0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();

  // continentes em pontinhos azuis
  for (let i = 0; i < globe.land.length; i++) {
    const p = project3d(globe.land[i][0], globe.land[i][1], R);
    if (p.z <= 0.02) continue;
    ctx.fillStyle = `rgba(42, 120, 214, ${(0.14 + 0.42 * p.z).toFixed(2)})`;
    ctx.fillRect(cx + p.x - 0.8, cy + p.y - 0.8, 1.7, 1.7);
  }

  // pedidos — pontos verdes (mais recentes ficam mais fortes)
  const now = Date.now();
  for (const pt of globe.points) {
    const p = project3d(pt.lat, pt.lng, R);
    if (p.z <= 0.02) continue;
    const ageH = (now - pt.t) / 36e5;
    const alpha = Math.max(0.4, 1 - ageH / 24) * (0.45 + 0.55 * p.z);
    ctx.save();
    ctx.shadowColor = 'rgba(4, 118, 71, 0.55)';
    ctx.shadowBlur = 5;
    ctx.fillStyle = `rgba(4, 148, 88, ${alpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(cx + p.x, cy + p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // pings de pedido novo (anel expansivo por ~4s)
  globe.pings = globe.pings.filter((pg) => ts - pg.born < 4000);
  for (const pg of globe.pings) {
    const p = project3d(pg.lat, pg.lng, R);
    if (p.z <= 0.02) continue;
    const k = (ts - pg.born) / 4000;
    ctx.strokeStyle = `rgba(4, 148, 88, ${(0.8 * (1 - k)).toFixed(2)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx + p.x, cy + p.y, 3 + k * 20, 0, Math.PI * 2);
    ctx.stroke();
  }
}

initGlobe();

/* ---------- inicialização ---------- */

async function refreshAll() {
  await loadStores();
  await Promise.all([loadMetrics(), loadLive()]);
}

refreshAll();
setInterval(loadMetrics, 60000);
setInterval(loadLive, 25000);

/* ================= ABA LOJAS ================= */

const lojas = { view: 'list', wizardStep: 1, wizardMode: 'custom', detailId: null, detailTab: 'overview', overview: [], lastConnected: null };

function lojasShow(view) {
  lojas.view = view;
  $('lojasList').hidden = view !== 'list';
  $('lojasConnect').hidden = view !== 'connect';
  $('lojasDetail').hidden = view !== 'detail';
}

function platformLabel(p) {
  return { shopify: 'Shopify', woocommerce: 'WooCommerce', cartpanda: 'Cartpanda', yampi: 'Yampi', tray: 'Tray', lojaintegrada: 'Loja Integrada', shopee: 'Shopee' }[p] || 'Shopify';
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* ---------- lista de lojas ---------- */

async function loadLojas() {
  // clicar na aba Lojas sempre volta para a lista (é a "home" da seção)
  lojasShow('list');
  const grid = $('storesGrid');
  try {
    const data = await api('/api/stores/overview');
    lojas.overview = data.stores;
    renderStoresGrid(data.stores);
  } catch (e) {
    grid.innerHTML = `<div class="store-card-skeleton">Erro ao carregar lojas: ${esc(e.message)}</div>`;
  }
}

function renderStoresGrid(stores) {
  const grid = $('storesGrid');
  const cards = stores.map((s) => {
    const initial = esc((s.name || '?').charAt(0).toUpperCase());
    const products = s.products == null ? '—' : fmtInt(s.products);
    const ok = s.status !== 'error';
    return `<div class="store-card" data-id="${esc(s.id)}">
      <div class="sc-top">
        <span class="sc-logo">${initial}</span>
        <div class="sc-head-info">
          <div class="sc-store-name">${esc(s.name)}</div>
          <div class="sc-store-domain"><a href="https://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)} ↗</a></div>
        </div>
        <button class="sc-menu" title="Opções" data-menu="${esc(s.id)}">⋯</button>
      </div>
      <div class="sc-tags">
        <span class="badge ${ok ? 'badge-ok' : 'badge-err'}">${ok ? 'CONECTADA' : 'ERRO'}</span>
        <span class="sc-plat-name">${esc(platformLabel(s.platform))}</span>
      </div>
      <div class="sc-stats">
        <div><div class="sc-stat-label">Produtos</div><div class="sc-stat-value">${products}</div></div>
        <div><div class="sc-stat-label">Pedidos</div><div class="sc-stat-value">${fmtInt(s.orders30d)}</div></div>
        <div><div class="sc-stat-label">Status</div><div class="sc-stat-value ${ok ? 'active' : ''}">${ok ? 'Ativo' : 'Falha'}</div></div>
      </div>
      ${ok ? '' : `<div class="sc-error">${esc(s.error || 'Falha ao consultar a Shopify.')}</div>`}
      <div class="sc-footer">
        <button class="sc-camuflar" data-camuflar="${esc(s.id)}">🥷 Camuflar loja</button>
        <button class="sc-details" data-details="${esc(s.id)}">Ver detalhes →</button>
      </div>
    </div>`;
  });

  cards.push(`<div class="store-card-add" id="storeAddCard">
    <span class="sca-plus">+</span>
    <span class="sca-title">Conectar nova loja</span>
    <span class="sca-sub">Shopify, Woo, Cartpanda, Yampi…</span>
  </div>`);

  grid.innerHTML = cards.join('');

  grid.querySelectorAll('[data-details]').forEach((b) => b.addEventListener('click', () => openLojaDetail(b.dataset.details)));
  grid.querySelectorAll('.store-card').forEach((c) => c.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    openLojaDetail(c.dataset.id);
  }));
  grid.querySelectorAll('[data-camuflar]').forEach((b) => b.addEventListener('click', () => {
    showLojaToast('🥷 Camuflagem', 'Recurso de camuflagem em breve nesta build.');
  }));
  grid.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', () => openLojaDetail(b.dataset.menu)));
  $('storeAddCard').addEventListener('click', openWizard);
}

function showLojaToast(title, body) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-body">${esc(body)}</div>`;
  $('toasts').appendChild(div);
  setTimeout(() => { div.classList.add('leaving'); setTimeout(() => div.remove(), 350); }, 5000);
}

$('lojasNewBtn').addEventListener('click', openWizard);
$('promoCta').addEventListener('click', openWizard);

/* ---------- wizard ---------- */

function openWizard() {
  lojasShow('connect');
  gotoStep(1);
  setWizardMode('custom');
  $('wizDomain').value = '';
  $('wizToken').value = '';
  $('wizName').value = '';
  $('oauthDomain').value = '';
  $('oauthClientId').value = '';
  $('oauthSecret').value = '';
  setWizStatus('wizStatus', '', '');
  setWizStatus('oauthStatus', '', '');
}

function gotoStep(n) {
  lojas.wizardStep = n;
  document.querySelectorAll('#stepper .step').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  });
  document.querySelectorAll('#lojasConnect .wiz-step').forEach((p) => { p.hidden = Number(p.dataset.panel) !== n; });
}

function setWizardMode(mode) {
  lojas.wizardMode = mode;
  document.querySelectorAll('.mode-opt').forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
  document.querySelectorAll('.mode-panel').forEach((p) => { p.hidden = p.dataset.modePanel !== mode; });
  $('wizValidate').innerHTML = mode === 'oauth' ? '↗ Autorizar via OAuth' : '⚡ Validar e conectar';
  if (mode === 'oauth') loadOauthInfo();
}

// volta do OAuth: a Shopify redireciona para /?conectada=<loja>
{
  const q = new URLSearchParams(location.search);
  const conectada = q.get('conectada');
  if (conectada) {
    history.replaceState({}, '', location.pathname);
    setTimeout(() => {
      showLojaToast('✓ Loja conectada por OAuth', `${conectada} entrou no painel.`);
      document.querySelector('.tab-btn[data-tab="lojas"]').click();
    }, 400);
  }
}

function setWizStatus(id, msg, cls) {
  const el = $(id);
  el.textContent = msg;
  el.className = `wiz-status ${cls}`;
}

$('wizBack').addEventListener('click', () => { lojasShow('list'); loadLojas(); });
$('wizCancel').addEventListener('click', () => { lojasShow('list'); loadLojas(); });
$('wizToStep2').addEventListener('click', () => gotoStep(2));
$('wizToStep1').addEventListener('click', () => gotoStep(1));
document.querySelectorAll('.mode-opt').forEach((b) => b.addEventListener('click', () => setWizardMode(b.dataset.mode)));
$('oauthToCustom').addEventListener('click', () => setWizardMode('custom'));

/* ---------- OAuth (Partner App) ---------- */

async function loadOauthInfo() {
  try {
    const d = await api('/api/oauth/info');
    $('oauthRedirectUri').textContent = d.redirectUri;
    $('oauthAppUrlHint').innerHTML = `Em <strong>App URL</strong> use <code>${esc(d.appUrl)}</code>. Escopos pedidos: <code>${d.scopes.map(esc).join(', ')}</code>.` +
      (d.hasConfig ? ' <strong>Client ID/Secret já salvos</strong> — pode deixar os campos em branco.' : '');
  } catch { /* mantém "carregando…" */ }
}

$('copyRedirectBtn').addEventListener('click', async () => {
  const url = $('oauthRedirectUri').textContent;
  try {
    await navigator.clipboard.writeText(url);
    showLojaToast('URL copiada', 'Cole em Allowed redirection URL(s) no Partner Dashboard.');
  } catch {
    showLojaToast('Copie manualmente', url);
  }
});

async function oauthStart() {
  const domain = $('oauthDomain').value.trim();
  if (!domain) { setWizStatus('oauthStatus', '✗ Informe o domínio .myshopify.com da loja.', 'err'); return; }
  setWizStatus('oauthStatus', 'Preparando a autorização…', 'loading');
  try {
    const res = await fetch('/api/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, clientId: $('oauthClientId').value.trim(), secret: $('oauthSecret').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao iniciar o OAuth.');
    setWizStatus('oauthStatus', 'Redirecionando para a Shopify…', 'ok');
    window.location.href = data.url; // o lojista aceita as permissões lá
  } catch (e) {
    setWizStatus('oauthStatus', `✗ ${e.message}`, 'err');
  }
}

$('wizValidate').addEventListener('click', async () => {
  if (lojas.wizardMode === 'oauth') return oauthStart();
  const domain = $('wizDomain').value.trim();
  const token = $('wizToken').value.trim();
  const name = $('wizName').value.trim();
  if (!domain || !token) { setWizStatus('wizStatus', '✗ Informe o domínio e o token.', 'err'); return; }
  setWizStatus('wizStatus', 'Validando token na Shopify…', 'loading');
  try {
    const res = await fetch('/api/stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, domain, token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao conectar.');
    lojas.lastConnected = data.store;
    setWizStatus('wizStatus', '', '');
    showWizardSuccess(data.store);
    loadStores();
  } catch (e) {
    setWizStatus('wizStatus', `✗ ${e.message}`, 'err');
  }
});

function showWizardSuccess(store) {
  gotoStep(3);
  $('wizSuccessSub').textContent = `${store.name} está pronta no seu painel.`;
  $('wizReview').innerHTML = `
    <div><dt>Loja</dt><dd>${esc(store.name)}</dd></div>
    <div><dt>Domínio</dt><dd>${esc(store.domain)}</dd></div>
    <div><dt>Plataforma</dt><dd>${esc(platformLabel(store.platform))}</dd></div>
    <div><dt>Moeda</dt><dd>${esc(store.currency)}</dd></div>
    <div><dt>Conexão</dt><dd>Custom App (Admin API)</dd></div>`;
}

// copia os escopos obrigatórios (Custom App e OAuth)
// Admin API (os unauthenticated_* ficam na seção Storefront API do app)
const ESSENTIAL_SCOPES = 'read_orders,read_products,write_orders,read_script_tags,write_script_tags,read_themes,write_themes';
[['copyScopesBtn', 'Marque-os no Custom App e gere um token novo.'],
 ['copyScopesOauthBtn', 'Declare-os no app (App setup → Admin API access scopes) e reautorize a loja.']]
  .forEach(([id, hint]) => $(id).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ESSENTIAL_SCOPES);
      showLojaToast('Escopos copiados', `${ESSENTIAL_SCOPES} — ${hint}`);
    } catch {
      showLojaToast('Escopos obrigatórios', ESSENTIAL_SCOPES);
    }
  }));

$('wizAddAnother').addEventListener('click', openWizard);
$('wizGoDetail').addEventListener('click', () => {
  if (lojas.lastConnected) openLojaDetail(lojas.lastConnected.id);
  else { lojasShow('list'); loadLojas(); }
});

/* ---------- detalhe da loja ---------- */

function openLojaDetail(id) {
  lojas.detailId = id;
  lojas.detailTab = 'overview';
  setDetailTab('overview');
  lojasShow('detail');
  loadLojasDetail(id);
}

async function loadLojasDetail(id) {
  const s = lojas.overview.find((x) => x.id === id);
  const name = s ? s.name : '—';
  const domain = s ? s.domain : '';
  $('detailName').textContent = name;
  document.querySelector('.detail-ico').textContent = (name.charAt(0) || '🛍').toUpperCase();
  const dom = $('detailDomain');
  dom.textContent = domain ? `${domain} ↗` : '—';
  dom.href = domain ? `https://${domain}` : '#';
  const ok = !s || s.status !== 'error';
  $('detailStatus').textContent = ok ? 'CONECTADA' : 'ERRO';
  $('detailStatus').className = `badge ${ok ? 'badge-ok' : 'badge-err'}`;

  if (s) {
    $('sumPlatform').textContent = platformLabel(s.platform);
    $('sumProducts').textContent = s.products == null ? '—' : fmtInt(s.products);
    $('sumConnected').textContent = fmtDate(s.connectedAt);
    $('dCloaker').textContent = fmtInt(s.cloakerHits || 0);
    $('sumCloaker').textContent = fmtInt(s.cloakerHits || 0);
  }

  try {
    const m = await api(`/api/metrics?range=30d&store=${id}`);
    state.currency = m.currency || 'BRL';
    $('dRevenue').textContent = fmtMoney(m.totals.sales);
    $('dOrders').textContent = fmtInt(m.totals.orders);
    $('dAov').textContent = fmtMoney(m.totals.aov);
    $('sumOrders').textContent = fmtInt(m.totals.orders);
    renderDetailChart(m.series);
    renderDetailOrders(m.recentOrders);
  } catch (e) {
    $('dRevenue').textContent = '—';
  }
}

function renderDetailChart(series) {
  const wrap = $('dChartWrap');
  const svg = $('dChart');
  svg.innerHTML = '';
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const PAD = { top: 12, right: 14, bottom: 26, left: 52 };
  const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
  const values = series.current, labels = series.labels, n = labels.length;
  const colGrid = cssVar('--grid'), colBase = cssVar('--baseline'), colMuted = cssVar('--text-muted'), colGood = cssVar('--good');
  const maxV = Math.max(1, ...values);
  const ticks = niceTicks(maxV), yMax = ticks[ticks.length - 1];
  const x = (i) => PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PAD.top + ih - (v / yMax) * ih;
  for (const t of ticks) {
    svg.appendChild(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), stroke: t === 0 ? colBase : colGrid, 'stroke-width': 1 }));
    const lbl = el('text', { x: PAD.left - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: colMuted });
    lbl.textContent = fmtMoneyCompact(t);
    svg.appendChild(lbl);
  }
  const every = Math.ceil(n / (iw > 600 ? 10 : 6));
  for (let i = 0; i < n; i += every) {
    const lbl = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: colMuted });
    lbl.textContent = labels[i];
    svg.appendChild(lbl);
  }
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const defs = el('defs', {});
  defs.innerHTML = `<linearGradient id="dAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colGood}" stop-opacity="0.18"/><stop offset="1" stop-color="${colGood}" stop-opacity="0"/></linearGradient>`;
  svg.appendChild(defs);
  svg.appendChild(el('path', { d: `${linePath}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`, fill: 'url(#dAreaGrad)', stroke: 'none' }));
  svg.appendChild(el('path', { d: linePath, fill: 'none', stroke: colGood, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

function renderDetailOrders(orders) {
  const tb = $('dOrdersTable').querySelector('tbody');
  if (!orders || !orders.length) {
    tb.innerHTML = '<tr><td colspan="5" class="sc-empty">Nenhum pedido no período.</td></tr>';
    return;
  }
  tb.innerHTML = orders.map((o) => `<tr>
    <td class="mono">${esc(o.number)}</td>
    <td>${esc(o.city || '—')}</td>
    <td class="num">${fmtMoney(o.total)}</td>
    <td>${statusBadge(o.status)}</td>
    <td class="num">${timeAgo(o.createdAt)}</td>
  </tr>`).join('');
}

const DPANEL_PLACEHOLDER = {
  colecoes: ['🗂', 'Coleções', 'Organize coleções e categorias espelhadas. Em breve nesta build.'],
  tema: ['🎨', 'Tema', 'Personalize e clone o tema da loja-modelo. Em breve.'],
  tracking: ['📊', 'Tracking', 'Pixels, UTMs e eventos de conversão. Configuração de tracking em breve.'],
  cloaker: ['🛡', 'Cloaker', 'Regras de camuflagem e proteção de campanhas. Em breve.'],
  webhooks: ['🔗', 'Webhooks', 'Automatize eventos da loja via webhooks. Em breve.'],
  config: ['⚙️', 'Configuração', 'Ajustes de moeda, sincronização e credenciais da loja. Em breve.'],
};

/* ---------- aba Produtos (catálogo real da loja) ---------- */

const PROD_STATUS = { active: ['Ativo', 'st-paid'], draft: ['Rascunho', 'st-pending'], archived: ['Arquivado', 'st-other'] };

async function loadStoreProducts(storeId) {
  const panel = document.querySelector('#lojasDetail .dpanel[data-dpanel="produtos"]');
  if (!panel) return;
  panel.innerHTML = '<div class="placeholder-empty"><span class="pe-ico">📦</span><div class="pe-title">Carregando catálogo…</div><div>Buscando os produtos na Shopify.</div></div>';
  try {
    const { products, count } = await api(`/api/stores/${storeId}/products`);
    if (!count) {
      panel.innerHTML = '<div class="placeholder-empty"><span class="pe-ico">📦</span><div class="pe-title">Nenhum produto</div><div>Esta loja ainda não tem produtos cadastrados.</div></div>';
      return;
    }
    const ativos = products.filter((p) => p.status === 'active').length;
    const semSku = products.filter((p) => !p.sku).length;
    panel.innerHTML = `<div class="card">
      <div class="card-head">
        <h2>Catálogo</h2>
        <span class="card-sub">${fmtInt(count)} produto${count > 1 ? 's' : ''} · ${fmtInt(ativos)} ativo${ativos === 1 ? '' : 's'}${semSku ? ` · <strong style="color:var(--warn)">${fmtInt(semSku)} sem SKU</strong>` : ''}</span>
      </div>
      ${semSku ? '<p class="hint">Produtos sem SKU não são mapeados pelo AutoMatch — você pode ligá-los à mão pelo Flow, em "Ver mapeamento".</p>' : ''}
      <div class="table-scroll">
        <table class="data-table prod-table">
          <thead><tr><th>Produto</th><th>SKU</th><th class="num">Variantes</th><th class="num">Preço</th><th class="num">Estoque</th><th>Status</th></tr></thead>
          <tbody>${products.map((p) => {
            const [lbl, cls] = PROD_STATUS[p.status] || [p.status || '—', 'st-other'];
            const preco = p.priceMin === p.priceMax ? fmtMoney(p.priceMin) : `${fmtMoney(p.priceMin)} – ${fmtMoney(p.priceMax)}`;
            return `<tr>
              <td><div class="prod-cell">${p.image ? `<img class="prod-img" src="${esc(p.image)}" alt="" loading="lazy">` : '<span class="prod-img prod-img-empty">📦</span>'}<div class="prod-info"><div class="prod-title">${esc(p.title)}</div>${p.vendor ? `<div class="prod-vendor">${esc(p.vendor)}</div>` : ''}</div></div></td>
              <td class="mono">${p.sku ? esc(p.sku) : '<span style="color:var(--warn)">sem SKU</span>'}</td>
              <td class="num">${fmtInt(p.variants)}</td>
              <td class="num">${preco}</td>
              <td class="num">${p.tracked ? fmtInt(p.inventory) : '—'}</td>
              <td><span class="status-badge ${cls}">${lbl}</span></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  } catch (e) {
    panel.innerHTML = `<div class="placeholder-empty"><span class="pe-ico">⚠️</span><div class="pe-title">Não deu para carregar</div><div>${esc(e.message)}</div></div>`;
  }
}

/* ---------- aba Mapeamento (vitrine → checkout, produto a produto) ---------- */

function mapAviso(ico, titulo, texto, acao) {
  return `<div class="placeholder-empty"><span class="pe-ico">${ico}</span><div class="pe-title">${titulo}</div><div>${texto}</div>${acao || ''}</div>`;
}

function mapCardHtml(linha, opcoes) {
  const v = linha.vitrine;
  const a = linha.alvo;
  const img = (src, alt) => src
    ? `<img class="map-thumb" src="${esc(src)}" alt="${esc(alt || '')}" loading="lazy">`
    : '<span class="map-thumb map-thumb-empty">📦</span>';
  const selo = linha.origem === 'manual'
    ? '<span class="map-badge map-badge-manual">✓ Escolhido por você</span>'
    : linha.origem === 'sku'
      ? '<span class="map-badge map-badge-sku">Sugerido pelo SKU</span>'
      : '<span class="map-badge map-badge-off">Sem destino</span>';
  return `<div class="map-card ${a ? 'is-set' : ''}" data-vid="${esc(String(v.id))}">
    <div class="map-card-head">${selo}<span class="map-price">${fmtMoney(v.price || 0)}</span></div>
    <div class="map-pair">
      <div class="map-side">
        <div class="map-side-label">🏬 Vitrine</div>
        ${img(v.image, v.title)}
        <div class="map-name" title="${esc(v.title)}">${esc(v.title)}</div>
      </div>
      <div class="map-arrow" aria-hidden="true">→</div>
      <div class="map-side">
        <div class="map-side-label">🛒 Checkout</div>
        ${a ? img(a.image, a.title) : '<span class="map-thumb map-thumb-empty">—</span>'}
        <div class="map-name map-name-target" title="${a ? esc(a.title) : ''}">${a ? esc(a.title) : '<span class="map-none">nenhum</span>'}</div>
      </div>
    </div>
    <select class="map-select" data-vid="${esc(String(v.id))}">
      <option value="">— não redirecionar —</option>
      ${opcoes.map((o) => `<option value="${esc(String(o.id))}" ${a && String(a.id) === String(o.id) ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}
    </select>
  </div>`;
}

async function loadStoreMapping(storeId) {
  const panel = document.querySelector('#lojasDetail .dpanel[data-dpanel="mapeamento"]');
  if (!panel) return;
  panel.innerHTML = mapAviso('🔗', 'Carregando…', 'Buscando os produtos das duas lojas na Shopify.');
  try {
    const d = await api(`/api/productmap?store=${storeId}`);

    if (d.status === 'sem_vitrine') return (panel.innerHTML = mapAviso('🏬', 'Defina a loja vitrine', 'Vá no Flow e escolha qual loja é a vitrine (a que recebe o tráfego).'));
    if (d.status === 'e_a_vitrine') {
      return (panel.innerHTML = mapAviso('🏬', 'Esta é a loja vitrine', 'O mapeamento é configurado nas <strong>lojas de checkout</strong> — é lá que você escolhe para onde cada produto da vitrine leva. Conecte uma segunda loja e abra o Mapeamento dela.'));
    }
    if (d.status === 'fora_do_pool') {
      return (panel.innerHTML = mapAviso('🔀', 'Loja fora do pool de checkout', 'Adicione esta loja ao pool no Flow para poder mapear os produtos.', '<button class="control btn-primary" style="margin-top:14px" onclick="document.querySelector(\'.tab-btn[data-tab=&quot;flow&quot;]\').click()">Ir para o Flow</button>'));
    }

    const pct = d.total ? Math.round((d.configurados / d.total) * 100) : 0;
    panel.innerHTML = `<div class="card">
      <div class="card-head">
        <h2>🔗 Mapeamento de produtos</h2>
        <span class="map-counter ${d.configurados === d.total ? 'ok' : ''}">${fmtInt(d.configurados)}/${fmtInt(d.total)} configurados</span>
      </div>
      <p class="hint">Quem clicar num produto da <strong>${esc(d.vitrine.name)}</strong> (vitrine) vai para o produto que você escolher da <strong>${esc(d.target.name)}</strong> (checkout). Os pares valem mesmo sem SKU.</p>
      <div class="map-progress"><div class="map-progress-fill" style="width:${pct}%"></div></div>
      <div class="map-grid">${d.linhas.map((l) => mapCardHtml(l, d.opcoes)).join('')}</div>
    </div>`;

    panel.querySelectorAll('.map-select').forEach((sel) => sel.addEventListener('change', async () => {
      const card = sel.closest('.map-card');
      card.classList.add('is-saving');
      try {
        const res = await fetch('/api/productmap', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId, vitrineProductId: sel.dataset.vid, storeProductId: sel.value || null }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar.');
        showLojaToast(sel.value ? '✓ Par salvo' : '✓ Par removido', sel.value ? 'Esse produto da vitrine passa a levar para o que você escolheu.' : 'Esse produto deixa de redirecionar.');
        loadStoreMapping(storeId); // recarrega para atualizar foto, selo e contador
      } catch (e) {
        card.classList.remove('is-saving');
        showLojaToast('✗ Erro', e.message);
      }
    }));
  } catch (e) {
    panel.innerHTML = mapAviso('⚠️', 'Não deu para carregar', esc(e.message));
  }
}

function setDetailTab(tab) {
  lojas.detailTab = tab;
  document.querySelectorAll('#detailTabs .dtab').forEach((b) => b.classList.toggle('active', b.dataset.dtab === tab));
  document.querySelectorAll('#lojasDetail .dpanel').forEach((p) => { p.hidden = p.dataset.dpanel !== tab; });
  if (tab === 'produtos' && lojas.detailId) loadStoreProducts(lojas.detailId);
  if (tab === 'mapeamento' && lojas.detailId) loadStoreMapping(lojas.detailId);
  const ph = DPANEL_PLACEHOLDER[tab];
  if (ph) {
    const panel = document.querySelector(`#lojasDetail .dpanel[data-dpanel="${tab}"]`);
    if (panel && !panel.dataset.filled) {
      panel.innerHTML = `<div class="placeholder-empty"><span class="pe-ico">${ph[0]}</span><div class="pe-title">${ph[1]}</div><div>${ph[2]}</div></div>`;
      panel.dataset.filled = '1';
    }
  }
}

document.querySelectorAll('#detailTabs .dtab').forEach((b) => b.addEventListener('click', () => setDetailTab(b.dataset.dtab)));

$('detailBack').addEventListener('click', () => { lojas.detailId = null; lojasShow('list'); loadLojas(); });
$('detailCamuflar').addEventListener('click', () => showLojaToast('🥷 Camuflagem', 'Recurso de camuflagem em breve nesta build.'));
$('detailSync').addEventListener('click', async () => {
  showLojaToast('↻ Sincronizando', 'Buscando dados atualizados da loja…');
  await loadLojasDetail(lojas.detailId);
});
$('detailDisconnect').addEventListener('click', async () => {
  if (!lojas.detailId) return;
  if (!confirm('Desconectar esta loja do painel? O token será removido.')) return;
  await fetch(`/api/stores/${lojas.detailId}`, { method: 'DELETE' });
  lojas.detailId = null;
  await refreshAll();
  lojasShow('list');
  loadLojas();
});
