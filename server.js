/*
 * Dashboard multi-loja Shopify.
 * Lê pedidos via Admin API de cada loja cadastrada e agrega métricas.
 * Sem lojas cadastradas, o painel fica vazio até você conectar uma loja.
 *
 * Local: `npm start` (escuta em 127.0.0.1, dados em data/).
 * Vercel: o app é exportado; dados no Supabase; exige PANEL_PASSWORD.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3030;
const API_VERSION = '2025-01';
const MAX_PAGES_PER_STORE = 10; // 250 pedidos/página → até 2.500 pedidos por loja/consulta
const FETCH_TIMEOUT_MS = 15000; // corta chamadas à Shopify que travam (evita pendurar/derrubar)

// Uma loja lenta/offline não pode derrubar o servidor inteiro: registra e segue.
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.message ? err.message : err);
});

const app = express();
app.use(express.json());

/* ---------- autenticação ----------
 * O painel dá acesso às suas lojas e tokens, então numa URL pública ele PRECISA de senha.
 * - PANEL_PASSWORD definida  → exige login (cookie de sessão assinado).
 * - Sem PANEL_PASSWORD, local → segue livre (só escuta em 127.0.0.1).
 * - Sem PANEL_PASSWORD, hospedado → recusa servir, para não expor as lojas por acidente.
 */
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const IS_HOSTED = !!(process.env.VERCEL || process.env.HOSTED);
const SESSION_SECRET = process.env.SESSION_SECRET || PANEL_PASSWORD;
const SESSION_HOURS = 12;
const COOKIE = 'panel_session';

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET || 'dev').update(value).digest('base64url');
}

function makeToken() {
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  return `${Buffer.from(exp).toString('base64url')}.${sign(exp)}`;
}

function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [encExp, sig] = token.split('.');
  let exp;
  try {
    exp = Buffer.from(encExp, 'base64url').toString();
  } catch {
    return false;
  }
  if (!/^\d+$/.test(exp)) return false;
  const expected = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
  return Number(exp) > Date.now();
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

const LOGIN_PATHS = new Set(['/login', '/api/login']);

app.use((req, res, next) => {
  if (IS_HOSTED && !PANEL_PASSWORD) {
    return res.status(503).json({
      error: 'PANEL_PASSWORD não configurada. O painel está bloqueado para não expor suas lojas e tokens — defina essa variável de ambiente e faça o redeploy.',
    });
  }
  if (!PANEL_PASSWORD) return next(); // local sem senha
  /*
   * Rotas públicas (não passam pelo login) e por quê:
   * - /api/oauth/callback: vem da Shopify; provado por state assinado + HMAC.
   * - /api/cron/*: protegido por CRON_SECRET.
   * - /redirect.js e /api/resolve: rodam no NAVEGADOR DO CLIENTE da loja, que
   *   obviamente não tem login. Só expõem o mapa de produtos (dado público:
   *   quem vê a vitrine já vê os produtos), nunca token, pedido ou faturamento.
   */
  if (LOGIN_PATHS.has(req.path) || req.path.startsWith('/api/cron/') ||
      req.path === '/api/oauth/callback' || req.path === '/redirect.js' || req.path === '/api/resolve') return next();
  // arquivos estáticos (css/js/fontes/imagens) são públicos: a própria tela de login
  // precisa deles e não contêm segredo — as APIs continuam exigindo o cookie.
  if (/\.(css|js|mjs|woff2?|ttf|otf|png|jpe?g|svg|gif|ico|webp|map)$/i.test(req.path)) return next();
  if (validToken(readCookie(req, COOKIE))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado.' });
  return res.redirect('/login');
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/api/login', (req, res) => {
  const pass = String((req.body || {}).password || '');
  // compara em tempo constante (hash dos dois lados p/ ter tamanho fixo)
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(PANEL_PASSWORD).digest();
  if (!PANEL_PASSWORD || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax${IS_HOSTED ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${IS_HOSTED ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- persistência das lojas ---------- */

async function loadStores() {
  return db.readStores();
}

async function saveStores(stores) {
  return db.writeStores(stores);
}

function publicStore(s) {
  return {
    id: s.id,
    name: s.name,
    domain: s.domain,
    currency: s.currency || 'BRL',
    platform: s.platform || 'shopify',
    connectedAt: s.connectedAt || null,
  };
}

/* ---------- Shopify Admin API ---------- */

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

async function shopifyRequest(store, endpoint, { method = 'GET', body = null } = {}) {
  const url = endpoint.startsWith('https://')
    ? endpoint
    : `https://${store.domain}/admin/api/${API_VERSION}/${endpoint}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Shopify-Access-Token': store.token,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // timeout/rede: vira erro tratável (não derruba o processo)
    const err = new Error(`Sem resposta de ${store.domain} (rede/timeout).`);
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j.errors) msg = typeof j.errors === 'string' ? j.errors : JSON.stringify(j.errors);
    } catch { /* mantém o texto cru */ }
    const err = new Error(`Shopify ${res.status} em ${store.domain}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  const link = res.headers.get('link') || '';
  const next = /<([^>]+)>;\s*rel="next"/.exec(link);
  return { data: await res.json(), nextUrl: next ? next[1] : null };
}

function shopifyFetch(store, endpoint) {
  return shopifyRequest(store, endpoint);
}

async function fetchOrders(store, createdAtMin, createdAtMax) {
  const params = new URLSearchParams({
    status: 'any',
    limit: '250',
    created_at_min: createdAtMin.toISOString(),
    created_at_max: createdAtMax.toISOString(),
    fields: 'id,name,created_at,total_price,currency,cancelled_at,test,financial_status,line_items,shipping_address',
  });
  let endpoint = `orders.json?${params}`;
  const orders = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
    const { data, nextUrl } = await shopifyFetch(store, endpoint);
    for (const o of data.orders || []) {
      if (o.test || o.cancelled_at || o.financial_status === 'voided') continue;
      orders.push({
        storeId: store.id,
        storeName: store.name,
        number: o.name,
        createdAt: new Date(o.created_at),
        total: parseFloat(o.total_price) || 0,
        currency: o.currency,
        status: o.financial_status || 'paid',
        city: o.shipping_address ? o.shipping_address.city : null,
        country: o.shipping_address ? o.shipping_address.country : null,
        countryCode: o.shipping_address ? o.shipping_address.country_code : null,
        lat: o.shipping_address && o.shipping_address.latitude != null ? o.shipping_address.latitude : null,
        lng: o.shipping_address && o.shipping_address.longitude != null ? o.shipping_address.longitude : null,
        items: (o.line_items || []).map((li) => ({
          title: li.title,
          qty: li.quantity,
          price: parseFloat(li.price) || 0,
        })),
      });
    }
    if (!nextUrl) return { orders, truncated };
    endpoint = nextUrl;
    truncated = page === MAX_PAGES_PER_STORE - 1;
  }
  return { orders, truncated };
}

/* ---------- agregação de métricas ---------- */

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function rangeBounds(range) {
  const now = new Date();
  let start, end;
  switch (range) {
    case 'yesterday':
      end = startOfDay(now);
      start = new Date(end.getTime() - 86400000);
      break;
    case '7d':
      end = now;
      start = new Date(startOfDay(now).getTime() - 6 * 86400000);
      break;
    case '30d':
      end = now;
      start = new Date(startOfDay(now).getTime() - 29 * 86400000);
      break;
    case 'today':
    default:
      start = startOfDay(now);
      end = now;
  }
  const length = end.getTime() - start.getTime();
  return {
    start,
    end,
    prevStart: new Date(start.getTime() - length),
    prevEnd: start,
    unit: range === '7d' || range === '30d' ? 'day' : 'hour',
  };
}

function sumMetrics(orders) {
  const sales = orders.reduce((s, o) => s + o.total, 0);
  const count = orders.length;
  const itemsSold = orders.reduce((s, o) => s + o.items.reduce((a, it) => a + it.qty, 0), 0);
  return { sales, orders: count, aov: count ? sales / count : 0, itemsSold };
}

function bucketSeries(orders, start, end, unit) {
  const step = unit === 'hour' ? 3600000 : 86400000;
  const n = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / step));
  const buckets = new Array(n).fill(0);
  for (const o of orders) {
    const i = Math.floor((o.createdAt.getTime() - start.getTime()) / step);
    if (i >= 0 && i < n) buckets[i] += o.total;
  }
  return buckets;
}

function buildMetrics(allOrders, bounds, stores) {
  const current = allOrders.filter((o) => o.createdAt >= bounds.start && o.createdAt < bounds.end);
  const previous = allOrders.filter((o) => o.createdAt >= bounds.prevStart && o.createdAt < bounds.prevEnd);

  const labels = [];
  const step = bounds.unit === 'hour' ? 3600000 : 86400000;
  const n = Math.max(1, Math.ceil((bounds.end.getTime() - bounds.start.getTime()) / step));
  for (let i = 0; i < n; i++) {
    const t = new Date(bounds.start.getTime() + i * step);
    labels.push(
      bounds.unit === 'hour'
        ? `${String(t.getHours()).padStart(2, '0')}h`
        : t.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    );
  }

  const byStore = stores.map((s) => {
    const so = current.filter((o) => o.storeId === s.id);
    const m = sumMetrics(so);
    // último pedido considerando também o período anterior (janela completa buscada)
    let lastOrderAt = null;
    for (const o of allOrders) {
      if (o.storeId === s.id && (!lastOrderAt || o.createdAt > lastOrderAt)) lastOrderAt = o.createdAt;
    }
    return { id: s.id, name: s.name, ...m, error: s.error || null, lastOrderAt: lastOrderAt ? lastOrderAt.toISOString() : null };
  });

  const countryMap = new Map();
  for (const o of current) {
    if (!o.country) continue;
    const e = countryMap.get(o.country) || { country: o.country, code: o.countryCode, orders: 0, sales: 0 };
    e.orders += 1;
    e.sales += o.total;
    countryMap.set(o.country, e);
  }
  const topCountries = [...countryMap.values()].sort((a, b) => b.sales - a.sales).slice(0, 6);

  const geoPoints = current
    .filter((o) => o.lat != null && o.lng != null)
    .slice(-400)
    .map((o) => ({ lat: o.lat, lng: o.lng, t: o.createdAt.getTime() }));

  const prodMap = new Map();
  for (const o of current) {
    for (const it of o.items) {
      const e = prodMap.get(it.title) || { title: it.title, qty: 0, sales: 0 };
      e.qty += it.qty;
      e.sales += it.price * it.qty;
      prodMap.set(it.title, e);
    }
  }
  const topProducts = [...prodMap.values()].sort((a, b) => b.sales - a.sales).slice(0, 8);

  return {
    totals: sumMetrics(current),
    previous: sumMetrics(previous),
    series: {
      unit: bounds.unit,
      labels,
      current: bucketSeries(current, bounds.start, bounds.end, bounds.unit),
      previous: bucketSeries(previous, bounds.prevStart, bounds.prevEnd, bounds.unit).slice(0, n),
      byStore: stores.slice(0, 8).map((s) => ({
        id: s.id,
        name: s.name,
        values: bucketSeries(current.filter((o) => o.storeId === s.id), bounds.start, bounds.end, bounds.unit),
      })),
    },
    byStore,
    topProducts,
    topCountries,
    geoPoints,
    recentOrders: [...current]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map((o) => ({
        number: o.number,
        storeId: o.storeId,
        store: o.storeName,
        total: o.total,
        status: o.status || 'paid',
        city: o.city,
        createdAt: o.createdAt.toISOString(),
      })),
  };
}

/* ---------- cache curto (evita estourar rate limit da Shopify) ---------- */

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { t: Date.now(), p });
  return p;
}

async function fetchProductCount(store) {
  const { data } = await shopifyFetch(store, 'products/count.json');
  return data.count;
}

async function collectOrders(stores, from, to) {
  const results = await Promise.all(
    stores.map(async (s) => {
      try {
        const { orders, truncated } = await fetchOrders(s, from, to);
        return { store: s, orders, truncated, error: null };
      } catch (e) {
        // explica a causa (403 = escopo faltando, 401 = token, etc.) em vez do erro cru
        return { store: s, orders: [], truncated: false, error: explainShopifyError(e, s.domain) };
      }
    })
  );
  return results;
}

/* ---------- rotas: lojas ---------- */

app.get('/api/stores', async (req, res) => {
  res.json({ stores: (await loadStores()).map(publicStore) });
});

/*
 * Diagnóstico do que foi colado no campo de token.
 * A Shopify devolve sempre o mesmo 401 genérico, então é melhor explicar
 * a causa provável antes (o erro mais comum é colar a API key ou o secret).
 */
function diagnoseToken(token) {
  const t = String(token || '').trim();
  if (!t) return 'Cole o Admin API access token.';
  if (/\s/.test(t)) return 'O token tem espaço ou quebra de linha — copie de novo, sem sobras.';
  if (t.startsWith('shpss_')) {
    return 'Isso é o API secret key (começa com shpss_), não o token. O que o painel precisa é o Admin API access token, que começa com shpat_ e aparece em Credenciais da API depois de Instalar app.';
  }
  if (t.startsWith('shpca_')) {
    return 'Isso é um código de autorização (shpca_), não o Admin API access token (shpat_).';
  }
  if (/^[0-9a-f]{32}$/i.test(t)) {
    return 'Isso parece a API key do app (32 caracteres hexadecimais) — é o que vai no OAuth, não aqui. O painel precisa do Admin API access token, que começa com shpat_ e só aparece depois de clicar em Instalar app.';
  }
  if (!t.startsWith('shpat_')) {
    return 'Isso não parece um Admin API access token: ele começa com shpat_. Vá em Configuração → Credenciais da API → Instalar app e copie o token de acesso do Admin API.';
  }
  return null; // formato plausível: deixa a Shopify decidir
}

// mensagem melhor para os erros mais comuns da Shopify
function explainShopifyError(e, domain) {
  const msg = String(e.message || '');
  if (e.status === 401) {
    return `A Shopify recusou o token para ${domain}. Causas comuns: (1) o app não foi instalado — clique em Instalar app e gere o token; (2) o token é de outra loja; (3) o token foi revogado ou regerado (o antigo para de valer); (4) foi colada a API key/secret no lugar do token.`;
  }
  if (e.status === 403) {
    // a Shopify diz qual escopo faltou: "requires merchant approval for read_orders scope"
    const escopo = /approval for (\w+) scope/i.exec(msg);
    const qual = escopo ? `o escopo ${escopo[1]}` : 'os escopos necessários (read_orders e read_products)';
    return `O token de ${domain} é válido, mas a loja não aprovou ${qual}. Isso não se resolve trocando o token: no app da loja, marque ${escopo ? escopo[1] : 'read_orders e read_products'} em Configuração → Escopos do Admin API, salve, clique em Instalar app de novo (ou Atualizar) e então gere um token novo.`;
  }
  if (e.status === 404) {
    return `Loja não encontrada: ${domain}. Confira o endereço .myshopify.com (não é o domínio personalizado nem o seu e-mail).`;
  }
  return msg;
}

app.post('/api/stores/test', async (req, res) => {
  const domain = normalizeDomain(req.body.domain);
  const token = String(req.body.token || '').trim();
  if (!domain || !token) return res.status(400).json({ ok: false, error: 'Informe domínio e token.' });
  const problema = diagnoseToken(token);
  if (problema) return res.json({ ok: false, error: problema });
  try {
    const { data } = await shopifyFetch({ domain, token }, 'shop.json');
    res.json({ ok: true, shop: { name: data.shop.name, currency: data.shop.currency, domain: data.shop.myshopify_domain } });
  } catch (e) {
    res.json({ ok: false, error: explainShopifyError(e, domain) });
  }
});

app.post('/api/stores', async (req, res) => {
  const domain = normalizeDomain(req.body.domain);
  const token = String(req.body.token || '').trim();
  const name = String(req.body.name || '').trim() || domain;
  if (!domain || !token) return res.status(400).json({ error: 'Informe domínio e token.' });
  const problema = diagnoseToken(token);
  if (problema) return res.status(400).json({ error: problema });
  const stores = await loadStores();
  const existente = stores.find((s) => s.domain === domain);
  const reconnect = !!req.body.reconnect;
  if (existente && !reconnect) {
    return res.status(409).json({ error: 'Essa loja já está conectada. Para trocar o token dela (ex.: novo Custom App), reconecte por cima.', canReconnect: true, storeId: existente.id });
  }
  let currency = 'BRL';
  try {
    const { data } = await shopifyFetch({ domain, token }, 'shop.json');
    currency = data.shop.currency;
  } catch (e) {
    return res.status(400).json({ error: explainShopifyError(e, domain) });
  }

  // reconexão: troca o token da loja existente, preservando id, pool, mapeamentos e token Storefront
  if (existente) {
    existente.token = token;
    existente.currency = currency;
    existente.auth = 'custom';
    if (req.body.name) existente.name = name;
    existente.reconnectedAt = new Date().toISOString();
    await saveStores(stores);
    cache.clear();
    return res.json({ ok: true, store: publicStore(existente), reconnected: true });
  }

  const store = {
    id: crypto.randomUUID(),
    name,
    domain,
    token,
    currency,
    platform: 'shopify',
    connectedAt: new Date().toISOString(),
    auth: 'custom',
  };
  stores.push(store);
  await saveStores(stores);
  cache.clear();

  /*
   * Loja nova entra no pool de checkout automaticamente (menos a primeira, que
   * vira a vitrine). Sem isso ela ficava só em "disponíveis", o Flow continuava
   * vazio e não dava para mapear produto nenhum — parecia que faltava o recurso.
   */
  try {
    const { f } = await ensureFlowConfig();
    if (f.vitrineId && store.id !== f.vitrineId && !f.pool.some((p) => p.id === store.id)) {
      f.pool.push({ id: store.id, limit: DEFAULT_LIMIT, dailyLimit: 0, paused: false, resetAt: null });
      if (!f.state.activeId) f.state = { activeId: store.id, activatedAt: new Date().toISOString() };
      await saveFlowConfig(f);
    }
  } catch { /* o painel funciona mesmo se o flow ainda não estiver configurado */ }

  res.json({ store: publicStore(store) });
});

app.delete('/api/stores/:id', async (req, res) => {
  const stores = (await loadStores()).filter((s) => s.id !== req.params.id);
  await saveStores(stores);
  cache.clear();
  res.json({ ok: true });
});

// visão geral das lojas para a aba "Lojas": produtos, pedidos e receita (30d) por loja
async function buildStoresOverview() {
  const all = await loadStores();
  const bounds = rangeBounds('30d');
  if (all.length === 0) return [];

  const results = await collectOrders(all, bounds.start, bounds.end);
  return Promise.all(
    results.map(async (r) => {
      let products = null;
      if (!r.error) {
        try {
          products = await fetchProductCount(r.store);
        } catch {
          /* contagem de produtos é best-effort */
        }
      }
      const m = sumMetrics(r.orders);
      return {
        ...publicStore(r.store),
        products,
        orders30d: m.orders,
        revenue30d: m.sales,
        aov30d: m.aov,
        status: r.error ? 'error' : 'active',
        cloakerHits: 0,
        error: r.error,
      };
    })
  );
}

// catálogo real da loja (aba Produtos)
async function fetchProducts(store) {
  let endpoint = 'products.json?limit=250&fields=id,title,handle,status,product_type,vendor,image,variants';
  const out = [];
  for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
    const { data, nextUrl } = await shopifyFetch(store, endpoint);
    for (const p of data.products || []) {
      const variants = p.variants || [];
      const prices = variants.map((v) => parseFloat(v.price) || 0);
      out.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        status: p.status, // active | draft | archived
        type: p.product_type || '',
        vendor: p.vendor || '',
        image: p.image ? p.image.src : null,
        variants: variants.length,
        // primeira variante disponível → é ela que vira "merchandise" no carrinho do checkout direto
        variantId: (variants.find((v) => (v.inventory_quantity ?? 1) > 0 || !v.inventory_management) || variants[0] || {}).id || null,
        sku: variants[0] ? variants[0].sku || '' : '',
        priceMin: prices.length ? Math.min(...prices) : 0,
        priceMax: prices.length ? Math.max(...prices) : 0,
        // inventory_quantity vem null quando a loja não rastreia estoque
        inventory: variants.reduce((s, v) => s + (v.inventory_quantity ?? 0), 0),
        tracked: variants.some((v) => v.inventory_management),
      });
    }
    if (!nextUrl) break;
    endpoint = nextUrl;
  }
  return out;
}

app.get('/api/stores/:id/products', async (req, res) => {
  try {
    const store = (await loadStores()).find((s) => s.id === req.params.id);
    if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
    const products = await cached(`products:${store.id}`, 60000, () => fetchProducts(store));
    res.json({ store: publicStore(store), count: products.length, products });
  } catch (e) {
    res.status(500).json({ error: explainShopifyError(e, req.params.id) });
  }
});

app.get('/api/stores/overview', async (req, res) => {
  try {
    const stores = await cached('stores-overview', 60000, buildStoresOverview);
    res.json({ stores });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- rotas: flow de contingência (vitrine → checkout) ---------- */

const DEFAULT_LIMIT = 10;

async function loadFlowConfig() {
  return db.readDoc('flow', null);
}

async function saveFlowConfig(f) {
  return db.writeDoc('flow', f);
}

/*
 * flow.json:
 * {
 *   vitrineId, paused,
 *   pool: [ { id, limit, dailyLimit, paused, resetAt } ],   // ordem = ordem de rotação
 *   state: { activeId, activatedAt }
 * }
 */
async function ensureFlowConfig() {
  const all = await loadStores();
  const stores = all;
  const f = (await loadFlowConfig()) || {};
  let dirty = false;

  if (typeof f.paused !== 'boolean') { f.paused = false; dirty = true; }
  if (!f.vitrineId || !stores.some((s) => s.id === f.vitrineId)) {
    f.vitrineId = stores[0] ? stores[0].id : null;
    dirty = true;
  }

  // migra formato antigo (limits{}) → pool[]
  if (!Array.isArray(f.pool)) {
    const legacy = f.limits || {};
    f.pool = stores
      .filter((s) => s.id !== f.vitrineId)
      .map((s) => ({ id: s.id, limit: legacy[s.id] || DEFAULT_LIMIT, dailyLimit: 0, paused: false, resetAt: null }));
    delete f.limits;
    dirty = true;
  }

  // tira do pool a vitrine e lojas que não existem mais
  const before = f.pool.length;
  f.pool = f.pool.filter((p) => p.id !== f.vitrineId && stores.some((s) => s.id === p.id));
  if (f.pool.length !== before) dirty = true;

  for (const p of f.pool) {
    if (!(p.limit >= 1)) { p.limit = DEFAULT_LIMIT; dirty = true; }
    if (!(p.dailyLimit >= 0)) { p.dailyLimit = 0; dirty = true; }
    if (typeof p.paused !== 'boolean') { p.paused = false; dirty = true; }
    if (p.resetAt === undefined) { p.resetAt = null; dirty = true; }
  }

  if (!f.state || typeof f.state !== 'object' || !f.state.activatedAt) {
    f.state = { activeId: null, activatedAt: new Date().toISOString() };
    dirty = true;
  }
  if (!f.pool.some((p) => p.id === f.state.activeId)) {
    f.state = { activeId: f.pool[0] ? f.pool[0].id : null, activatedAt: new Date().toISOString() };
    dirty = true;
  }

  const pool = f.pool.map((p) => ({ ...stores.find((s) => s.id === p.id), cfg: p }));
  return { f, stores, pool, dirty };
}

function startOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

// pedidos reais das lojas do pool desde `from` (Admin API)
async function collectPoolOrders(pool, from) {
  if (!pool.length) return [];
  const key = `flowOrders:${from.toISOString()}:${pool.map((s) => s.id).join(',')}`;
  const results = await cached(key, 25000, () => collectOrders(pool, from, new Date()));
  return results.flatMap((r) => r.orders.map((o) => ({ storeId: r.store.id, createdAt: o.createdAt, total: o.total })));
}

app.get('/api/flow', async (req, res) => {
  try {
    const ctx = await ensureFlowConfig();
    const { f, stores, pool } = ctx;
    let changed = ctx.dirty;

    const today = startOfToday();
    const times = [today.getTime(), new Date(f.state.activatedAt).getTime()];
    for (const p of f.pool) if (p.resetAt) times.push(new Date(p.resetAt).getTime());
    const orders = await collectPoolOrders(pool, new Date(Math.min(...times)));

    const salesSince = (p, actMs) => {
      const base = Math.max(actMs, p.resetAt ? new Date(p.resetAt).getTime() : 0);
      let sales = 0, revenue = 0;
      for (const o of orders) {
        if (o.storeId === p.id && o.createdAt.getTime() >= base) { sales++; revenue += o.total; }
      }
      return { sales, revenue };
    };
    const todayCountOf = (p) => orders.filter((o) => o.storeId === p.id && o.createdAt >= today).length;
    const dayBlocked = (p) => p.dailyLimit > 0 && todayCountOf(p) >= p.dailyLimit;
    const usable = (p) => !p.paused && !dayBlocked(p);

    // rotação automática: pula quando a ativa bate o limite, está pausada ou estourou o limite diário
    if (!f.paused && f.pool.length) {
      let guard = 0;
      while (guard++ <= f.pool.length + 1) {
        const cur = f.pool.find((p) => p.id === f.state.activeId);
        const actMs = new Date(f.state.activatedAt).getTime();
        const curOk = cur && usable(cur) && salesSince(cur, actMs).sales < cur.limit;
        if (curOk) break;
        const idx = f.pool.findIndex((p) => p.id === f.state.activeId);
        let found = null;
        for (let i = 1; i <= f.pool.length; i++) {
          const cand = f.pool[(idx + i) % f.pool.length];
          if (usable(cand)) { found = cand; break; }
        }
        if (!found || found.id === f.state.activeId) break; // nenhuma outra elegível
        f.state = { activeId: found.id, activatedAt: new Date().toISOString() };
        changed = true;
      }
    }
    if (changed) await saveFlowConfig(f);

    const actMs = new Date(f.state.activatedAt).getTime();
    const activeIdx = f.pool.findIndex((p) => p.id === f.state.activeId);
    let nextId = null;
    for (let i = 1; i <= f.pool.length; i++) {
      const cand = f.pool[(activeIdx + i) % f.pool.length];
      if (cand && cand.id !== f.state.activeId && usable(cand)) { nextId = cand.id; break; }
    }
    const vitrine = stores.find((s) => s.id === f.vitrineId);

    res.json({
      paused: f.paused,
      vitrine: vitrine ? publicStore(vitrine) : null,
      activatedAt: f.state.activatedAt,
      stores: stores.map(publicStore),
      available: stores.filter((s) => s.id !== f.vitrineId && !f.pool.some((p) => p.id === s.id)).map(publicStore),
      checkout: f.pool.map((p, i) => {
        const st = stores.find((s) => s.id === p.id);
        const { sales, revenue } = salesSince(p, actMs);
        return {
          ...publicStore(st),
          position: i + 1,
          limit: p.limit,
          dailyLimit: p.dailyLimit,
          paused: p.paused,
          sales,
          revenue,
          todayCount: todayCountOf(p),
          blocked: dayBlocked(p),
          active: !f.paused && p.id === f.state.activeId,
          next: p.id === nextId,
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function poolEntry(f, id) {
  return f.pool.find((p) => p.id === id);
}

app.post('/api/flow/config', async (req, res) => {
  const { f, stores } = await ensureFlowConfig();
  const { vitrineId, limits } = req.body || {};
  if (vitrineId && stores.some((s) => s.id === vitrineId) && vitrineId !== f.vitrineId) {
    f.vitrineId = vitrineId;
    // a nova vitrine sai do pool; as demais entram se ainda não estiverem
    f.pool = f.pool.filter((p) => p.id !== vitrineId);
    for (const s of stores) {
      if (s.id !== vitrineId && !f.pool.some((p) => p.id === s.id)) {
        f.pool.push({ id: s.id, limit: DEFAULT_LIMIT, dailyLimit: 0, paused: false, resetAt: null });
      }
    }
    f.state = { activeId: f.pool[0] ? f.pool[0].id : null, activatedAt: new Date().toISOString() };
  }
  if (limits && typeof limits === 'object') {
    for (const [id, n] of Object.entries(limits)) {
      const v = parseInt(n, 10);
      const p = poolEntry(f, id);
      if (p && v >= 1 && v <= 100000) p.limit = v;
    }
  }
  await saveFlowConfig(f);
  cache.clear();
  res.json({ ok: true });
});

app.post('/api/flow/skip', async (req, res) => {
  const { f } = await ensureFlowConfig();
  if (f.pool.length > 1) {
    const idx = f.pool.findIndex((p) => p.id === f.state.activeId);
    const next = f.pool[(idx + 1) % f.pool.length];
    f.state = { activeId: next.id, activatedAt: new Date().toISOString() };
    await saveFlowConfig(f);
  }
  res.json({ ok: true });
});

// força uma loja de checkout específica como ativa
app.post('/api/flow/activate', async (req, res) => {
  const { f } = await ensureFlowConfig();
  const id = req.body && req.body.id;
  const p = poolEntry(f, id);
  if (p) {
    p.paused = false; // ativar uma loja pausada a despausa
    f.state = { activeId: id, activatedAt: new Date().toISOString() };
    await saveFlowConfig(f);
  }
  res.json({ ok: true });
});

// pausa/retoma a operação inteira
app.post('/api/flow/status', async (req, res) => {
  const { f } = await ensureFlowConfig();
  f.paused = !!(req.body && req.body.paused);
  await saveFlowConfig(f);
  res.json({ ok: true, paused: f.paused });
});

// pausa/retoma uma loja do pool
app.post('/api/flow/pool/:id/pause', async (req, res) => {
  const { f } = await ensureFlowConfig();
  const p = poolEntry(f, req.params.id);
  if (!p) return res.status(404).json({ error: 'Loja não está no pool.' });
  p.paused = !!(req.body && req.body.paused);
  if (p.paused && f.state.activeId === p.id) {
    const idx = f.pool.findIndex((x) => x.id === p.id);
    const next = f.pool.find((x, i) => i !== idx && !x.paused);
    if (next) f.state = { activeId: next.id, activatedAt: new Date().toISOString() };
  }
  await saveFlowConfig(f);
  res.json({ ok: true, paused: p.paused });
});

// limite de rotação (vendas para pular)
app.post('/api/flow/pool/:id/limit', async (req, res) => {
  const { f } = await ensureFlowConfig();
  const p = poolEntry(f, req.params.id);
  const v = parseInt(req.body && req.body.limit, 10);
  if (!p) return res.status(404).json({ error: 'Loja não está no pool.' });
  if (!(v >= 1 && v <= 100000)) return res.status(400).json({ error: 'Limite inválido.' });
  p.limit = v;
  await saveFlowConfig(f);
  res.json({ ok: true });
});

// limite diário de vendas (0 = desligado)
app.post('/api/flow/pool/:id/daily-limit', async (req, res) => {
  const { f } = await ensureFlowConfig();
  const p = poolEntry(f, req.params.id);
  const v = parseInt(req.body && req.body.dailyLimit, 10);
  if (!p) return res.status(404).json({ error: 'Loja não está no pool.' });
  if (!(v >= 0 && v <= 100000)) return res.status(400).json({ error: 'Limite diário inválido.' });
  p.dailyLimit = v;
  await saveFlowConfig(f);
  res.json({ ok: true });
});

// zera os contadores da loja (nova janela de contagem a partir de agora)
app.post('/api/flow/pool/:id/reset', async (req, res) => {
  const { f } = await ensureFlowConfig();
  const p = poolEntry(f, req.params.id);
  if (!p) return res.status(404).json({ error: 'Loja não está no pool.' });
  p.resetAt = new Date().toISOString();
  await saveFlowConfig(f);
  res.json({ ok: true });
});

// adiciona loja ao pool
app.post('/api/flow/pool/add', async (req, res) => {
  const { f, stores } = await ensureFlowConfig();
  const id = req.body && req.body.id;
  if (!stores.some((s) => s.id === id)) return res.status(404).json({ error: 'Loja não encontrada.' });
  if (id === f.vitrineId) return res.status(400).json({ error: 'A vitrine não pode ser checkout.' });
  if (poolEntry(f, id)) return res.status(409).json({ error: 'Loja já está no pool.' });
  f.pool.push({ id, limit: DEFAULT_LIMIT, dailyLimit: 0, paused: false, resetAt: null });
  if (!f.state.activeId) f.state = { activeId: id, activatedAt: new Date().toISOString() };
  await saveFlowConfig(f);
  res.json({ ok: true });
});

// remove loja do pool (a loja continua cadastrada no painel)
app.delete('/api/flow/pool/:id', async (req, res) => {
  const { f } = await ensureFlowConfig();
  f.pool = f.pool.filter((p) => p.id !== req.params.id);
  if (f.state.activeId === req.params.id) {
    f.state = { activeId: f.pool[0] ? f.pool[0].id : null, activatedAt: new Date().toISOString() };
  }
  await saveFlowConfig(f);
  res.json({ ok: true });
});

// reordena o pool (ordem da rotação)
app.post('/api/flow/pool/order', async (req, res) => {
  const { f } = await ensureFlowConfig();
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Ordem inválida.' });
  const byId = new Map(f.pool.map((p) => [p.id, p]));
  const next = [];
  for (const id of ids) if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); }
  for (const p of byId.values()) next.push(p); // as que não vieram na lista ficam no fim
  f.pool = next;
  await saveFlowConfig(f);
  res.json({ ok: true });
});

// health check real: pinga shop.json de cada loja do pool
app.get('/api/flow/health', async (req, res) => {
  const { pool } = await ensureFlowConfig();
  const health = await Promise.all(
    pool.map(async (s) => {
      try {
        const { data } = await shopifyFetch(s, 'shop.json');
        return { id: s.id, ok: true, name: data.shop.name, currency: data.shop.currency };
      } catch (e) {
        return { id: s.id, ok: false, error: e.message };
      }
    })
  );
  res.json({ health });
});

/* ---------- AutoMatch por SKU (vitrine ↔ lojas do pool) ---------- */

const DEFAULT_AUTOMATCH = { skuSuffixLength: 4, strategy: 'suffix', enabled: true };

async function loadAutomatch() {
  const a = (await db.readDoc('automatch', null)) || {};
  a.config = { ...DEFAULT_AUTOMATCH, ...(a.config || {}) };
  a.lastSyncAt = a.lastSyncAt || null;
  a.stats = a.stats || null;
  a.mapping = a.mapping || {};
  a.overrides = a.overrides || {}; // { storeId: { vitrineVariantId: storeVariantId } }
  return a;
}

async function saveAutomatch(a) {
  return db.writeDoc('automatch', a);
}

// todas as variantes (com SKU) de uma loja
async function fetchAllVariants(store) {
  let endpoint = 'products.json?limit=250&fields=id,title,variants';
  const out = [];
  for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
    const { data, nextUrl } = await shopifyFetch(store, endpoint);
    for (const p of data.products || []) {
      for (const v of p.variants || []) {
        out.push({
          productId: p.id,
          productTitle: p.title,
          variantId: v.id,
          variantTitle: v.title,
          sku: String(v.sku || '').trim(),
          price: v.price,
        });
      }
    }
    if (!nextUrl) break;
    endpoint = nextUrl;
  }
  return out;
}

function normSku(s) {
  return String(s || '').trim().toUpperCase();
}

// chave de comparação conforme a estratégia
function skuKey(sku, cfg) {
  const s = normSku(sku);
  if (!s) return '';
  const n = Math.max(1, parseInt(cfg.skuSuffixLength, 10) || 4);
  if (cfg.strategy === 'exact') return s;
  if (cfg.strategy === 'prefix') return s.slice(0, n);
  return s.slice(-n); // suffix (padrão)
}

/*
 * Casa cada variante da vitrine com uma variante de cada loja do pool.
 * matchType: exact (SKU idêntico) | partial (bateu só pela regra) | consolidation (vários produtos da vitrine com o mesmo SKU)
 */
function buildMapping(vitrineVariants, storeVariants, cfg, overrides = {}) {
  const index = new Map();
  for (const v of storeVariants) {
    const k = skuKey(v.sku, cfg);
    if (k && !index.has(k)) index.set(k, v);
  }
  // índice por variantId para resolver os pares escolhidos à mão
  const byVariantId = new Map(storeVariants.map((v) => [String(v.variantId), v]));
  // grupos de SKU na vitrine (many-to-one)
  const groupCount = new Map();
  for (const v of vitrineVariants) {
    const k = normSku(v.sku);
    if (k) groupCount.set(k, (groupCount.get(k) || 0) + 1);
  }

  const rows = [];
  for (const v of vitrineVariants) {
    // 1) par escolhido à mão sempre ganha do SKU
    const ovr = overrides[String(v.variantId)];
    let hit = ovr ? byVariantId.get(String(ovr)) || null : null;
    let matchType = hit ? 'manual' : null;
    // 2) senão, cai na regra de SKU
    if (!hit) {
      const k = skuKey(v.sku, cfg);
      hit = k ? index.get(k) : null;
      if (hit) {
        if (groupCount.get(normSku(v.sku)) > 1) matchType = 'consolidation';
        else if (normSku(v.sku) === normSku(hit.sku)) matchType = 'exact';
        else matchType = 'partial';
      }
    }
    rows.push({
      vitrineVariantId: v.variantId,
      vitrineSku: v.sku,
      vitrineTitle: `${v.productTitle}${v.variantTitle && v.variantTitle !== 'Default Title' ? ' / ' + v.variantTitle : ''}`,
      storeVariantId: hit ? hit.variantId : null,
      storeSku: hit ? hit.sku : null,
      storeTitle: hit ? `${hit.productTitle}${hit.variantTitle && hit.variantTitle !== 'Default Title' ? ' / ' + hit.variantTitle : ''}` : null,
      matchType,
    });
  }
  return rows;
}

// roda o AutoMatch contra a Shopify e salva o resultado
async function runAutomatch() {
  const { f, stores, pool } = await ensureFlowConfig();
  const a = await loadAutomatch();
  const cfg = a.config;

  const vitrineStore = stores.find((s) => s.id === f.vitrineId);
  if (!vitrineStore) throw new Error('Defina a loja vitrine no Flow antes de rodar o AutoMatch.');
  if (!pool.length) throw new Error('Adicione ao menos uma loja de checkout ao pool.');

  const vitrineVariants = await fetchAllVariants(vitrineStore);
  const withSku = vitrineVariants.filter((v) => v.sku);

  const mapping = {};
  const perStore = [];
  let mapped = 0, unmapped = 0;
  const cov = { exact: 0, partial: 0, consolidation: 0, manual: 0, unmapped: 0 };

  for (const store of pool) {
    let rows = [];
    let error = null;
    try {
      const storeVariants = await fetchAllVariants(store);
      rows = buildMapping(withSku, storeVariants, cfg, a.overrides[store.id] || {});
    } catch (e) {
      error = e.message;
    }
    mapping[store.id] = rows;
    const m = rows.filter((r) => r.matchType).length;
    const u = rows.length - m;
    mapped += m;
    unmapped += u;
    for (const r of rows) {
      if (r.matchType) cov[r.matchType]++;
      else cov.unmapped++;
    }
    perStore.push({ id: store.id, name: store.name, variants: rows.length, matched: m, unmatched: u, error });
  }

  // grupos de SKU consolidados na vitrine
  const groups = new Map();
  for (const v of withSku) {
    const k = normSku(v.sku);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const consolidated = [...groups.entries()].filter(([, list]) => list.length > 1);

  const totalPairs = mapped + unmapped;
  const stats = {
    vitrine: { id: vitrineStore.id, name: vitrineStore.name, variants: vitrineVariants.length, withSku: withSku.length },
    stores: perStore,
    mapped,
    unmapped,
    groups: {
      count: groups.size,
      consolidated: consolidated.length,
      vitrineVariants: withSku.length,
      poolVariants: mapped,
    },
    coverage: {
      percent: totalPairs ? Math.round(((totalPairs - cov.unmapped) / totalPairs) * 100) : 0,
      exact: cov.exact,
      partial: cov.partial,
      consolidation: cov.consolidation,
      manual: cov.manual,
      unmapped: cov.unmapped,
    },
  };

  a.lastSyncAt = new Date().toISOString();
  a.stats = stats;
  a.mapping = mapping;
  await saveAutomatch(a);
  return a;
}

app.get('/api/automatch', async (req, res) => {
  const a = await loadAutomatch();
  res.json({ config: a.config, lastSyncAt: a.lastSyncAt, stats: a.stats });
});

app.put('/api/automatch/config', async (req, res) => {
  const a = await loadAutomatch();
  const { skuSuffixLength, strategy, enabled } = req.body || {};
  const n = parseInt(skuSuffixLength, 10);
  if (n >= 1 && n <= 50) a.config.skuSuffixLength = n;
  if (['suffix', 'prefix', 'exact'].includes(strategy)) a.config.strategy = strategy;
  if (typeof enabled === 'boolean') a.config.enabled = enabled;
  await saveAutomatch(a);
  res.json({ ok: true, config: a.config });
});

app.post('/api/automatch/sync', async (req, res) => {
  try {
    const a = await runAutomatch();
    res.json({ ok: true, lastSyncAt: a.lastSyncAt, stats: a.stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// recalcula as estatísticas a partir do mapeamento salvo (sem bater na Shopify)
function recomputeAutomatchStats(a) {
  if (!a.stats) return;
  let mapped = 0, unmapped = 0;
  const cov = { exact: 0, partial: 0, consolidation: 0, manual: 0, unmapped: 0 };
  for (const s of a.stats.stores) {
    const rows = a.mapping[s.id] || [];
    const m = rows.filter((r) => r.matchType).length;
    s.variants = rows.length;
    s.matched = m;
    s.unmatched = rows.length - m;
    mapped += m;
    unmapped += rows.length - m;
    for (const r of rows) {
      if (r.matchType) cov[r.matchType] = (cov[r.matchType] || 0) + 1;
      else cov.unmapped++;
    }
  }
  const total = mapped + unmapped;
  a.stats.mapped = mapped;
  a.stats.unmapped = unmapped;
  a.stats.groups.poolVariants = mapped;
  a.stats.coverage = {
    percent: total ? Math.round(((total - cov.unmapped) / total) * 100) : 0,
    exact: cov.exact, partial: cov.partial, consolidation: cov.consolidation, manual: cov.manual, unmapped: cov.unmapped,
  };
}

// variantes de uma loja (para escolher o produto à mão)
app.get('/api/automatch/variants', async (req, res) => {
  try {
    const all = await loadStores();
    const store = all.find((s) => s.id === req.query.store);
    if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
    const variants = await cachedVariants(store);
    res.json({
      store: publicStore(store),
      variants: variants.map((v) => ({
        variantId: v.variantId,
        sku: v.sku,
        title: `${v.productTitle}${v.variantTitle && v.variantTitle !== 'Default Title' ? ' / ' + v.variantTitle : ''}`,
        price: v.price,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/*
 * Define (ou limpa) o par escolhido à mão: produto da vitrine → produto da loja de checkout.
 * storeVariantId = null volta a valer a regra de SKU.
 */
app.post('/api/automatch/override', async (req, res) => {
  const { storeId, vitrineVariantId, storeVariantId } = req.body || {};
  if (!storeId || !vitrineVariantId) return res.status(400).json({ error: 'Informe a loja e o produto da vitrine.' });
  const a = await loadAutomatch();
  a.overrides[storeId] = a.overrides[storeId] || {};
  if (storeVariantId) a.overrides[storeId][String(vitrineVariantId)] = String(storeVariantId);
  else delete a.overrides[storeId][String(vitrineVariantId)];

  // atualiza a linha no mapeamento já salvo, sem precisar re-sincronizar tudo
  const rows = a.mapping[storeId];
  if (rows) {
    const row = rows.find((r) => String(r.vitrineVariantId) === String(vitrineVariantId));
    if (row) {
      if (storeVariantId) {
        try {
          const store = (await loadStores()).find((s) => s.id === storeId);
          const hit = (await cachedVariants(store)).find((v) => String(v.variantId) === String(storeVariantId));
          if (hit) {
            row.storeVariantId = hit.variantId;
            row.storeSku = hit.sku;
            row.storeTitle = `${hit.productTitle}${hit.variantTitle && hit.variantTitle !== 'Default Title' ? ' / ' + hit.variantTitle : ''}`;
            row.matchType = 'manual';
          }
        } catch { /* mantém a linha como está */ }
      } else {
        // sem override: marca para re-sincronizar (a regra de SKU volta a valer no próximo sync)
        row.storeVariantId = null;
        row.storeSku = null;
        row.storeTitle = null;
        row.matchType = null;
      }
      recomputeAutomatchStats(a);
    }
  }
  await saveAutomatch(a);
  res.json({ ok: true, stats: a.stats });
});

// mapeamento detalhado (para "Ver mapeamento" / "Ver grupos")
app.get('/api/automatch/mapping', async (req, res) => {
  const a = await loadAutomatch();
  const storeId = req.query.store;
  if (storeId) return res.json({ storeId, rows: a.mapping[storeId] || [], lastSyncAt: a.lastSyncAt });
  res.json({ mapping: a.mapping, lastSyncAt: a.lastSyncAt });
});

/* ---------- Pós-compra digital (polling + write_orders, sem webhook) ---------- */

const DEFAULT_PP = { enabled: false, sku: '', quantity: 1, orderTag: 'dr:auto-digital', startAt: null };
const PP_MAX_PER_CYCLE = 20; // trava de segurança

async function loadPP() {
  const p = (await db.readDoc('postpurchase', null)) || {};
  return { ...DEFAULT_PP, processed: {}, executions: [], ...p };
}

async function savePP(p) {
  return db.writeDoc('postpurchase', p);
}

// variantes da loja com cache curto (a lista muda pouco)
function cachedVariants(store) {
  return cached(`variants:${store.id}`, 300000, () => fetchAllVariants(store));
}

// pedidos pagos criados a partir de `since` (campos que o pós-compra precisa)
async function fetchPaidOrdersSince(store, since) {
  const params = new URLSearchParams({
    status: 'any',
    financial_status: 'paid',
    limit: '250',
    created_at_min: since.toISOString(),
    fields: 'id,name,created_at,financial_status,tags,email,test,cancelled_at',
  });
  let endpoint = `orders.json?${params}`;
  const out = [];
  for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
    const { data, nextUrl } = await shopifyFetch(store, endpoint);
    for (const o of data.orders || []) {
      if (o.test || o.cancelled_at) continue;
      out.push(o);
    }
    if (!nextUrl) break;
    endpoint = nextUrl;
  }
  return out;
}

// opções de produto digital: SKUs presentes nas lojas do pool
async function ppVariantOptions(pool) {
  const bySku = new Map();
  for (const store of pool) {
    let vs = [];
    try {
      vs = await cachedVariants(store);
    } catch {
      continue;
    }
    for (const v of vs) {
      if (!v.sku) continue;
      const k = normSku(v.sku);
      if (!bySku.has(k)) {
        bySku.set(k, {
          sku: v.sku,
          title: `${v.productTitle}${v.variantTitle && v.variantTitle !== 'Default Title' ? ' / ' + v.variantTitle : ''}`,
          price: v.price,
          stores: [],
        });
      }
      bySku.get(k).stores.push(store.id);
    }
  }
  return [...bySku.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function ppStats(p) {
  const created = p.executions.filter((e) => e.status === 'created').length;
  const failed = p.executions.filter((e) => e.status === 'failed').length;
  return { created, failed, total: p.executions.length };
}

// cria o pedido digital na mesma loja da compra
async function createDigitalOrder(store, variantId, pp, sourceOrder) {
  const body = {
    order: {
      line_items: [{ variant_id: variantId, quantity: Math.max(1, parseInt(pp.quantity, 10) || 1) }],
      financial_status: 'paid',
      tags: pp.orderTag,
      note: `Pós-compra digital automático — pedido de origem ${sourceOrder.name}`,
      send_receipt: false,
      send_fulfillment_receipt: false,
      inventory_behaviour: 'bypass',
    },
  };
  if (sourceOrder.email) body.order.email = sourceOrder.email;
  const { data } = await shopifyRequest(store, 'orders.json', { method: 'POST', body });
  return data.order;
}

// um ciclo do pós-compra: procura pedidos pagos novos e gera o pedido digital
async function runPostPurchaseCycle() {
  const pp = await loadPP();
  if (!pp.enabled || !pp.sku || !pp.startAt) return { skipped: true };

  let ctx;
  try {
    ctx = await ensureFlowConfig();
  } catch {
    return { skipped: true };
  }
  const pool = ctx.pool;
  if (!pool.length) return { skipped: true };

  const since = new Date(pp.startAt);
  const wanted = normSku(pp.sku);
  let created = 0;

  for (const store of pool) {
    let orders = [];
    try {
      orders = await fetchPaidOrdersSince(store, since);
    } catch {
      continue;
    }
    const done = new Set(pp.processed[store.id] || []);

    // resolve a variante do produto digital nessa loja (pelo SKU)
    let variant = null;
    try {
      variant = (await cachedVariants(store)).find((v) => normSku(v.sku) === wanted) || null;
    } catch {
      variant = null;
    }

    for (const o of orders) {
      if (created >= PP_MAX_PER_CYCLE) break;
      const oid = String(o.id);
      if (done.has(oid)) continue;
      // nunca reprocessa um pedido que nós mesmos criamos
      if (String(o.tags || '').toLowerCase().includes(String(pp.orderTag).toLowerCase())) {
        done.add(oid);
        continue;
      }
      if (new Date(o.created_at) < since) continue;

      if (!variant) {
        pp.executions.unshift({
          at: new Date().toISOString(), storeId: store.id, storeName: store.name,
          sourceOrderId: o.name, createdOrderId: null, status: 'failed',
          error: `A loja não tem o SKU "${pp.sku}" do produto digital.`,
        });
        done.add(oid); // não adianta tentar de novo até trocar a config
        continue;
      }
      try {
        const newOrder = await createDigitalOrder(store, variant.variantId, pp, o);
        created++;
        pp.executions.unshift({
          at: new Date().toISOString(), storeId: store.id, storeName: store.name,
          sourceOrderId: o.name, createdOrderId: newOrder.name || String(newOrder.id), status: 'created', error: null,
        });
      } catch (e) {
        pp.executions.unshift({
          at: new Date().toISOString(), storeId: store.id, storeName: store.name,
          sourceOrderId: o.name, createdOrderId: null, status: 'failed', error: e.message,
        });
      }
      done.add(oid);
    }
    pp.processed[store.id] = [...done].slice(-500);
  }

  pp.executions = pp.executions.slice(0, 50);
  pp.lastCycleAt = new Date().toISOString();
  await savePP(pp);
  return { created };
}

app.get('/api/post-purchase', async (req, res) => {
  const pp = await loadPP();
  let variants = [];
  let coverage = { total: 0, withSku: 0, missing: [] };
  try {
    const { pool } = await ensureFlowConfig();
    variants = await ppVariantOptions(pool);
    if (pp.sku) {
      const hit = variants.find((v) => normSku(v.sku) === normSku(pp.sku));
      const have = new Set(hit ? hit.stores : []);
      coverage = {
        total: pool.length,
        withSku: pool.filter((s) => have.has(s.id)).length,
        missing: pool.filter((s) => !have.has(s.id)).map((s) => ({ id: s.id, name: s.name })),
      };
    } else {
      coverage.total = pool.length;
    }
  } catch { /* sem flow configurado ainda */ }
  res.json({
    config: { enabled: pp.enabled, sku: pp.sku, quantity: pp.quantity, orderTag: pp.orderTag, startAt: pp.startAt },
    variants,
    coverage,
    stats: ppStats(pp),
    lastExecution: pp.executions[0] || null,
    lastCycleAt: pp.lastCycleAt || null,
  });
});

app.put('/api/post-purchase', async (req, res) => {
  const pp = await loadPP();
  const { enabled, sku, quantity, orderTag } = req.body || {};
  if (typeof sku === 'string') pp.sku = sku.trim();
  const q = parseInt(quantity, 10);
  if (q >= 1 && q <= 10) pp.quantity = q;
  if (typeof orderTag === 'string' && orderTag.trim()) pp.orderTag = orderTag.trim();
  if (typeof enabled === 'boolean') {
    if (enabled && !pp.sku) return res.status(400).json({ error: 'Escolha o produto digital antes de ativar.' });
    // ao ativar, só processa pedidos daqui pra frente (nunca o histórico)
    if (enabled && !pp.enabled) pp.startAt = new Date().toISOString();
    pp.enabled = enabled;
  }
  await savePP(pp);
  res.json({ ok: true, config: { enabled: pp.enabled, sku: pp.sku, quantity: pp.quantity, orderTag: pp.orderTag, startAt: pp.startAt } });
});

// roda um ciclo agora (botão "Salvar/Rodar agora")
app.post('/api/post-purchase/run', async (req, res) => {
  try {
    const r = await runPostPurchaseCycle();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// polling contínuo (só age se estiver ativo)
// Local: processo vivo, então dá para varrer sozinho a cada 60s.
// Vercel: serverless não mantém processo — quem chama é o cron (/api/cron/post-purchase).
if (require.main === module) {
  setInterval(() => {
    runPostPurchaseCycle().catch(() => {});
  }, 60000);
}

/*
 * Endpoint do cron (Vercel Cron ou qualquer cron externo).
 * Protegido por CRON_SECRET: a Vercel manda `Authorization: Bearer <CRON_SECRET>`.
 */
app.all('/api/cron/post-purchase', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const sent = String(req.headers.authorization || '');
    const expected = `Bearer ${secret}`;
    const a = crypto.createHash('sha256').update(sent).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Cron não autorizado.' });
  }
  try {
    const r = await runPostPurchaseCycle();
    res.json({ ok: true, at: new Date().toISOString(), ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Mapeamento de produtos: vitrine → loja de checkout ----------
 *
 * O par é escolhido à mão, produto a produto: "quem clicar NESTE produto da
 * vitrine vai para AQUELE produto da loja de checkout".
 *
 * É por produto (não por variante) porque é assim que o redirect funciona:
 * o cliente clica num produto e abre a página do produto na outra loja.
 * Independe de SKU — serve para catálogos que não usam SKU.
 *
 * data key: 'productmap' → { "<storeId>": { "<vitrineProductId>": "<storeProductId>" } }
 */

async function loadProductMap() {
  return (await db.readDoc('productmap', {})) || {};
}

async function saveProductMap(m) {
  return db.writeDoc('productmap', m);
}

// sugestão automática por SKU (só quando os dois lados têm SKU)
function suggestBySku(vitrineProducts, targetProducts) {
  const bySku = new Map();
  for (const p of targetProducts) {
    const k = normSku(p.sku);
    if (k && !bySku.has(k)) bySku.set(k, p.id);
  }
  const out = {};
  for (const p of vitrineProducts) {
    const k = normSku(p.sku);
    if (k && bySku.has(k)) out[p.id] = bySku.get(k);
  }
  return out;
}

app.get('/api/productmap', async (req, res) => {
  try {
    const storeId = req.query.store;
    const { f, stores, pool } = await ensureFlowConfig();
    const vitrineStore = stores.find((s) => s.id === f.vitrineId);
    const target = stores.find((s) => s.id === storeId);

    if (!target) return res.status(404).json({ error: 'Loja não encontrada.' });
    if (!vitrineStore) {
      return res.json({ status: 'sem_vitrine', error: 'Defina a loja vitrine no Flow.' });
    }
    if (target.id === vitrineStore.id) {
      return res.json({ status: 'e_a_vitrine', vitrine: publicStore(vitrineStore) });
    }
    if (!pool.some((p) => p.id === target.id)) {
      return res.json({ status: 'fora_do_pool', vitrine: publicStore(vitrineStore), target: publicStore(target) });
    }

    const [vitrineProducts, targetProducts] = await Promise.all([
      cached(`products:${vitrineStore.id}`, 60000, () => fetchProducts(vitrineStore)),
      cached(`products:${target.id}`, 60000, () => fetchProducts(target)),
    ]);

    const map = await loadProductMap();
    const pairs = map[storeId] || {};
    const sugestoes = suggestBySku(vitrineProducts, targetProducts);

    const linhas = vitrineProducts.map((p) => {
      const escolhido = pairs[String(p.id)] || null;
      const sugerido = sugestoes[p.id] || null;
      const alvoId = escolhido || sugerido;
      const alvo = alvoId ? targetProducts.find((t) => String(t.id) === String(alvoId)) : null;
      return {
        vitrine: { id: p.id, title: p.title, image: p.image, price: p.priceMin, sku: p.sku, handle: p.handle },
        alvo: alvo ? { id: alvo.id, title: alvo.title, image: alvo.image, price: alvo.priceMin, handle: alvo.handle } : null,
        origem: escolhido ? 'manual' : sugerido ? 'sku' : null,
      };
    });

    res.json({
      status: 'ok',
      vitrine: publicStore(vitrineStore),
      target: publicStore(target),
      opcoes: targetProducts.map((p) => ({ id: p.id, title: p.title, image: p.image, price: p.priceMin, sku: p.sku })),
      linhas,
      total: linhas.length,
      configurados: linhas.filter((l) => l.alvo).length,
      manuais: linhas.filter((l) => l.origem === 'manual').length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// define ou limpa o par de um produto
app.post('/api/productmap', async (req, res) => {
  const { storeId, vitrineProductId, storeProductId } = req.body || {};
  if (!storeId || !vitrineProductId) return res.status(400).json({ error: 'Informe a loja e o produto da vitrine.' });
  const map = await loadProductMap();
  map[storeId] = map[storeId] || {};
  if (storeProductId) map[storeId][String(vitrineProductId)] = String(storeProductId);
  else delete map[storeId][String(vitrineProductId)];
  await saveProductMap(map);
  res.json({ ok: true, configurados: Object.keys(map[storeId]).length });
});

/* ---------- OAuth (Partner App) ----------
 *
 * Alternativa ao Custom App: funciona em qualquer loja, inclusive nas que têm
 * o desenvolvimento de apps personalizados bloqueado pela organização.
 *
 * Fluxo: /api/oauth/start monta a URL de autorização → o lojista aceita na
 * Shopify → a Shopify manda o navegador de volta em /api/oauth/callback com um
 * `code` → trocamos o code pelo access token (chamada de saída) e salvamos a loja.
 *
 * Segurança: validamos o HMAC que a Shopify assina, o `state` (CSRF) que nós
 * assinamos, e o formato do domínio (evita redirect aberto / SSRF).
 */

/*
 * Escopos pedidos no OAuth. Os `unauthenticated_*` são da Storefront API
 * (o app precisa ter a Storefront API habilitada) — os demais são Admin API.
 * Dá para enxugar por ambiente com SHOPIFY_SCOPES.
 */
const OAUTH_SCOPES = process.env.SHOPIFY_SCOPES || [
  'read_orders',                            // métricas e a contagem que gira a rotação
  'write_orders',                           // pós-compra digital (criar o pedido)
  'read_products',                          // catálogo e mapeamento de produtos
  'read_script_tags', 'write_script_tags',  // injetar/remover o redirect na vitrine
  'read_themes', 'write_themes',            // alternativa: mexer no tema
  'unauthenticated_read_product_listings',  // Storefront API
  'unauthenticated_read_product_tags',
  'unauthenticated_read_checkouts',
  'unauthenticated_write_checkouts',
].join(',');
const OAUTH_STATE_MINUTES = 15;

// só aceita domínio .myshopify.com de verdade
function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(shop || ''));
}

/*
 * Base do próprio app, usada no redirect do OAuth.
 * Deriva do request: local vira http://localhost:3030, na Vercel vira o domínio
 * do deploy. Assim o OAuth funciona nos dois sem trocar configuração.
 * (APP_URL só para forçar, ex.: atrás de proxy. Não usar PANEL_URL aqui —
 * ela existe para o cron e apontaria o local para produção.)
 */
function appBaseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function oauthRedirectUri(req) {
  return `${appBaseUrl(req)}/api/oauth/callback`;
}

// state assinado: carrega a loja e um nonce, com validade curta
function makeState(shop) {
  const payload = Buffer.from(JSON.stringify({ shop, exp: Date.now() + OAUTH_STATE_MINUTES * 60000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readState(state) {
  if (!state || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

/*
 * Confere a assinatura que a Shopify põe na volta do OAuth.
 * Regra: tira hmac/signature, ordena os campos, junta com & e assina com o secret.
 */
function verifyShopifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// credenciais do Partner App (env tem prioridade; senão, o que veio pelo wizard)
async function loadOAuthConfig() {
  const saved = (await db.readDoc('oauth', {})) || {};
  return {
    clientId: process.env.SHOPIFY_API_KEY || saved.clientId || '',
    secret: process.env.SHOPIFY_API_SECRET || (saved.secret ? db.decrypt(saved.secret) : ''),
    fromEnv: !!(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET),
  };
}

async function saveOAuthConfig({ clientId, secret }) {
  await db.writeDoc('oauth', { clientId, secret: db.encrypt(secret), savedAt: new Date().toISOString() });
}

// o que mostrar no wizard: URL de redirect para cadastrar no Partner Dashboard
app.get('/api/oauth/info', async (req, res) => {
  const cfg = await loadOAuthConfig();
  res.json({
    redirectUri: oauthRedirectUri(req),
    appUrl: appBaseUrl(req),
    scopes: OAUTH_SCOPES.split(','),
    hasConfig: !!(cfg.clientId && cfg.secret),
    fromEnv: cfg.fromEnv,
  });
});

// passo 1: monta a URL de autorização
app.post('/api/oauth/start', async (req, res) => {
  try {
    const shop = normalizeDomain((req.body || {}).domain);
    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ error: 'Informe o domínio .myshopify.com da loja (ex.: minhaloja.myshopify.com).' });
    }
    const reconnect = !!(req.body || {}).reconnect;
    if (!reconnect && (await loadStores()).some((s) => s.domain === shop)) {
      return res.status(409).json({ error: 'Essa loja já está conectada no painel.' });
    }

    let { clientId, secret } = req.body || {};
    clientId = String(clientId || '').trim();
    secret = String(secret || '').trim();
    if (clientId && secret) {
      await saveOAuthConfig({ clientId, secret }); // reaproveita nas próximas lojas
    } else {
      const cfg = await loadOAuthConfig();
      clientId = cfg.clientId;
      secret = cfg.secret;
    }
    if (!clientId || !secret) {
      return res.status(400).json({ error: 'Informe o Client ID e o Secret do app (Partner Dashboard → App setup).' });
    }

    const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(oauthRedirectUri(req))}` +
      `&state=${encodeURIComponent(makeState(shop))}`;
    res.json({ ok: true, url, redirectUri: oauthRedirectUri(req) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// passo 2: a Shopify manda o navegador de volta aqui
app.get('/api/oauth/callback', async (req, res) => {
  const falha = (msg) => res.status(400).send(
    `<!doctype html><meta charset="utf-8"><title>Falha na conexão</title>` +
    `<body style="font-family:system-ui;padding:40px;max-width:640px;margin:auto;color:#101828">` +
    `<h2 style="color:#d03b3b">Não deu para conectar</h2><p>${msg}</p>` +
    `<p><a href="/">← Voltar ao painel</a></p></body>`
  );
  try {
    const { code, shop, state } = req.query;
    if (!isValidShopDomain(shop)) return falha('Domínio de loja inválido.');

    const st = readState(state);
    if (!st) return falha('O pedido expirou ou é inválido (state). Tente conectar de novo pelo painel.');
    if (st.shop !== String(shop).toLowerCase()) return falha('A loja da autorização não confere com a que você pediu.');

    const cfg = await loadOAuthConfig();
    if (!cfg.clientId || !cfg.secret) return falha('As credenciais do app não estão configuradas.');
    if (!verifyShopifyHmac(req.query, cfg.secret)) return falha('Assinatura inválida (HMAC) — a resposta não veio da Shopify.');
    if (!code) return falha('A Shopify não devolveu o código de autorização.');

    // troca o code pelo access token (chamada de saída, funciona até rodando local)
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.secret, code }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return falha(`A Shopify recusou a troca do código: ${r.status} ${t.slice(0, 160)}`);
    }
    const { access_token: token, scope } = await r.json();
    if (!token) return falha('A Shopify não devolveu o access token.');

    // confirma o token e pega nome/moeda
    let name = shop.replace('.myshopify.com', '');
    let currency = 'BRL';
    try {
      const { data } = await shopifyFetch({ domain: shop, token }, 'shop.json');
      name = data.shop.name || name;
      currency = data.shop.currency || currency;
    } catch { /* segue com o padrão */ }

    const stores = await loadStores();

    // reconexão: loja já existe → atualiza token/escopos preservando id, pool e mapeamentos
    const existente = stores.find((s) => s.domain === shop);
    if (existente) {
      existente.token = token;
      existente.currency = currency;
      existente.auth = 'oauth';
      existente.scopes = scope || OAUTH_SCOPES;
      existente.reconnectedAt = new Date().toISOString();
      await saveStores(stores);
      // descarta o Storefront token antigo para re-emitir com o novo grant
      try {
        const all = await loadSfTokens();
        if (all[existente.id]) { delete all[existente.id]; await db.writeDoc('storefront_tokens', all); }
      } catch { /* não impede a reconexão */ }
      cache.clear();
      return res.redirect(`/?reconectada=${encodeURIComponent(existente.name)}`);
    }

    const store = {
      id: crypto.randomUUID(),
      name,
      domain: shop,
      token,
      currency,
      platform: 'shopify',
      connectedAt: new Date().toISOString(),
      auth: 'oauth',
      scopes: scope || OAUTH_SCOPES,
    };
    stores.push(store);
    await saveStores(stores);
    cache.clear();

    // loja nova entra no pool de checkout (a primeira vira vitrine)
    try {
      const { f } = await ensureFlowConfig();
      if (f.vitrineId && store.id !== f.vitrineId && !f.pool.some((p) => p.id === store.id)) {
        f.pool.push({ id: store.id, limit: DEFAULT_LIMIT, dailyLimit: 0, paused: false, resetAt: null });
        if (!f.state.activeId) f.state = { activeId: store.id, activatedAt: new Date().toISOString() };
        await saveFlowConfig(f);
      }
    } catch { /* não impede a conexão */ }

    res.redirect(`/?conectada=${encodeURIComponent(name)}`);
  } catch (e) {
    falha(e.message);
  }
});

/* ---------- Redirect da vitrine → loja de checkout ----------
 *
 * Três peças:
 *  1. /redirect.js  → script público que roda na vitrine (injetado via ScriptTag)
 *  2. /api/resolve  → público (CORS): "produto X da vitrine vai para qual URL?"
 *  3. /api/script/* → instala/remove o ScriptTag na vitrine (write_script_tags)
 *
 * O destino é sempre a loja de checkout ATIVA no Flow — então a rotação
 * (limite de vendas, pausa, limite diário) vale automaticamente no redirect.
 */

// destination: 'checkout' = monta o carrinho na loja de checkout e joga direto no pagamento (Storefront API);
//              'product'  = leva para a página do produto na loja de checkout.
// trigger: 'click' = só redireciona quando o cliente clica em comprar/adicionar ao carrinho;
//          'load'  = redireciona assim que a página do produto abre.
const REDIRECT_DEFAULTS = { enabled: false, mode: 'ads', keepParams: true, destination: 'checkout', trigger: 'click' };

async function loadRedirectConfig() {
  return { ...REDIRECT_DEFAULTS, ...((await db.readDoc('redirect', {})) || {}) };
}

async function saveRedirectConfig(c) {
  return db.writeDoc('redirect', c);
}

/* ---------- Storefront API: token + carrinho (checkout direto) ----------
 *
 * O próprio app Admin (com os escopos unauthenticated_*) cria um Storefront
 * access token para a loja — não precisa instalar o app "Headless" à parte.
 * Com esse token montamos um carrinho (cartCreate) e pegamos o checkoutUrl,
 * que leva o cliente direto para o pagamento com o produto já no carrinho.
 */

const STOREFRONT_TOKEN_TITLE = 'Painel Contingencia';

// traduz a falha de criar o Storefront token em algo acionável
function explainStorefrontError(e) {
  const raw = String(e && e.message || e);
  if (/extendable|storefront access token|403|401|unauthenticated|access denied|scope/i.test(raw)) {
    return 'O app desta loja não consegue gerar o token da Storefront API. '
      + 'Caminho mais simples: instale o canal Headless na loja de checkout (App Store → Headless), '
      + 'copie o "public access token" e cole no campo abaixo. Enquanto isso o cliente cai na página do produto.';
  }
  return raw.slice(0, 180);
}

async function loadSfTokens() {
  return (await db.readDoc('storefront_tokens', {})) || {};
}
async function saveSfToken(storeId, token) {
  const all = await loadSfTokens();
  all[storeId] = token;
  await db.writeDoc('storefront_tokens', all);
}

// devolve (criando se preciso) o Storefront access token da loja. Exige os escopos unauthenticated_*.
async function ensureStorefrontToken(store) {
  const all = await loadSfTokens();
  if (all[store.id]) return all[store.id];

  // reaproveita um token já existente antes de criar outro
  try {
    const { data } = await shopifyFetch(store, 'storefront_access_tokens.json');
    const existing = (data.storefront_access_tokens || []).find((t) => t.title === STOREFRONT_TOKEN_TITLE)
      || (data.storefront_access_tokens || [])[0];
    if (existing && existing.access_token) {
      await saveSfToken(store.id, existing.access_token);
      return existing.access_token;
    }
  } catch { /* segue para criar */ }

  const { data } = await shopifyRequest(store, 'storefront_access_tokens.json', {
    method: 'POST',
    body: { storefront_access_token: { title: STOREFRONT_TOKEN_TITLE } },
  });
  const tok = data && data.storefront_access_token && data.storefront_access_token.access_token;
  if (!tok) throw new Error('A loja não devolveu um Storefront access token.');
  await saveSfToken(store.id, tok);
  return tok;
}

async function storefrontRequest(store, query, variables) {
  const token = await ensureStorefrontToken(store);
  let res;
  try {
    res = await fetch(`https://${store.domain}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Sem resposta da Storefront de ${store.domain} (rede/timeout).`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Storefront ${res.status} em ${store.domain}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Resposta inválida da Storefront API.'); }
  if (json.errors) throw new Error(typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors));
  return json.data;
}

// monta o carrinho com a variante e devolve o checkoutUrl (pagamento direto)
async function buildCheckoutUrl(store, variantId) {
  if (!variantId) throw new Error('Produto de destino sem variante para o carrinho.');
  const q = 'mutation cc($lines:[CartLineInput!]!){cartCreate(input:{lines:$lines}){cart{checkoutUrl} userErrors{field message}}}';
  const data = await storefrontRequest(store, q, {
    lines: [{ merchandiseId: `gid://shopify/ProductVariant/${variantId}`, quantity: 1 }],
  });
  const ue = (data.cartCreate && data.cartCreate.userErrors) || [];
  if (ue.length) throw new Error(ue[0].message);
  const url = data.cartCreate && data.cartCreate.cart && data.cartCreate.cart.checkoutUrl;
  if (!url) throw new Error('A Storefront API não devolveu o checkoutUrl.');
  return url;
}

/* ---------- 1. o script que roda na loja do cliente ---------- */

function buildStorefrontScript(panelUrl, cfg) {
  // sem template literal aninhado: o script vai como texto puro para o navegador do cliente
  return `/* Painel Contingência — redirect vitrine → checkout */
(function () {
  var PANEL = ${JSON.stringify(panelUrl)};
  var MODE = ${JSON.stringify(cfg.mode)};
  var KEEP = ${JSON.stringify(!!cfg.keepParams)};
  var TRIGGER = ${JSON.stringify(cfg.trigger === 'load' ? 'load' : 'click')};

  try {
    if (!window.Shopify || !window.Shopify.shop) return;
    if (window.top !== window.self) return;              // não redireciona dentro do editor de tema
    if (/\\/admin/.test(location.pathname)) return;

    var m = location.pathname.match(/\\/products\\/([^\\/?#]+)/);
    if (!m) return;                                       // só em página de produto
    var handle = m[1];

    var qs = new URLSearchParams(location.search);
    if (qs.get('noredirect') === '1') return;             // atalho para você testar a vitrine

    // modo "ads": só redireciona quem veio de anúncio
    if (MODE === 'ads') {
      var adParams = ['fbclid', 'gclid', 'ttclid', 'twclid', 'msclkid', 'utm_source', 'utm_medium', 'utm_campaign'];
      var veioDeAnuncio = adParams.some(function (p) { return qs.has(p); });
      if (!veioDeAnuncio) return;
    }

    function irPara(alvo) {
      if (!alvo) return;
      if (KEEP && location.search) {                       // leva utm/fbclid para a outra loja
        alvo += (alvo.indexOf('?') === -1 ? '?' : '&') + location.search.slice(1);
      }
      location.replace(alvo);                              // replace: não suja o histórico
    }

    // já busca o destino ao abrir (pra o clique redirecionar instantâneo)
    var alvoUrl = null;
    var url = PANEL + '/api/resolve?shop=' + encodeURIComponent(Shopify.shop) + '&handle=' + encodeURIComponent(handle);
    fetch(url, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        alvoUrl = (d && d.url) ? d.url : null;             // sem par mapeado: fica null → loja normal
        if (TRIGGER === 'load') irPara(alvoUrl);
      })
      .catch(function () { /* painel fora do ar: o cliente segue na vitrine */ });

    if (TRIGGER === 'load') return;                        // modo "ao abrir": nada mais a fazer

    // modo "ao clicar em comprar": intercepta os botões de compra do produto
    var SELETOR_COMPRA = 'form[action*="/cart/add"] [type="submit"], form[action*="/cart/add"] [name="add"],'
      + ' button[name="add"], .shopify-payment-button, .shopify-payment-button__button,'
      + ' [data-shopify="payment-button"], a[href*="/checkout"], a[href*="/cart"]';

    document.addEventListener('click', function (e) {
      if (!alvoUrl) return;                                // sem par: deixa a compra normal seguir
      var alvoEl = e.target && e.target.closest ? e.target.closest(SELETOR_COMPRA) : null;
      if (!alvoEl) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      irPara(alvoUrl);
    }, true);

    // "adicionar ao carrinho" costuma submeter um <form action="/cart/add">
    document.addEventListener('submit', function (e) {
      if (!alvoUrl) return;
      if (e.target && e.target.matches && e.target.matches('form[action*="/cart/add"]')) {
        e.preventDefault();
        e.stopPropagation();
        irPara(alvoUrl);
      }
    }, true);
  } catch (e) { /* nunca quebra a loja do cliente */ }
})();`;
}

// servido público (é o navegador do cliente que baixa)
app.get('/redirect.js', async (req, res) => {
  try {
    const cfg = await loadRedirectConfig();
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!cfg.enabled) return res.send('/* redirect desligado no painel */');
    res.send(buildStorefrontScript(appBaseUrl(req), cfg));
  } catch (e) {
    res.type('application/javascript').send('/* erro ao montar o script */');
  }
});

/* ---------- 2. resolve: para onde este produto vai ---------- */

app.get('/api/resolve', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { shop, handle, product, store: storeParam } = req.query;
    const cfg = await loadRedirectConfig();
    const ctx = await ensureFlowConfig();
    const { f, stores, pool } = ctx;

    // quem pergunta tem que ser a vitrine (evita loop e uso indevido)
    if (shop) {
      const vitrine = stores.find((s) => s.id === f.vitrineId);
      if (!vitrine || normalizeDomain(shop) !== vitrine.domain) {
        return res.status(404).json({ error: 'Esta loja não é a vitrine configurada.' });
      }
      if (!cfg.enabled) return res.status(404).json({ error: 'Redirect desligado.' });
      if (f.paused) return res.status(404).json({ error: 'Operação pausada no painel.' });
    }

    // destino: a loja de checkout ATIVA (respeita rotação, pausa e limite diário)
    let target;
    if (storeParam) {
      target = stores.find((s) => s.id === storeParam);
    } else {
      const ativa = pool.find((p) => p.cfg.id === f.state.activeId) || pool[0];
      target = ativa;
    }
    if (!target) return res.status(404).json({ error: 'Nenhuma loja de checkout disponível.' });

    // acha o produto da vitrine (por handle ou id)
    const vitrineStore = stores.find((s) => s.id === f.vitrineId);
    if (!vitrineStore) return res.status(404).json({ error: 'Vitrine não configurada.' });
    const vitrineProducts = await cached(`products:${vitrineStore.id}`, 60000, () => fetchProducts(vitrineStore));
    const origem = handle
      ? vitrineProducts.find((p) => p.handle === String(handle).toLowerCase())
      : vitrineProducts.find((p) => String(p.id) === String(product));
    if (!origem) return res.status(404).json({ error: 'Produto não encontrado na vitrine.' });

    // par manual escolhido no painel; se não houver, tenta pelo SKU
    const map = await loadProductMap();
    let alvoId = (map[target.id] || {})[String(origem.id)] || null;
    const targetProducts = await cached(`products:${target.id}`, 60000, () => fetchProducts(target));
    if (!alvoId) alvoId = suggestBySku(vitrineProducts, targetProducts)[origem.id] || null;
    if (!alvoId) return res.status(404).json({ error: 'Esse produto não está mapeado nesta loja de checkout.' });

    const alvo = targetProducts.find((p) => String(p.id) === String(alvoId));
    if (!alvo) return res.status(404).json({ error: 'O produto de destino não existe mais.' });

    const productUrl = `https://${target.domain}/products/${alvo.handle}`;
    let url = productUrl;
    let via = 'product';
    let warning = null;

    // checkout direto: monta o carrinho na loja de checkout e manda para o pagamento
    if (cfg.destination === 'checkout') {
      try {
        url = await buildCheckoutUrl(target, alvo.variantId);
        via = 'checkout';
      } catch (e) {
        // nunca deixa o cliente na mão: cai para a página do produto e avisa o painel
        via = 'product-fallback';
        warning = e.message;
      }
    }

    res.json({
      ok: true,
      via,
      warning,
      loja: { id: target.id, name: target.name, domain: target.domain },
      produto: { id: alvo.id, title: alvo.title, handle: alvo.handle },
      productUrl,
      url,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- 3. instalar/remover o ScriptTag na vitrine ---------- */

const SCRIPT_PATH = '/redirect.js';

async function findScriptTag(store, src) {
  const { data } = await shopifyFetch(store, 'script_tags.json?limit=250');
  return (data.script_tags || []).find((t) => String(t.src || '').split('?')[0] === src.split('?')[0]) || null;
}

app.get('/api/script/status', async (req, res) => {
  try {
    const cfg = await loadRedirectConfig();
    const { f, stores } = await ensureFlowConfig();
    const vitrine = stores.find((s) => s.id === f.vitrineId);
    const src = `${appBaseUrl(req)}${SCRIPT_PATH}`;
    if (!vitrine) return res.json({ config: cfg, src, vitrine: null, installed: false });

    let installed = false;
    let error = null;
    try {
      installed = !!(await findScriptTag(vitrine, src));
    } catch (e) {
      error = explainShopifyError(e, vitrine.domain);
    }
    res.json({ config: cfg, src, vitrine: publicStore(vitrine), installed, error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/script/config', async (req, res) => {
  const cfg = await loadRedirectConfig();
  const { enabled, mode, keepParams, destination, trigger } = req.body || {};
  if (typeof enabled === 'boolean') cfg.enabled = enabled;
  if (['ads', 'always'].includes(mode)) cfg.mode = mode;
  if (typeof keepParams === 'boolean') cfg.keepParams = keepParams;
  if (['checkout', 'product'].includes(destination)) cfg.destination = destination;
  if (['click', 'load'].includes(trigger)) cfg.trigger = trigger;
  await saveRedirectConfig(cfg);
  res.json({ ok: true, config: cfg });
});

// checa se a loja de checkout ativa consegue montar carrinho (Storefront pronta?)
app.get('/api/script/checkout-check', async (req, res) => {
  try {
    const { f, stores, pool } = await ensureFlowConfig();
    const ativa = pool.find((p) => p.cfg.id === f.state.activeId) || pool[0];
    if (!ativa) return res.json({ ready: false, reason: 'Nenhuma loja de checkout no Flow.' });
    const st = { id: ativa.id, name: ativa.name, domain: ativa.domain };
    const hasToken = !!(await loadSfTokens())[ativa.id];
    try {
      await ensureStorefrontToken(ativa);
      res.json({ ready: true, store: st, hasToken });
    } catch (e) {
      res.json({ ready: false, store: st, hasToken, reason: explainStorefrontError(e) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- token Storefront colado à mão (canal Headless) ----------
 * Para lojas onde não dá para criar o token pelo Admin (custom app indisponível,
 * Storefront API bloqueada no app OAuth): o lojista instala o canal Headless,
 * copia o "public access token" e cola aqui. Vale por loja de checkout.
 */
app.post('/api/stores/:id/storefront-token', async (req, res) => {
  try {
    const store = (await loadStores()).find((s) => s.id === req.params.id);
    if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
    const token = String((req.body || {}).token || '').trim();

    // vazio → remover
    if (!token) {
      const all = await loadSfTokens();
      if (all[store.id]) { delete all[store.id]; await db.writeDoc('storefront_tokens', all); }
      return res.json({ ok: true, removed: true });
    }

    // valida contra a própria loja antes de salvar
    const r = await fetch(`https://${store.domain}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
      body: JSON.stringify({ query: '{ shop { name } }' }),
    });
    const txt = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) {
      return res.status(400).json({ error: 'A loja recusou esse token Storefront (401/403). Confira se copiou o "public access token" do canal Headless da loja de checkout.' });
    }
    if (!r.ok) return res.status(400).json({ error: `A loja respondeu ${r.status} ao validar o token. ${txt.slice(0, 120)}` });
    let j; try { j = JSON.parse(txt); } catch { j = null; }
    if (!j || j.errors || !(j.data && j.data.shop)) {
      return res.status(400).json({ error: 'Token Storefront inválido para esta loja.' });
    }

    await saveSfToken(store.id, token);
    res.json({ ok: true, shop: j.data.shop.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/script/install', async (req, res) => {
  try {
    const { f, stores } = await ensureFlowConfig();
    const vitrine = stores.find((s) => s.id === f.vitrineId);
    if (!vitrine) return res.status(400).json({ error: 'Defina a loja vitrine no Flow antes de instalar o script.' });
    const base = appBaseUrl(req);
    if (!/^https:/.test(base)) {
      return res.status(400).json({ error: `A Shopify só aceita script em HTTPS. O painel está em ${base} — publique-o (Vercel) e instale de lá.` });
    }
    const src = `${base}${SCRIPT_PATH}`;
    const existente = await findScriptTag(vitrine, src);
    if (existente) return res.json({ ok: true, alreadyInstalled: true, id: existente.id, src });

    const { data } = await shopifyRequest(vitrine, 'script_tags.json', {
      method: 'POST',
      body: { script_tag: { event: 'onload', src, display_scope: 'online_store' } },
    });
    res.json({ ok: true, id: data.script_tag.id, src });
  } catch (e) {
    res.status(400).json({ error: explainShopifyError(e, 'a vitrine') });
  }
});

app.post('/api/script/remove', async (req, res) => {
  try {
    const { f, stores } = await ensureFlowConfig();
    const vitrine = stores.find((s) => s.id === f.vitrineId);
    if (!vitrine) return res.status(400).json({ error: 'Vitrine não configurada.' });
    const src = `${appBaseUrl(req)}${SCRIPT_PATH}`;
    const tag = await findScriptTag(vitrine, src);
    if (!tag) return res.json({ ok: true, naoEstavaInstalado: true });
    await shopifyRequest(vitrine, `script_tags/${tag.id}.json`, { method: 'DELETE' });
    res.json({ ok: true, removido: tag.id });
  } catch (e) {
    res.status(400).json({ error: explainShopifyError(e, 'a vitrine') });
  }
});

/* ---------- rotas: métricas ---------- */

async function selectStores(req) {
  const stores = await loadStores();
  const filter = req.query.store;
  return { stores: filter && filter !== 'all' ? stores.filter((s) => s.id === filter) : stores };
}

app.get('/api/metrics', async (req, res) => {
  const range = ['today', 'yesterday', '7d', '30d'].includes(req.query.range) ? req.query.range : 'today';
  const { stores } = await selectStores(req);
  const bounds = rangeBounds(range);
  try {
    let orders = [];
    let storesWithStatus = stores;
    let truncated = false;
    if (stores.length) {
      const key = `m:${range}:${stores.map((s) => s.id).join(',')}`;
      const results = await cached(key, 45000, () => collectOrders(stores, bounds.prevStart, bounds.end));
      orders = results.flatMap((r) => r.orders);
      truncated = results.some((r) => r.truncated);
      storesWithStatus = results.map((r) => ({ ...r.store, error: r.error }));
    }
    const metrics = buildMetrics(orders, bounds, storesWithStatus);
    res.json({ range, truncated, currency: stores[0] ? stores[0].currency || 'BRL' : 'BRL', ...metrics });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live', async (req, res) => {
  const { stores } = await selectStores(req);
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 60 * 1000);
  try {
    let orders = [];
    if (stores.length) {
      const key = `live:${stores.map((s) => s.id).join(',')}`;
      const results = await cached(key, 25000, () => collectOrders(stores, from, now));
      orders = results.flatMap((r) => r.orders);
    }
    orders.sort((a, b) => b.createdAt - a.createdAt);
    const m = sumMetrics(orders);
    res.json({
      orders60m: m.orders,
      sales60m: m.sales,
      recent: orders.slice(0, 12).map((o) => ({
        store: o.storeName,
        storeId: o.storeId,
        number: o.number,
        total: o.total,
        city: o.city,
        country: o.country,
        countryCode: o.countryCode,
        lat: o.lat,
        lng: o.lng,
        itemCount: o.items.reduce((s, it) => s + it.qty, 0),
        createdAt: o.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- inicialização ----------
 * Local: escuta em 127.0.0.1 (só sua máquina).
 * Vercel: o app é exportado e a plataforma cuida do servidor.
 */
if (require.main === module) {
  // HOST=0.0.0.0 só se você realmente quiser expor na rede
  const HOST = process.env.HOST || '127.0.0.1';
  app.listen(PORT, HOST, async () => {
    console.log(`Dashboard rodando em http://localhost:${PORT}`);
    console.log(`Armazenamento: ${db.USE_SUPABASE ? 'Supabase' : 'arquivos locais (data/)'}`);
    try {
      const n = (await loadStores()).length;
      console.log(n === 0 ? 'Nenhuma loja cadastrada — conecte a primeira em "Lojas".' : `${n} loja(s) cadastrada(s).`);
    } catch (e) {
      console.log('Aviso: não consegui ler as lojas —', e.message);
    }
  });
}

module.exports = app;
