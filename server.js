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

/* ---------- contas (multi-login, cada uma com seu ambiente isolado) ----------
 * Doc global 'accounts': [{ id, user, salt, hash, role: 'admin'|'user', ns, createdAt }]
 *  - admin: criado no primeiro login com PANEL_PASSWORD; ns '' = dados legados (nada migra).
 *  - contas novas: ns = id → todos os documentos ganham prefixo acc:<id>: no banco.
 * A sessão (cookie) carrega { u, ns, r, exp } assinados por HMAC.
 */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('base64');
}

function checkPassword(account, password) {
  const expected = Buffer.from(account.hash, 'base64');
  const got = crypto.scryptSync(String(password), account.salt, 64);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

async function loadAccounts() {
  const raw = (await db.readDocGlobal('accounts', [])) || [];
  return Array.isArray(raw) ? raw : [];
}

async function saveAccounts(list) {
  return db.writeDocGlobal('accounts', list);
}

function makeToken(account) {
  const payload = Buffer.from(JSON.stringify({
    u: account.user,
    ns: account.ns || '',
    r: account.role || 'user',
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// devolve { u, ns, r } ou null
function parseToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
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

// índice global domínio da loja → namespace da conta (para as rotas públicas)
let shopNsCache = { at: 0, map: {} };
async function shopNsLookup(shop) {
  const domain = String(shop || '').trim().toLowerCase();
  if (!domain) return '';
  if (Date.now() - shopNsCache.at > 60000) {
    try { shopNsCache = { at: Date.now(), map: (await db.readDocGlobal('shop_ns', {})) || {} }; }
    catch { shopNsCache.at = Date.now(); }
  }
  return shopNsCache.map[domain] || ''; // sem registro → namespace legado (admin)
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

const LOGIN_PATHS = new Set(['/login', '/api/login', '/api/register', '/utm/redirect']);

app.use(async (req, res, next) => {
  if (IS_HOSTED && !PANEL_PASSWORD) {
    return res.status(503).json({
      error: 'PANEL_PASSWORD não configurada. O painel está bloqueado para não expor suas lojas e tokens — defina essa variável de ambiente e faça o redeploy.',
    });
  }
  if (!PANEL_PASSWORD) return db.runAsAccount('', next); // local sem senha → ambiente legado/admin
  /*
   * Rotas públicas (não passam pelo login) e por quê:
   * - /api/oauth/callback: vem da Shopify; provado por state assinado + HMAC (o state carrega a conta).
   * - /api/cron/*: protegido por CRON_SECRET; o handler roda o ciclo de CADA conta.
   * - /redirect.js, /api/resolve e /api/beacon: rodam no NAVEGADOR DO CLIENTE da loja —
   *   a conta dona é resolvida pelo ?shop= via índice global (sem expor nada sensível).
   */
  if (LOGIN_PATHS.has(req.path) || req.path.startsWith('/api/cron/')) return next();
  if (req.path === '/api/oauth/callback') {
    const st = readState(req.query.state); // hoisted — definida mais abaixo
    return db.runAsAccount((st && st.ns) || '', next);
  }
  if (req.path === '/redirect.js' || req.path === '/api/resolve' || req.path === '/api/beacon') {
    const ns = await shopNsLookup(req.query.shop).catch(() => '');
    return db.runAsAccount(ns, next);
  }
  // portal público de rastreio (/t = busca por código, /t/<código> = linha do tempo):
  // o cliente final acessa sem login; o handler resolve a conta dona pelo índice global
  if (req.path === '/t' || req.path.startsWith('/t/')) return next();
  // arquivos estáticos (css/js/fontes/imagens) são públicos: a própria tela de login
  // precisa deles e não contêm segredo — as APIs continuam exigindo o cookie.
  if (/\.(css|js|mjs|woff2?|ttf|otf|png|jpe?g|svg|gif|ico|webp|map)$/i.test(req.path)) return next();
  const sess = parseToken(readCookie(req, COOKIE));
  if (sess) {
    req.account = sess; // { u, ns, r }
    return db.runAsAccount(sess.ns, next);
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado.' });
  return res.redirect('/login');
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

function isMasterPassword(pass) {
  if (!PANEL_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(pass)).digest();
  const b = crypto.createHash('sha256').update(PANEL_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/api/login', async (req, res) => {
  try {
    const user = String((req.body || {}).user || 'admin').trim().toLowerCase();
    const pass = String((req.body || {}).password || '');
    if (!PANEL_PASSWORD) return res.status(400).json({ error: 'Painel local sem senha — login não é necessário.' });

    const accounts = await loadAccounts();
    let account = accounts.find((a) => a.user === user) || null;

    let ok = false;
    if (account && account.hash && checkPassword(account, pass)) ok = true;
    // 'admin' sempre entra com a PANEL_PASSWORD (bootstrap + recuperação)
    if (!ok && user === 'admin' && isMasterPassword(pass)) {
      ok = true;
      if (!account) {
        const salt = crypto.randomBytes(16).toString('base64');
        account = { id: 'admin', user: 'admin', role: 'admin', ns: '', salt, hash: hashPassword(pass, salt), createdAt: new Date().toISOString() };
        accounts.push(account);
        await saveAccounts(accounts);
      }
    }
    if (!ok || !account) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

    res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(account)}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax${IS_HOSTED ? '; Secure' : ''}`);
    res.json({ ok: true, user: account.user, role: account.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${IS_HOSTED ? '; Secure' : ''}`);
  res.json({ ok: true });
});

/* ---------- gerenciamento de contas (multi-login) ---------- */

function sessionInfo(req) {
  if (!PANEL_PASSWORD) return { user: 'admin', role: 'admin', ns: '' }; // local sem senha
  return req.account ? { user: req.account.u, role: req.account.r, ns: req.account.ns } : null;
}

function requireAdmin(req, res) {
  const s = sessionInfo(req);
  if (!s || s.role !== 'admin') {
    res.status(403).json({ error: 'Só a conta admin gerencia contas.' });
    return false;
  }
  return true;
}

app.get('/api/session', (req, res) => {
  const s = sessionInfo(req);
  if (!s) return res.status(401).json({ error: 'Não autenticado.' });
  res.json({ user: s.user, role: s.role });
});

app.get('/api/accounts', async (req, res) => {
  try {
    const s = sessionInfo(req);
    if (!s) return res.status(401).json({ error: 'Não autenticado.' });
    const out = { me: { user: s.user, role: s.role } };
    if (s.role === 'admin') {
      out.accounts = (await loadAccounts()).map((a) => ({ id: a.id, user: a.user, role: a.role, createdAt: a.createdAt }));
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const user = String((req.body || {}).user || '').trim().toLowerCase();
    const pass = String((req.body || {}).password || '');
    if (!/^[a-z0-9._-]{3,30}$/.test(user)) return res.status(400).json({ error: 'Usuário inválido — use 3 a 30 letras minúsculas, números, ponto, hífen ou _.' });
    if (pass.length < 6) return res.status(400).json({ error: 'Senha muito curta (mínimo 6 caracteres).' });
    const accounts = await loadAccounts();
    if (accounts.some((a) => a.user === user)) return res.status(409).json({ error: 'Já existe uma conta com esse usuário.' });
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('base64');
    const conta = { id, user, role: 'user', ns: id, salt, hash: hashPassword(pass, salt), createdAt: new Date().toISOString() };
    accounts.push(conta);
    await saveAccounts(accounts);
    res.json({ ok: true, account: { id, user, role: 'user', createdAt: conta.createdAt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = String(req.params.id);
    if (id === 'admin') return res.status(400).json({ error: 'A conta admin não pode ser excluída.' });
    const accounts = await loadAccounts();
    const alvo = accounts.find((a) => a.id === id);
    if (!alvo) return res.status(404).json({ error: 'Conta não encontrada.' });
    await saveAccounts(accounts.filter((a) => a.id !== id));
    // apaga o ambiente da conta (lojas, flow, tracking, tudo) e limpa o índice de domínios
    try { await db.purgeAccountDocs(alvo.ns); } catch { /* melhor esforço */ }
    try {
      const idx = (await db.readDocGlobal('shop_ns', {})) || {};
      for (const d of Object.keys(idx)) if (idx[d] === alvo.ns) delete idx[d];
      await db.writeDocGlobal('shop_ns', idx);
      shopNsCache = { at: 0, map: {} };
    } catch { /* idem */ }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- auto-cadastro com código de convite ----------
 * O admin vê/gera o código na seção "Contas de acesso" e passa pra pessoa.
 * Na tela de login, "Criar nova conta" pede usuário + senha + código.
 * Sem o código, ninguém cria conta — o painel não fica aberto pra estranhos.
 */

async function ensureInviteCode() {
  let inv = (await db.readDocGlobal('invite', null)) || null;
  if (!inv || !inv.code) {
    inv = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), at: new Date().toISOString() };
    await db.writeDocGlobal('invite', inv);
  }
  return inv;
}

app.get('/api/accounts/invite', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    res.json({ code: (await ensureInviteCode()).code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts/invite', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const inv = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), at: new Date().toISOString() };
    await db.writeDocGlobal('invite', inv); // invalida o código antigo na hora
    res.json({ code: inv.code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// público (tela de login): cria a conta se o código de convite bater, e já entra
app.post('/api/register', async (req, res) => {
  try {
    if (!PANEL_PASSWORD) return res.status(400).json({ error: 'Painel local sem senha — não precisa de conta.' });
    const user = String((req.body || {}).user || '').trim().toLowerCase();
    const pass = String((req.body || {}).password || '');
    const invite = String((req.body || {}).invite || '').trim().toUpperCase();
    const inv = (await db.readDocGlobal('invite', null)) || null;
    if (!inv || !inv.code || invite !== inv.code) return res.status(401).json({ error: 'Código de convite inválido — peça o código pro admin.' });
    if (!/^[a-z0-9._-]{3,30}$/.test(user)) return res.status(400).json({ error: 'Usuário inválido — use 3 a 30 letras minúsculas, números, ponto, hífen ou _.' });
    if (pass.length < 6) return res.status(400).json({ error: 'Senha muito curta (mínimo 6 caracteres).' });
    const accounts = await loadAccounts();
    if (accounts.some((a) => a.user === user)) return res.status(409).json({ error: 'Já existe uma conta com esse usuário.' });
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('base64');
    const conta = { id, user, role: 'user', ns: id, salt, hash: hashPassword(pass, salt), createdAt: new Date().toISOString() };
    accounts.push(conta);
    await saveAccounts(accounts);
    res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(conta)}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax${IS_HOSTED ? '; Secure' : ''}`);
    res.json({ ok: true, user: conta.user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// troca a própria senha (qualquer conta logada)
app.post('/api/accounts/password', async (req, res) => {
  try {
    const s = sessionInfo(req);
    if (!s) return res.status(401).json({ error: 'Não autenticado.' });
    const atual = String((req.body || {}).current || '');
    const nova = String((req.body || {}).password || '');
    if (nova.length < 6) return res.status(400).json({ error: 'Senha muito curta (mínimo 6 caracteres).' });
    const accounts = await loadAccounts();
    const account = accounts.find((a) => a.user === s.user);
    if (!account) return res.status(404).json({ error: 'Conta não encontrada.' });
    const confere = (account.hash && checkPassword(account, atual)) || (s.user === 'admin' && isMasterPassword(atual));
    if (!confere) return res.status(401).json({ error: 'Senha atual incorreta.' });
    account.salt = crypto.randomBytes(16).toString('base64');
    account.hash = hashPassword(nova, account.salt);
    await saveAccounts(accounts);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));

// Rota segura que recebe `target` (URL do checkout externo), lê UTMs do cookie
// `utm_params` e redireciona para o checkout anexando os UTMs. Use apenas em
// ambiente local ou quando confiar na origem porque abre redirect para URLs
// externas.
app.get('/utm/redirect', (req, res) => {
  const target = req.query.target;
  if (!target) return res.status(400).send('Missing target');
  // lê cookie utmify_params se existir
  let utm = {};
  try {
    const raw = req.headers.cookie || '';
    const part = raw.split(';').map(c=>c.trim()).find(c=>c.startsWith('utmify_params='));
    if (part) {
      const val = decodeURIComponent(part.slice('utmify_params='.length));
      const obj = JSON.parse(val);
      if (obj && obj.v) utm = obj.v;
    }
  } catch (e) { /* ignore */ }
  // também aceita UTMs vindas na query atual (por ex. do ad)
  const extraParams = ['fbclid','gclid','ttclid','twclid','msclkid'];
  for (const [k,v] of Object.entries(req.query || {})) {
    if (k.startsWith('utm_') || extraParams.includes(k)) {
      utm[k] = v;
    }
  }

  try {
    const u = new URL(String(target));
    for (const [k,v] of Object.entries(utm)) if (v != null) u.searchParams.set(k, String(v));
    return res.redirect(302, u.toString());
  } catch (e) {
    // fallback concatenation
    const qs = new URLSearchParams(utm).toString();
    const sep = target.includes('?') ? '&' : '?';
    return res.redirect(302, target + (qs ? sep + qs : ''));
  }
});

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
    fields: 'id,name,created_at,total_price,currency,cancelled_at,test,financial_status,line_items,shipping_address,customer,email',
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
        orderId: o.id,
        email: o.email || null,
        customerName: o.customer ? [o.customer.first_name, o.customer.last_name].filter(Boolean).join(' ') : null,
        number: o.name,
        createdAt: new Date(o.created_at),
        total: parseFloat(o.total_price) || 0,
        currency: o.currency,
        status: o.financial_status || 'paid',
        addr: o.shipping_address ? [o.shipping_address.address1, o.shipping_address.address2, o.shipping_address.city, o.shipping_address.zip, o.shipping_address.country_code].filter(Boolean).join(', ') : null,
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
        // orders_count do cliente na hora do pedido: 1 = novo, >1 = recorrente
        customerOrders: o.customer && o.customer.orders_count != null ? Number(o.customer.orders_count) : null,
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
  if (existente && !reconnect && !req.body.validateOnly) {
    return res.status(409).json({ error: 'Essa loja já está conectada. Para trocar o token dela (ex.: novo Custom App), reconecte por cima.', canReconnect: true, storeId: existente.id });
  }
  let currency = 'BRL';
  try {
    const { data } = await shopifyFetch({ domain, token }, 'shop.json');
    currency = data.shop.currency;
  } catch (e) {
    return res.status(400).json({ error: explainShopifyError(e, domain) });
  }

  // botão "Validar": checa os tokens sem adicionar a loja
  if (req.body.validateOnly) {
    let sfOk = null, sfError = null;
    if (req.body.role === 'checkout' && req.body.storefrontToken) {
      const r = await validateAndSaveSfToken({ id: existente ? existente.id : 'validate', domain }, req.body.storefrontToken, { save: false });
      sfOk = r.ok; sfError = r.ok ? null : r.error;
    }
    return res.json({ ok: true, valid: true, currency, sfOk, sfError });
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

  // papel escolhido no assistente: 'vitrine' ou 'checkout' (padrão: checkout)
  const role = req.body.role === 'vitrine' ? 'vitrine' : 'checkout';
  try {
    await applyStoreRole(store.id, role);
  } catch { /* o painel funciona mesmo se o flow ainda não estiver configurado */ }

  // token Storefront colado já na conexão (checkout direto) — não-fatal
  let sfWarning = null;
  if (role === 'checkout' && req.body.storefrontToken) {
    try {
      const r = await validateAndSaveSfToken(store, req.body.storefrontToken);
      if (!r.ok) sfWarning = r.error;
    } catch (e) { sfWarning = e.message; }
  }

  res.json({ store: publicStore(store), sfWarning });
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
  const { f } = await ensureFlowConfig(); // para saber o papel (vitrine x checkout) de cada loja
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
      const role = r.store.id === f.vitrineId ? 'vitrine'
        : (f.pool.some((p) => p.id === r.store.id) ? 'checkout' : null);
      return {
        ...publicStore(r.store),
        role,
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
        // todas as variantes (id + preço) → para casar a variante do checkout pelo MESMO valor da vitrine
        variantList: variants.map((v) => ({
          id: v.id,
          price: parseFloat(v.price) || 0,
          available: (v.inventory_quantity ?? 1) > 0 || !v.inventory_management,
        })),
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
    // vitrine padrão = uma loja que NÃO foi marcada como checkout (não está no pool).
    // Assim, marcar lojas como checkout não faz nenhuma delas virar vitrine sozinha.
    const poolIds = new Set(Array.isArray(f.pool) ? f.pool.map((p) => p.id) : []);
    const cand = stores.find((s) => !poolIds.has(s.id));
    f.vitrineId = cand ? cand.id : null;
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

// define o papel de uma loja no Flow: 'vitrine' (a vitrine) ou 'checkout' (entra no pool)
async function applyStoreRole(storeId, role) {
  const { f } = await ensureFlowConfig();
  if (role === 'vitrine') {
    f.vitrineId = storeId;
    f.pool = f.pool.filter((p) => p.id !== storeId);            // vitrine não fica no pool
    if (f.state && f.state.activeId === storeId) {
      f.state = { activeId: f.pool[0] ? f.pool[0].id : null, activatedAt: new Date().toISOString() };
    }
  } else {
    if (f.vitrineId === storeId) f.vitrineId = null;            // era vitrine, virou checkout
    if (!f.pool.some((p) => p.id === storeId)) {
      f.pool.push({ id: storeId, limit: DEFAULT_LIMIT, dailyLimit: 0, paused: false, resetAt: null });
    }
    if (!f.state || !f.state.activeId) f.state = { activeId: storeId, activatedAt: new Date().toISOString() };
  }
  await saveFlowConfig(f);
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
  setInterval(async () => {
    try {
      const accounts = await loadAccounts();
      const namespaces = [...new Set(['', ...accounts.map((a) => a.ns || '')])];
      for (const ns of namespaces) {
        await db.runAsAccount(ns, async () => {
          await runPostPurchaseCycle().catch(() => {});
          await runCapiCycle().catch(() => {});
          await runEmailCycle(`http://localhost:${PORT}`).catch(() => {});
          await runCrmCycle().catch(() => {});
        });
      }
    } catch { /* próximo tick tenta de novo */ }
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
    // multi-contas: roda o ciclo de CADA ambiente (admin/legado + contas criadas)
    const accounts = await loadAccounts();
    const namespaces = [...new Set(['', ...accounts.map((a) => a.ns || '')])];
    const porConta = {};
    const baseUrl = appBaseUrl(req);
    for (const ns of namespaces) {
      porConta[ns || 'admin'] = await db.runAsAccount(ns, async () => {
        const r = await runPostPurchaseCycle().catch((e2) => ({ error: e2.message }));
        let tracking = null;
        try { tracking = await runCapiCycle(); } catch (e3) { tracking = { error: e3.message }; }
        let emails = null;
        try { emails = await runEmailCycle(baseUrl); } catch (e4) { emails = { error: e4.message }; }
        let crm = null;
        try { crm = await runCrmCycle(); } catch (e5) { crm = { error: e5.message }; }
        return { ...r, tracking, emails, crm };
      });
    }
    res.json({ ok: true, at: new Date().toISOString(), ...porConta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Tracking: Facebook Pixel/CAPI + Google Ads ----------
 *
 * O funil tem duas lojas: o anúncio cai na VITRINE, mas a COMPRA acontece na
 * loja de CHECKOUT — e script de tema não roda nas páginas de checkout.
 * Três peças fecham o ciclo:
 *  1. Vitrine  → o próprio /redirect.js injeta Pixel + gtag (PageView/ViewContent/
 *     InitiateCheckout) e o gclid/fbclid fica em cookie do domínio raiz, que o
 *     checkout (subdomínio) enxerga.
 *  2. Checkout → snippet de "pixel personalizado" (Customer Events) gerado na aba
 *     Tracking do painel, colado uma vez na loja de checkout: dispara Purchase (FB)
 *     e a conversão (Google Ads) no navegador, na hora da compra.
 *  3. Servidor → CAPI (Conversions API do Meta): cada pedido pago vai direto pro
 *     Meta mesmo com adblock, deduplicado com o navegador pelo event_id 'shp_<id>'.
 */

const TRACKING_DEFAULTS = { enabled: false, fbPixelId: '', fbCapiToken: '', gadsId: '', gadsLabel: '' };
const CAPI_LOOKBACK_DAYS = 6;   // o Meta só aceita eventos de até 7 dias
const CAPI_MAX_PER_STORE = 100; // trava de segurança por ciclo

async function loadTrackingConfig() {
  return { ...TRACKING_DEFAULTS, ...((await db.readDoc('tracking', {})) || {}) };
}
async function saveTrackingConfig(t) {
  return db.writeDoc('tracking', t);
}

const capiHash = (v) => crypto.createHash('sha256').update(v).digest('hex');
function capiField(v, digitsOnly) {
  v = String(v == null ? '' : v).trim().toLowerCase();
  if (digitsOnly) v = v.replace(/\D/g, '');
  return v ? [capiHash(v)] : undefined;
}

// pedidos pagos recentes com os campos que o evento Purchase precisa
async function fetchOrdersForCapi(store, since) {
  const params = new URLSearchParams({
    status: 'any',
    financial_status: 'paid',
    limit: '250',
    created_at_min: since.toISOString(),
    fields: 'id,created_at,total_price,currency,email,phone,test,cancelled_at,landing_site,client_details,billing_address',
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

// monta o evento Purchase (user_data com hash SHA-256, como o Meta exige)
function capiEventFromOrder(order, store) {
  const created = new Date(order.created_at);
  const b = order.billing_address || {};
  const cd = order.client_details || {};
  const ud = {
    em: capiField(order.email),
    ph: capiField(order.phone || b.phone, true),
    fn: capiField(b.first_name),
    ln: capiField(b.last_name),
    ct: capiField(String(b.city || '').replace(/\s+/g, '')),
    zp: capiField(b.zip, true),
    country: capiField(b.country_code),
    external_id: [capiHash(String(order.id))],
  };
  if (cd.browser_ip) ud.client_ip_address = cd.browser_ip;
  if (cd.user_agent) ud.client_user_agent = cd.user_agent;
  // o fbclid chega ao checkout pela URL (keepParams) e a Shopify guarda no landing_site
  try {
    const q = new URL(order.landing_site, `https://${store.domain}`).searchParams;
    const fbclid = q.get('fbclid');
    if (fbclid) ud.fbc = `fb.1.${created.getTime()}.${fbclid}`;
  } catch { /* sem landing_site utilizável */ }
  for (const k of Object.keys(ud)) if (ud[k] === undefined) delete ud[k];
  return {
    event_name: 'Purchase',
    event_time: Math.floor(created.getTime() / 1000),
    event_id: `shp_${order.id}`, // mesmo id do snippet do checkout → o Meta deduplica navegador × servidor
    action_source: 'website',
    event_source_url: `https://${store.domain}`,
    user_data: ud,
    custom_data: { currency: order.currency || 'BRL', value: Number(order.total_price || 0), order_id: String(order.id) },
  };
}

async function sendCapiBatch(t, events) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(t.fbPixelId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: events, access_token: t.fbCapiToken }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error((json.error && json.error.message) || `Meta respondeu ${res.status}`);
  }
  return json;
}

// um ciclo: pedidos pagos novos das lojas de checkout → Purchase via CAPI
async function runCapiCycle() {
  const t = await loadTrackingConfig();
  if (!t.enabled || !t.fbPixelId || !t.fbCapiToken) return { skipped: true, reason: 'CAPI não configurado (precisa de Pixel ID + token).' };
  let ctx;
  try { ctx = await ensureFlowConfig(); } catch { return { skipped: true, reason: 'Flow não configurado.' }; }

  const sent = (await db.readDoc('capi_sent', {})) || {};
  const cutoff = Date.now() - 30 * 86400000; // esquece marcações com mais de 30 dias
  for (const k of Object.keys(sent)) if (sent[k] < cutoff) delete sent[k];

  const since = new Date(Date.now() - CAPI_LOOKBACK_DAYS * 86400000);
  let enviados = 0;
  let jaEnviados = 0;
  const erros = [];
  for (const store of ctx.pool) {
    let orders = [];
    try { orders = await fetchOrdersForCapi(store, since); } catch (e) { erros.push(`${store.name}: ${e.message}`.slice(0, 140)); continue; }
    const novos = orders.filter((o) => !sent[`o${o.id}`]).slice(0, CAPI_MAX_PER_STORE);
    jaEnviados += orders.length - novos.length;
    if (!novos.length) continue;
    try {
      await sendCapiBatch(t, novos.map((o) => capiEventFromOrder(o, store)));
      for (const o of novos) sent[`o${o.id}`] = Date.now();
      enviados += novos.length;
    } catch (e) {
      erros.push(`${store.name}: ${e.message}`.slice(0, 160)); // não marca como enviado → tenta de novo no próximo ciclo
    }
  }
  await db.writeDoc('capi_sent', sent);
  const resumo = { at: new Date().toISOString(), enviados, jaEnviados, erros };
  const fresh = await loadTrackingConfig();
  fresh.lastCapiRun = resumo;
  await saveTrackingConfig(fresh);
  return resumo;
}

/* ---------- APIs do painel (aba Tracking) ---------- */

function publicTracking(t) {
  return {
    enabled: !!t.enabled,
    fbPixelId: t.fbPixelId || '',
    gadsId: t.gadsId || '',
    gadsLabel: t.gadsLabel || '',
    fbCapiTokenSet: !!t.fbCapiToken, // o token nunca volta pro navegador
  };
}

app.get('/api/tracking', async (req, res) => {
  try {
    const t = await loadTrackingConfig();
    res.json({ config: publicTracking(t), lastCapiRun: t.lastCapiRun || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tracking/config', async (req, res) => {
  try {
    const t = await loadTrackingConfig();
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') t.enabled = b.enabled;
    if (typeof b.fbPixelId === 'string') t.fbPixelId = b.fbPixelId.replace(/\D/g, '').slice(0, 20);
    if (typeof b.gadsId === 'string') {
      const g = b.gadsId.trim().toUpperCase().replace(/\s/g, '');
      t.gadsId = g ? `AW-${g.replace(/^AW-?/, '')}` : '';
    }
    if (typeof b.gadsLabel === 'string') t.gadsLabel = b.gadsLabel.trim();
    if (typeof b.fbCapiToken === 'string') t.fbCapiToken = b.fbCapiToken.trim(); // string vazia limpa o token
    await saveTrackingConfig(t);
    res.json({ ok: true, config: publicTracking(t) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tracking/capi/run', async (req, res) => {
  try { res.json({ ok: true, ...(await runCapiCycle()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
 * Operação: Custos & Lucro, Payouts, Rastreio próprio e Fila
 * (espelha o painel Vanelore, adaptado ao nosso multi-contas)
 * ============================================================ */

/* ---------- Custos & lucro (Dashboard: Lucro, Margem, ROAS) ---------- */

const COSTS_DEFAULTS = {
  productCost: 0,     // € por unidade vendida
  gatewayPct: 0,      // % sobre a receita
  extra1Name: '', extra1Value: 0, // custos fixos por pedido
  extra2Name: '', extra2Value: 0,
  adPeriods: [],      // [{ id, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', amount }] — sem rateio automático
};

async function loadCosts() {
  return { ...COSTS_DEFAULTS, ...((await db.readDoc('costs', {})) || {}) };
}

app.get('/api/costs', async (req, res) => {
  try { res.json(await loadCosts()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/costs', async (req, res) => {
  try {
    const b = req.body || {};
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const c = {
      productCost: num(b.productCost),
      gatewayPct: Math.min(100, num(b.gatewayPct)),
      extra1Name: String(b.extra1Name || '').slice(0, 40),
      extra1Value: num(b.extra1Value),
      extra2Name: String(b.extra2Name || '').slice(0, 40),
      extra2Value: num(b.extra2Value),
      adPeriods: (Array.isArray(b.adPeriods) ? b.adPeriods : []).slice(0, 200).map((p) => ({
        id: String(p.id || crypto.randomUUID()),
        start: String(p.start || '').slice(0, 10),
        end: String(p.end || '').slice(0, 10),
        amount: num(p.amount),
      })).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.start) && /^\d{4}-\d{2}-\d{2}$/.test(p.end)),
      savedAt: new Date().toISOString(),
    };
    await db.writeDoc('costs', c);
    res.json({ ok: true, costs: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Payouts (Shopify Payments, por loja de checkout) ---------- */

app.get('/api/payouts', async (req, res) => {
  try {
    const { pool } = await ensureFlowConfig();
    if (!pool.length) return res.json({ rows: [], stores: [] });
    const key = `payouts:${pool.map((s) => s.id).join(',')}`;
    const data = await cached(key, 60000, async () => {
      const rows = [];
      const storesStatus = [];
      for (const store of pool) {
        try {
          const { data: d } = await shopifyFetch(store, 'shopify_payments/payouts.json?limit=25');
          for (const p of d.payouts || []) {
            rows.push({
              storeId: store.id,
              storeName: store.name,
              date: p.date,
              amount: parseFloat(p.amount) || 0,
              currency: p.currency,
              status: p.status, // scheduled | in_transit | paid | failed | canceled
            });
          }
          storesStatus.push({ id: store.id, name: store.name, ok: true, payouts: (d.payouts || []).length });
        } catch (e) {
          const raw = String(e.message || e);
          const falta = /403|forbidden|scope|access denied/i.test(raw);
          storesStatus.push({
            id: store.id, name: store.name, ok: false,
            reason: falta ? 'Falta o escopo read_shopify_payments — adicione no app da loja e reautorize.' : raw.slice(0, 140),
          });
        }
      }
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return { rows: rows.slice(0, 100), stores: storesStatus };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Rastreio próprio (código TK-XXXXX + portal público) ----------
 * Igual ao sistema VL da Vanelore: o código é NOSSO, com linha do tempo que se
 * revela progressivamente ao cliente no portal /t/<código>. O código real da
 * transportadora é um registro COMPLEMENTAR, separado, por envio.
 */

const SHIPCFG_DEFAULTS = { prefix: 'TK', lang: 'en', brand: '' };
const SHIP_STEPS = [ // offsets em dias a partir da geração do código
  { id: 'confirmed', off: 0 },
  { id: 'preparing', off: 1 },
  { id: 'shipped', off: 3 },
  { id: 'intransit', off: 6 },
  { id: 'arrived', off: 10 },
  { id: 'outfordelivery', off: 12 },
  { id: 'delivered', off: 14 },
];

async function loadShipCfg() {
  return { ...SHIPCFG_DEFAULTS, ...((await db.readDoc('shipcfg', {})) || {}) };
}

app.get('/api/ship/config', async (req, res) => {
  try { res.json(await loadShipCfg()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ship/config', async (req, res) => {
  try {
    const b = req.body || {};
    const cfg = await loadShipCfg();
    if (typeof b.prefix === 'string') {
      const p = b.prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (p) cfg.prefix = p;
    }
    if (['pt', 'es', 'en', 'de'].includes(b.lang)) cfg.lang = b.lang;
    if (typeof b.brand === 'string') cfg.brand = b.brand.trim().slice(0, 40);
    await db.writeDoc('shipcfg', cfg);
    res.json({ ok: true, ...cfg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function genShipCode(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I — evita confusão no cliente
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[crypto.randomInt(chars.length)];
  return `${prefix}-${s}`;
}

function shipStatus(shipment, nowMs = Date.now()) {
  let last = SHIP_STEPS[0].id;
  for (const st of shipment.steps || []) if (new Date(st.revealAt).getTime() <= nowMs) last = st.id;
  return last;
}

// pedidos pagos recentes das lojas de checkout + envios já criados
app.get('/api/ship/overview', async (req, res) => {
  try {
    const cfg = await loadShipCfg();
    const shipments = (await db.readDoc('shipments', {})) || {};
    let prepare = [];
    try {
      const { pool } = await ensureFlowConfig();
      if (pool.length) {
        const from = new Date(Date.now() - 21 * 86400000);
        const results = await cached(`shipprep:${pool.map((s) => s.id).join(',')}`, 30000, () => collectOrders(pool, from, new Date()));
        const paid = results.flatMap((r) => r.orders.map((o) => ({ ...o, _domain: r.store.domain })));
        prepare = paid
          .filter((o) => (o.status === 'paid' || o.status === 'partially_refunded') && !shipments[`${o.storeId}:${o.orderId}`])
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((o) => ({
            storeId: o.storeId, storeName: o.storeName, orderId: o.orderId, number: o.number,
            customerName: o.customerName, email: o.email, total: o.total, currency: o.currency,
            createdAt: o.createdAt, items: o.items, adminUrl: `https://${o._domain}/admin/orders/${o.orderId}`,
          }));
      }
    } catch { /* sem flow configurado ainda */ }
    const lista = Object.values(shipments).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((s) => ({ ...s, status: shipStatus(s) }));
    res.json({ cfg, prepare: prepare.slice(0, 200), shipments: lista.slice(0, 300) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "Gerar rastreio": cria o código + linha do tempo (e-mail entra quando o Resend estiver ligado)
app.post('/api/ship/create', async (req, res) => {
  try {
    const { storeId, orderId } = req.body || {};
    if (!storeId || !orderId) return res.status(400).json({ error: 'Pedido inválido.' });
    const key = `${storeId}:${orderId}`;
    const shipments = (await db.readDoc('shipments', {})) || {};
    if (shipments[key]) return res.json({ ok: true, shipment: shipments[key], existed: true });

    const { pool } = await ensureFlowConfig();
    const store = pool.find((s) => s.id === storeId);
    if (!store) return res.status(404).json({ error: 'Loja não encontrada no pool.' });
    const from = new Date(Date.now() - 45 * 86400000);
    const results = await collectOrders([store], from, new Date());
    const order = results.flatMap((r) => r.orders).find((o) => String(o.orderId) === String(orderId));
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado (últimos 45 dias).' });

    const cfg = await loadShipCfg();
    let code = genShipCode(cfg.prefix);
    const idx = (await db.readDocGlobal('ship_index', {})) || {};
    while (idx[code]) code = genShipCode(cfg.prefix); // garante unicidade global
    const now = Date.now();
    const shipment = {
      key, code,
      storeId, storeName: order.storeName,
      orderId: String(orderId), number: order.number,
      customerName: order.customerName || null, email: order.email || null,
      total: order.total, currency: order.currency,
      items: order.items, addr: order.addr || null,
      createdAt: new Date(now).toISOString(),
      steps: SHIP_STEPS.map((st) => ({ id: st.id, revealAt: new Date(now + st.off * 86400000).toISOString() })),
      carrier: null, carrierIntl: null, carrierLocal: null,
      emailStatus: 'pendente', // muda quando o Resend estiver configurado
    };
    shipments[key] = shipment;
    await db.writeDoc('shipments', shipments);
    idx[code] = { ns: db.currentNs(), key };
    await db.writeDocGlobal('ship_index', idx);
    res.json({ ok: true, shipment: { ...shipment, status: shipStatus(shipment) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// registra o código real do fornecedor/transportadora (fluxo complementar)
app.post('/api/ship/update', async (req, res) => {
  try {
    const { key, carrier, carrierIntl, carrierLocal } = req.body || {};
    const shipments = (await db.readDoc('shipments', {})) || {};
    const s = shipments[key];
    if (!s) return res.status(404).json({ error: 'Envio não encontrado.' });
    if (carrier !== undefined) s.carrier = String(carrier || '').slice(0, 60) || null;
    if (carrierIntl !== undefined) s.carrierIntl = String(carrierIntl || '').slice(0, 60) || null;
    if (carrierLocal !== undefined) s.carrierLocal = String(carrierLocal || '').slice(0, 60) || null;
    await db.writeDoc('shipments', shipments);
    res.json({ ok: true, shipment: { ...s, status: shipStatus(s) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- portal público de rastreio: /t/<código> ---------- */

const SHIP_I18N = {
  en: {
    title: 'Track your order', code: 'Tracking code', next: 'Next step', expected: 'expected',
    carrier: 'Carrier', intl: 'International code', local: 'Local delivery code',
    items: 'Items', notfound: 'Tracking code not found.', notfoundHint: 'Check the code in your email and try again.',
    updated: 'Timeline updates automatically as your delivery progresses.',
    steps: { confirmed: 'Order confirmed', preparing: 'Preparing your package', shipped: 'Shipped', intransit: 'In transit', arrived: 'Arrived in destination country', outfordelivery: 'Out for delivery', delivered: 'Delivered' },
    land: {
      title: 'Track your order', sub: 'Follow your delivery in real time, wherever it is.', btn: 'Track',
      privT: 'Prefer private access by email', privB: 'Your shipping confirmation email contains a private link that opens your tracking directly, no code needed. That access is yours only — please do not share it.',
      faqT: 'Frequently asked questions', back: 'Back to store',
      faq: [
        ['When do I receive my tracking code?', 'As soon as your shipment is confirmed you receive an email with your code and a private tracking link — usually within 1–3 business days after payment.'],
        ['The tracking is not updating — what should I do?', 'The timeline updates automatically as your delivery progresses. A few days without news between steps is normal for international shipping.'],
        ['How long does delivery take?', 'The expected date of the next step is shown right on your tracking page. Most deliveries are completed within about 2 weeks.'],
        ['Can I change the delivery address?', 'Reply to your order confirmation email as soon as possible. If the package has not left yet, our team will update it for you.'],
      ],
    },
  },
  pt: {
    title: 'Acompanhe seu pedido', code: 'Código de rastreio', next: 'Próxima etapa', expected: 'previsto',
    carrier: 'Transportadora', intl: 'Código internacional', local: 'Código de entrega local',
    items: 'Itens', notfound: 'Código de rastreio não encontrado.', notfoundHint: 'Confira o código no seu e-mail e tente de novo.',
    updated: 'A linha do tempo atualiza sozinha conforme a entrega avança.',
    steps: { confirmed: 'Pedido confirmado', preparing: 'Preparando seu pacote', shipped: 'Enviado', intransit: 'Em trânsito', arrived: 'Chegou ao país de destino', outfordelivery: 'Saiu para entrega', delivered: 'Entregue' },
    land: {
      title: 'Rastreie seu pedido', sub: 'Acompanhe sua entrega em tempo real, onde estiver.', btn: 'Rastrear',
      privT: 'Preferir acesso privado por e-mail', privB: 'No e-mail de confirmação de envio você recebe um link privado que abre seu rastreio direto, sem digitar código. Esse acesso é só seu — não compartilhe.',
      faqT: 'Perguntas frequentes', back: 'Voltar à loja',
      faq: [
        ['Quando recebo meu código de rastreio?', 'Assim que o envio é confirmado, você recebe um e-mail com o código e um link privado de acompanhamento — normalmente em 1 a 3 dias úteis após o pagamento.'],
        ['O rastreio não atualiza — o que faço?', 'A linha do tempo atualiza sozinha conforme a entrega avança. Ficar alguns dias sem novidade entre etapas é normal em envios internacionais.'],
        ['Quanto tempo demora a entrega?', 'A data prevista da próxima etapa aparece na própria página de rastreio. Na maioria dos casos a entrega é concluída em cerca de 2 semanas.'],
        ['Posso alterar o endereço de entrega?', 'Responda o e-mail de confirmação do pedido o quanto antes. Se o pacote ainda não saiu, nossa equipe altera pra você.'],
      ],
    },
  },
  es: {
    title: 'Sigue tu pedido', code: 'Código de seguimiento', next: 'Próximo paso', expected: 'previsto',
    carrier: 'Transportista', intl: 'Código internacional', local: 'Código de entrega local',
    items: 'Artículos', notfound: 'Código de seguimiento no encontrado.', notfoundHint: 'Verifica el código en tu correo e inténtalo de nuevo.',
    updated: 'La línea de tiempo se actualiza automáticamente a medida que avanza tu entrega.',
    steps: { confirmed: 'Pedido confirmado', preparing: 'Preparando tu paquete', shipped: 'Enviado', intransit: 'En tránsito', arrived: 'Llegó al país de destino', outfordelivery: 'En reparto', delivered: 'Entregado' },
    land: {
      title: 'Sigue tu pedido', sub: 'Sigue tu entrega en tiempo real, estés donde estés.', btn: 'Rastrear',
      privT: 'Prefiero el acceso privado por correo', privB: 'En el correo de confirmación de envío recibes un enlace privado que abre tu seguimiento directamente, sin escribir el código. Ese acceso es solo tuyo — no lo compartas.',
      faqT: 'Preguntas frecuentes', back: 'Volver a la tienda',
      faq: [
        ['¿Cuándo recibo mi código de seguimiento?', 'En cuanto se confirma el envío recibes un correo con tu código y un enlace privado de seguimiento — normalmente entre 1 y 3 días hábiles después del pago.'],
        ['El seguimiento no se actualiza, ¿qué hago?', 'La línea de tiempo se actualiza automáticamente a medida que avanza tu entrega. Pasar unos días sin novedades entre etapas es normal en envíos internacionales.'],
        ['¿Cuánto tarda la entrega?', 'La fecha prevista del próximo paso aparece en tu página de seguimiento. La mayoría de las entregas se completan en unas 2 semanas.'],
        ['¿Puedo cambiar la dirección de entrega?', 'Responde al correo de confirmación del pedido lo antes posible. Si el paquete aún no salió, nuestro equipo la cambia por ti.'],
      ],
    },
  },
  de: {
    title: 'Sendung verfolgen', code: 'Sendungsnummer', next: 'Nächster Schritt', expected: 'voraussichtlich',
    carrier: 'Versanddienst', intl: 'Internationale Nummer', local: 'Lokale Zustellnummer',
    items: 'Artikel', notfound: 'Sendungsnummer nicht gefunden.', notfoundHint: 'Prüfen Sie den Code in Ihrer E-Mail und versuchen Sie es erneut.',
    updated: 'Die Zeitleiste aktualisiert sich automatisch mit dem Fortschritt Ihrer Lieferung.',
    steps: { confirmed: 'Bestellung bestätigt', preparing: 'Paket wird vorbereitet', shipped: 'Versendet', intransit: 'Unterwegs', arrived: 'Im Zielland angekommen', outfordelivery: 'In Zustellung', delivered: 'Zugestellt' },
    land: {
      title: 'Sendung verfolgen', sub: 'Verfolgen Sie Ihre Lieferung in Echtzeit, wo immer sie ist.', btn: 'Verfolgen',
      privT: 'Privaten Zugang per E-Mail bevorzugen', privB: 'In der Versandbestätigung erhalten Sie einen privaten Link, der Ihre Sendungsverfolgung direkt öffnet — ganz ohne Code. Dieser Zugang gehört nur Ihnen, bitte nicht teilen.',
      faqT: 'Häufige Fragen', back: 'Zurück zum Shop',
      faq: [
        ['Wann erhalte ich meine Sendungsnummer?', 'Sobald der Versand bestätigt ist, erhalten Sie eine E-Mail mit Ihrem Code und einem privaten Link — in der Regel 1–3 Werktage nach der Zahlung.'],
        ['Das Tracking aktualisiert sich nicht — was tun?', 'Die Zeitleiste aktualisiert sich automatisch mit dem Fortschritt. Einige Tage ohne Neuigkeiten zwischen den Schritten sind bei internationalen Sendungen normal.'],
        ['Wie lange dauert die Lieferung?', 'Das voraussichtliche Datum des nächsten Schritts sehen Sie direkt auf Ihrer Tracking-Seite. Die meisten Lieferungen sind in etwa 2 Wochen abgeschlossen.'],
        ['Kann ich die Lieferadresse ändern?', 'Antworten Sie so schnell wie möglich auf Ihre Bestellbestätigung. Ist das Paket noch nicht unterwegs, ändert unser Team die Adresse für Sie.'],
      ],
    },
  },
};

const shipEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// tema escuro premium compartilhado pela busca (/t) e pelo portal (/t/<código>)
function shipShellHtml({ lang, title, brand, backUrl, backLabel, langSwitch, body }) {
  const e = shipEsc;
  return `<!doctype html><html lang="${e(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${e(title)}</title><meta name="robots" content="noindex">
  <style>
    :root{color-scheme:dark}
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:#0d0b08;color:#e9e2d4;min-height:100vh}
    body::before{content:'';position:fixed;inset:0;background:radial-gradient(700px 360px at 50% -80px,rgba(200,169,100,.10),transparent 70%);pointer-events:none}
    a{color:#c8a964;text-decoration:none}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 22px;border-bottom:1px solid rgba(200,169,100,.16);position:relative}
    .brand{font-family:Georgia,'Times New Roman',serif;font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:#f2ebdc;white-space:nowrap}
    .topr{display:flex;align-items:center;gap:14px;font-size:12.5px}
    .langs{display:flex;gap:2px;border:1px solid rgba(200,169,100,.25);border-radius:999px;padding:3px}
    .langs a{padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.06em;color:#b7a98b}
    .langs a.on{background:rgba(200,169,100,.18);color:#ecdfc0}
    .wrap{max-width:640px;margin:0 auto;padding:40px 20px 70px;position:relative}
    h1{font-family:Georgia,'Times New Roman',serif;font-weight:400;color:#ecdcae;margin:0}
    .foot{text-align:center;font-size:11.5px;color:#6d644f;padding:26px 20px 34px}
  </style></head><body>
  <div class="top">
    <div class="brand">${e(brand || title)}</div>
    <div class="topr">${langSwitch || ''}${backUrl ? `<a href="${e(backUrl)}">${e(backLabel || '')} →</a>` : ''}</div>
  </div>
  <div class="wrap">${body}</div>
  <div class="foot">${e(brand || '')}</div>
  </body></html>`;
}

// página pública de busca: o cliente digita o código e cai no portal
function shipLandingHtml(t, { brand, prefix, lang, shop }) {
  const e = shipEsc;
  const L = t.land;
  const qs = (l) => `/t?${new URLSearchParams({ ...(shop ? { shop } : {}), lang: l })}`;
  const langSwitch = `<div class="langs">${['pt', 'en', 'es', 'de'].map((l) => `<a class="${l === lang ? 'on' : ''}" href="${e(qs(l))}">${l.toUpperCase()}</a>`).join('')}</div>`;
  const body = `
  <style>
    .hero{text-align:center;padding:22px 0 8px}
    .ic{width:76px;height:76px;border-radius:50%;border:1px solid rgba(200,169,100,.45);display:inline-flex;align-items:center;justify-content:center;margin-bottom:22px;background:rgba(200,169,100,.06)}
    .hero h1{font-size:clamp(30px,6vw,42px)}
    .hero p{color:#b3a583;font-size:15px;margin:12px auto 0;max-width:420px;line-height:1.6}
    form{display:flex;gap:10px;margin:30px 0 18px}
    input{flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(200,169,100,.30);border-radius:10px;padding:14px 16px 14px 42px;font-family:Consolas,'Courier New',monospace;font-size:15px;letter-spacing:2px;color:#f2ebdc;outline:none;min-width:0}
    input::placeholder{color:#6d644f;letter-spacing:2px}
    input:focus{border-color:rgba(200,169,100,.65);box-shadow:0 0 0 3px rgba(200,169,100,.12)}
    .searchbox{position:relative;flex:1;display:flex}
    .searchbox svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);opacity:.55}
    button{background:linear-gradient(160deg,#b4934f,#8f7134);border:1px solid rgba(255,230,170,.35);color:#14100a;font-weight:700;font-size:14px;letter-spacing:.03em;padding:14px 26px;border-radius:10px;cursor:pointer}
    button:hover{filter:brightness(1.1)}
    .priv{border:1px dashed rgba(200,169,100,.35);border-radius:10px;margin:0 0 34px}
    .priv summary{cursor:pointer;list-style:none;padding:13px 16px;color:#cfae6b;font-size:13.5px;font-weight:600}
    .priv summary::before{content:'▸ ';font-size:11px}
    .priv[open] summary::before{content:'▾ '}
    .priv p{margin:0;padding:0 16px 14px;color:#b3a583;font-size:13.5px;line-height:1.7}
    .faq{border-top:1px solid rgba(200,169,100,.18);padding-top:26px}
    .faq h2{font-family:Georgia,serif;font-weight:400;font-size:21px;color:#eee3c8;margin:0 0 6px}
    .faq details{border-bottom:1px solid rgba(255,255,255,.07)}
    .faq summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 2px;font-size:14.5px;font-weight:600;color:#e9e2d4}
    .faq summary::after{content:'▾';color:#c8a964;font-size:12px;transition:transform .15s}
    .faq details[open] summary::after{transform:rotate(180deg)}
    .faq p{margin:0;padding:0 2px 16px;color:#b3a583;font-size:13.5px;line-height:1.75}
  </style>
  <div class="hero">
    <div class="ic"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#c8a964" stroke-width="1.4"><path d="M21 8.5v7a1 1 0 0 1-.55.9l-8 4.2a1 1 0 0 1-.9 0l-8-4.2a1 1 0 0 1-.55-.9v-7a1 1 0 0 1 .55-.9l8-4.2a1 1 0 0 1 .9 0l8 4.2a1 1 0 0 1 .55.9Z"/><path d="M3.3 7.6 12 12l8.7-4.4M12 12v9"/></svg></div>
    <h1>${e(L.title)}</h1>
    <p>${e(L.sub)}</p>
  </div>
  <form onsubmit="var v=this.code.value.toUpperCase().replace(/[^A-Z0-9-]/g,'');if(v){location.href='/t/'+encodeURIComponent(v)}return false">
    <span class="searchbox">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c8a964" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input name="code" placeholder="${e(prefix || 'TK')}-XXXXX" autocomplete="off" autocapitalize="characters" spellcheck="false">
    </span>
    <button type="submit">${e(L.btn)}</button>
  </form>
  <details class="priv"><summary>${e(L.privT)}</summary><p>${e(L.privB)}</p></details>
  <div class="faq">
    <h2>${e(L.faqT)}</h2>
    ${L.faq.map(([q, a]) => `<details><summary>${e(q)}</summary><p>${e(a)}</p></details>`).join('')}
  </div>`;
  return shipShellHtml({ lang, title: L.title, brand, backUrl: shop ? `https://${shop}` : null, backLabel: L.back, langSwitch, body });
}

function shipPortalHtml(t, shipment, lang, brand) {
  const e = shipEsc;
  const back = `<a href="/t">← ${e(t.land ? t.land.title : '')}</a>`;
  const cardOpen = `
  <style>
    .card{background:rgba(255,255,255,.03);border:1px solid rgba(200,169,100,.22);border-radius:16px;padding:28px 26px;margin-top:10px}
    .card h1{font-size:24px;margin:0 0 4px}
    .sub{color:#b3a583;font-size:13px;margin:0 0 20px}
    .code{display:inline-block;border:1px solid rgba(200,169,100,.45);border-radius:10px;padding:9px 16px;font-family:Consolas,monospace;font-weight:700;letter-spacing:3px;font-size:16px;color:#ecdcae;margin-bottom:24px}
    .tl{list-style:none;margin:0;padding:0}
    .tl li{position:relative;padding:0 0 26px 36px}
    .tl li:last-child{padding-bottom:0}
    .tl li::before{content:'';position:absolute;left:10px;top:22px;bottom:-2px;width:1px;background:rgba(200,169,100,.28)}
    .tl li:last-child::before{display:none}
    .dot{position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#c8a964;display:flex;align-items:center;justify-content:center;color:#14100a;font-size:11px;font-weight:800}
    .next .dot{background:transparent;border:1px solid rgba(200,169,100,.5);width:16px;height:16px}
    .next .lbl{color:#b3a583}
    .lbl{font-weight:650;font-size:14.5px;color:#e9e2d4} .when{font-size:12px;color:#8d8169;margin-top:2px}
    .meta{margin-top:24px;border-top:1px solid rgba(200,169,100,.18);padding-top:16px;font-size:13px;color:#c5b89a;line-height:1.8}
    .meta strong{color:#e9e2d4}
    .meta code{color:#ecdcae}
    .note{font-size:12px;color:#8d8169;margin-top:16px;text-align:center}
  </style><div class="card">`;
  if (!shipment) {
    const body = `${cardOpen}<h1>${e(t.title)}</h1><p class="sub">${e(t.notfound)}</p><p style="font-size:13px;color:#b3a583;margin:0">${e(t.notfoundHint)}</p></div><p class="note">${back}</p>`;
    return shipShellHtml({ lang, title: t.title, brand, body });
  }
  const now = Date.now();
  const done = (shipment.steps || []).filter((s) => new Date(s.revealAt).getTime() <= now);
  const nextStep = (shipment.steps || []).find((s) => new Date(s.revealAt).getTime() > now);
  const fmtD = (iso) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : lang, { day: 'numeric', month: 'short' });
  let tl = done.map((s) => `<li><span class="dot">✓</span><div class="lbl">${e(t.steps[s.id] || s.id)}</div><div class="when">${fmtD(s.revealAt)}</div></li>`).join('');
  if (nextStep) {
    tl += `<li class="next"><span class="dot"></span><div class="lbl">${e(t.steps[nextStep.id] || nextStep.id)}</div><div class="when">${e(t.expected)} · ${fmtD(nextStep.revealAt)}</div></li>`;
  }
  const itens = (shipment.items || []).map((it) => `${it.qty}× ${e(it.title)}`).join(' · ');
  const metaRows = [
    itens ? `<div><strong>${e(t.items)}:</strong> ${itens}</div>` : '',
    shipment.carrier ? `<div><strong>${e(t.carrier)}:</strong> ${e(shipment.carrier)}</div>` : '',
    shipment.carrierIntl ? `<div><strong>${e(t.intl)}:</strong> <code>${e(shipment.carrierIntl)}</code></div>` : '',
    shipment.carrierLocal ? `<div><strong>${e(t.local)}:</strong> <code>${e(shipment.carrierLocal)}</code></div>` : '',
  ].join('');
  const body = `${cardOpen}<h1>${e(t.title)}</h1><p class="sub">${e(t.code)}</p>
    <div class="code">${e(shipment.code)}</div>
    <ul class="tl">${tl}</ul>
    ${metaRows ? `<div class="meta">${metaRows}</div>` : ''}
    </div><p class="note">${e(t.updated)}</p>`;
  return shipShellHtml({ lang, title: t.title, brand, body });
}

// página de busca de rastreio: /t (opcional ?shop=<domínio> pra marca/idioma da conta)
app.get('/t', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const shop = String(req.query.shop || '').trim().toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 80) || null;
    const ns = shop ? await shopNsLookup(shop).catch(() => '') : '';
    let cfg = SHIPCFG_DEFAULTS;
    await db.runAsAccount(ns || '', async () => { cfg = await loadShipCfg(); });
    const lang = ['pt', 'es', 'en', 'de'].includes(req.query.lang) ? req.query.lang : (cfg.lang || 'en');
    const t = SHIP_I18N[lang] || SHIP_I18N.en;
    res.type('html').send(shipLandingHtml(t, { brand: cfg.brand || '', prefix: cfg.prefix || 'TK', lang, shop }));
  } catch {
    res.type('html').status(500).send('<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:40px">Erro ao carregar a página de rastreio.</p>');
  }
});

app.get('/t/:code', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const code = String(req.params.code || '').toUpperCase().trim();
    const idx = (await db.readDocGlobal('ship_index', {})) || {};
    const hit = idx[code];
    let shipment = null;
    let lang = 'en';
    let brand = '';
    if (hit) {
      await db.runAsAccount(hit.ns || '', async () => {
        const shipments = (await db.readDoc('shipments', {})) || {};
        shipment = shipments[hit.key] || null;
        const cfg = await loadShipCfg();
        lang = cfg.lang || 'en';
        brand = cfg.brand || '';
      });
    }
    const t = SHIP_I18N[lang] || SHIP_I18N.en;
    res.type('html').send(shipPortalHtml(t, shipment, lang, brand));
  } catch {
    res.type('html').status(500).send('<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:40px">Erro ao carregar o rastreio.</p>');
  }
});

/* ---------- Fila de processamento (tarefas + retry) ---------- */

app.get('/api/queue', async (req, res) => {
  try {
    const rows = [];
    const t = await loadTrackingConfig();
    if (t.lastCapiRun) {
      const r = t.lastCapiRun;
      rows.push({
        task: 'CAPI — Purchase pro Meta', kind: 'capi',
        status: (r.erros && r.erros.length) ? 'falhou' : 'ok',
        detail: (r.erros && r.erros[0]) || `${r.enviados || 0} enviado(s), ${r.jaEnviados || 0} já marcados`,
        at: r.at,
      });
    }
    const pp = await loadPP();
    const falhas = (pp.executions || []).filter((e) => e.status === 'failed').length;
    if (pp.enabled) {
      rows.push({
        task: 'Pós-compra digital', kind: 'postpurchase',
        status: falhas ? 'falhou' : 'ok',
        detail: falhas ? `${falhas} execução(ões) com falha` : `${(pp.executions || []).length} execuções registradas`,
        at: pp.startAt,
      });
    }
    // os erros de sync de payouts entram pelo próprio /api/payouts (o front junta as duas fontes)
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/queue/retry', async (req, res) => {
  try {
    const kind = String((req.body || {}).kind || '');
    if (kind === 'capi') return res.json({ ok: true, result: await runCapiCycle() });
    if (kind === 'postpurchase') return res.json({ ok: true, result: await runPostPurchaseCycle() });
    if (kind === 'payouts') { cache.clear(); return res.json({ ok: true, result: 'cache limpo — recarregue os payouts' }); }
    res.status(400).json({ error: 'Tarefa desconhecida.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
 * E-mails transacionais (Resend), CRM de recuperação e Suporte
 * ============================================================ */

const EMAILCFG_DEFAULTS = {
  apiKey: '',            // chave do Resend (criptografada no banco)
  fromEmail: '',         // ex.: orders@seudominio.com
  fromName: '',          // nome exibido no remetente
  replyTo: '',           // ex.: help@seudominio.com
  logoUrl: '',           // logo da loja exibida na faixa do topo dos e-mails
  lang: 'en',            // idioma padrão dos e-mails
  automations: { orderCreated: false, paymentApproved: false, shipping: false, delivery: false, abandoned: false },
  antiDup: false,        // "conferi o que a Shopify ainda envia" (trava anti-duplicação)
  // cupons da recuperação (crie códigos iguais na Shopify): c1 = 4º e-mail, c2 = 5º (final)
  coupons: { c1: { code: '', pct: 10 }, c2: { code: '', pct: 15 } },
  // sequência de recuperação: atrasos em minutos dos 5 e-mails + extras honestos
  crm: {
    delaysMin: [60, 1440, 2880, 4320, 5760], // 1h, 24h, 48h, 72h, 96h
    guaranteeDays: 0,   // "garantia de X dias" — só aparece no e-mail 3 se > 0
    socialProof: '',    // ex.: "+1.200 clientes atendidos" — só aparece no e-mail 2 se preenchido
  },
};

async function loadEmailCfg() {
  const raw = { ...EMAILCFG_DEFAULTS, ...((await db.readDoc('emailcfg', {})) || {}) };
  try { raw.apiKey = raw.apiKey ? db.decrypt(raw.apiKey) : ''; } catch { raw.apiKey = ''; }
  raw.automations = { ...EMAILCFG_DEFAULTS.automations, ...(raw.automations || {}) };
  raw.coupons = {
    c1: { ...EMAILCFG_DEFAULTS.coupons.c1, ...((raw.coupons || {}).c1 || {}) },
    c2: { ...EMAILCFG_DEFAULTS.coupons.c2, ...((raw.coupons || {}).c2 || {}) },
  };
  raw.crm = { ...EMAILCFG_DEFAULTS.crm, ...(raw.crm || {}) };
  if (!Array.isArray(raw.crm.delaysMin) || raw.crm.delaysMin.length !== 5) raw.crm.delaysMin = [...EMAILCFG_DEFAULTS.crm.delaysMin];
  return raw;
}

async function saveEmailCfg(cfg) {
  return db.writeDoc('emailcfg', { ...cfg, apiKey: cfg.apiKey ? db.encrypt(cfg.apiKey) : '' });
}

const emailReady = (cfg) => !!(cfg.apiKey && cfg.fromEmail);

/* textos dos e-mails em 4 idiomas — {p} nos textos vira o nome do produto em negrito */
const MAIL_I18N = {
  en: {
    greet: (n) => n ? `Hi, ${n}!` : 'Hi!',
    labels: {
      summary: 'Order summary', total: 'Total', address: 'Delivery address',
      est: (d) => `Estimated delivery by ${d}`, reason: (site) => `You received this email because you started an order at ${site}.`,
      privacy: 'This access is private. Please do not share the tracking link.',
      shipSoon: 'We will send you the tracking link as soon as your order leaves the shipping center.',
      yourItems: 'your items',
    },
    order_created: { icon: 'check', t: 'We received your order!', s: (o) => `We received your order ${o.number}`, b: 'Your order is waiting for payment confirmation — we will let you know as soon as it is approved.' },
    payment_approved: { icon: 'check', t: 'Thank you for your purchase!', s: (o) => `Payment confirmed — order ${o.number}`, b: 'We received your order and it is already being prepared.' },
    ship_created: { icon: 'box', t: 'Your order has been shipped!', s: (o) => `Your tracking code for order ${o.number}`, b: 'It is already on its way.', cta: () => 'Track my order →', codeLabel: 'Tracking code' },
    ship_step: { icon: 'box', t: 'Delivery update', s: (o, step) => `Delivery update — ${step}`, b: 'Your delivery just moved forward. Current status:', cta: () => 'See full timeline →', codeLabel: 'Tracking code' },
    abandoned_1: {
      s: () => 'Your order is saved',
      paras: () => ['We saw you started your order of {p} but did not get to finish it. No worries: we saved everything just the way you left it.', 'Only one step left. Click below and pick up exactly where you were — no need to fill anything in again.', 'If you had any trouble with the payment or the page, reply to this email and we will help you right away.'],
      cta: () => 'Complete my order',
    },
    abandoned_2: { lead: 'Forgot something? 🛒', s: () => 'Forgot something? 🛒', paras: (d) => ['Your order of {p} is still waiting for you. Complete it now before it sells out.'].concat(d.social ? [`You are in good company: ${d.social}.`] : []), cta: () => 'Complete my order' },
    abandoned_3: { lead: 'Questions? We are here to help 💬', s: () => 'Questions? We are here to help', paras: (d) => ['If you had any problem completing your purchase of {p}, just reply to this email. Our team answers within minutes.'].concat(d.guarantee ? [`And your purchase is protected: ${d.guarantee}-day guarantee.`] : []), cta: () => 'Complete my order' },
    abandoned_4: {
      s: (d) => d && d.coupon ? `${d.coupon.pct}% off your order — today only` : 'Your cart expires soon',
      paras: (d) => d.coupon
        ? ['Let us be direct: we want {p} to reach you. So we prepared something:', `${d.coupon.pct}% off with the code below — valid only until ${d.until}.`, 'After that the code stops working and the order goes back to full price. Not a marketing line: the system disables it automatically.', 'Apply it at checkout — your cart is still saved just as you left it.']
        : ['Your cart will be released soon. Complete your order now to keep {p}.'],
      cta: (d) => d.coupon ? `Use my ${d.coupon.pct}% off` : 'Finish now',
    },
    abandoned_5: {
      s: (d) => d && d.coupon ? `Our best discount — ${d.coupon.pct}% off` : 'Last email about your order',
      paras: (d) => d.coupon
        ? ['This is the last email we send about your order — we promise.', 'Before closing your cart, here is our best discount:', `${d.coupon.pct}% OFF with the code below — valid until ${d.until}. It is the biggest discount we offer.`, 'If you decide it is not for you, that is fine — we will not write about this order again.']
        : ['This is the last email we send about your order — we promise.', 'Your cart will be released soon. If you decide it is not for you, that is fine — we will not write again.'],
      cta: (d) => d.coupon ? `Get the ${d.coupon.pct}% off` : 'Complete my order',
    },
  },
  pt: {
    greet: (n) => n ? `Olá, ${n}!` : 'Olá!',
    labels: {
      summary: 'Resumo do pedido', total: 'Total', address: 'Endereço de entrega',
      est: (d) => `Entrega estimada até ${d}`, reason: (site) => `Você recebeu este e-mail porque iniciou um pedido em ${site}.`,
      privacy: 'Este acesso é privado. Não compartilhe o link de acompanhamento.',
      shipSoon: 'Enviaremos o link de rastreio assim que seu pedido sair do centro de envios.',
      yourItems: 'seus itens',
    },
    order_created: { icon: 'check', t: 'Recebemos seu pedido!', s: (o) => `Recebemos seu pedido ${o.number}`, b: 'Seu pedido está aguardando a confirmação do pagamento — avisamos assim que aprovar.' },
    payment_approved: { icon: 'check', t: 'Obrigado pela sua compra!', s: (o) => `Pagamento confirmado — pedido ${o.number}`, b: 'Recebemos seu pedido e ele já está em preparação.' },
    ship_created: { icon: 'box', t: 'Seu pedido foi despachado!', s: (o) => `Seu código de rastreio do pedido ${o.number}`, b: 'Ele já está a caminho.', cta: () => 'Seguir meu pedido →', codeLabel: 'Código de rastreio' },
    ship_step: { icon: 'box', t: 'Atualização da entrega', s: (o, step) => `Atualização da entrega — ${step}`, b: 'Sua entrega acabou de avançar. Situação atual:', cta: () => 'Ver linha do tempo →', codeLabel: 'Código de rastreio' },
    abandoned_1: {
      s: () => 'Seu pedido ficou guardado',
      paras: () => ['Vimos que você começou seu pedido de {p}, mas não chegou a concluir. Tranquilo: guardamos tudo do jeitinho que você deixou.', 'Só falta um passo. Clique abaixo e retome exatamente de onde parou — não precisa preencher nada de novo.', 'Se teve qualquer problema com o pagamento ou com a página, responda este e-mail que te ajudamos na hora.'],
      cta: () => 'Completar meu pedido',
    },
    abandoned_2: { lead: 'Esqueceu algo? 🛒', s: () => 'Esqueceu algo? 🛒', paras: (d) => ['Seu pedido de {p} ainda está te esperando. Conclua agora antes que esgote.'].concat(d.social ? [`Você está em boa companhia: ${d.social}.`] : []), cta: () => 'Completar meu pedido' },
    abandoned_3: { lead: 'Dúvidas? Estamos aqui pra ajudar 💬', s: () => 'Dúvidas? Estamos aqui pra ajudar', paras: (d) => ['Se você teve algum problema ao concluir sua compra de {p}, é só responder este e-mail. Nossa equipe responde em minutos.'].concat(d.guarantee ? [`E você compra protegido: garantia de ${d.guarantee} dias.`] : []), cta: () => 'Completar meu pedido' },
    abandoned_4: {
      s: (d) => d && d.coupon ? `${d.coupon.pct}% de desconto no seu pedido — só hoje` : 'Seu carrinho expira em breve',
      paras: (d) => d.coupon
        ? ['Vamos ser diretos: queremos que {p} chegue até você. Então preparamos algo:', `${d.coupon.pct}% de desconto com o código abaixo — válido somente até ${d.until}.`, 'Depois disso o código deixa de funcionar e o pedido volta ao preço normal. Não é frase de marketing: o sistema desativa sozinho.', 'Aplique no checkout — seu carrinho continua guardado como você deixou.']
        : ['Seu carrinho será liberado em breve. Conclua agora pra garantir {p}.'],
      cta: (d) => d.coupon ? `Usar meu ${d.coupon.pct}% OFF` : 'Finalizar agora',
    },
    abandoned_5: {
      s: (d) => d && d.coupon ? `Nosso melhor desconto — ${d.coupon.pct}% OFF` : 'Último e-mail sobre seu pedido',
      paras: (d) => d.coupon
        ? ['Este é o último e-mail que enviamos sobre seu pedido — prometemos.', 'Antes de liberar seu carrinho, deixamos nosso melhor desconto:', `${d.coupon.pct}% OFF com o código abaixo — válido até ${d.until}. É o maior desconto que oferecemos.`, 'Se decidir que não é pra você, tudo bem — não escrevemos mais sobre este pedido.']
        : ['Este é o último e-mail que enviamos sobre seu pedido — prometemos.', 'Seu carrinho será liberado em breve. Se decidir que não é pra você, tudo bem — não escrevemos mais.'],
      cta: (d) => d.coupon ? `Aproveitar o ${d.coupon.pct}% OFF` : 'Completar meu pedido',
    },
  },
  es: {
    greet: (n) => n ? `¡Hola, ${n}!` : '¡Hola!',
    labels: {
      summary: 'Resumen del pedido', total: 'Total', address: 'Dirección de entrega',
      est: (d) => `Entrega estimada hasta ${d}`, reason: (site) => `Recibiste este correo porque iniciaste un pedido en ${site}.`,
      privacy: 'Este acceso es privado. No compartas el enlace de seguimiento.',
      shipSoon: 'Te enviaremos el enlace de seguimiento en cuanto tu pedido salga del centro de envíos.',
      yourItems: 'tus artículos',
    },
    order_created: { icon: 'check', t: '¡Recibimos tu pedido!', s: (o) => `Recibimos tu pedido ${o.number}`, b: 'Tu pedido está esperando la confirmación del pago — te avisamos en cuanto se apruebe.' },
    payment_approved: { icon: 'check', t: '¡Gracias por tu compra!', s: (o) => `Pago confirmado — pedido ${o.number}`, b: 'Recibimos tu pedido y ya está en preparación.' },
    ship_created: { icon: 'box', t: '¡Tu pedido fue despachado!', s: (o) => `Tu código de seguimiento del pedido ${o.number}`, b: 'Ya está en camino.', cta: () => 'Seguir mi pedido →', codeLabel: 'Código de seguimiento' },
    ship_step: { icon: 'box', t: 'Actualización de entrega', s: (o, step) => `Actualización de entrega — ${step}`, b: 'Tu entrega acaba de avanzar. Estado actual:', cta: () => 'Ver línea de tiempo →', codeLabel: 'Código de seguimiento' },
    abandoned_1: {
      s: () => 'Tu pedido quedó guardado',
      paras: () => ['Vimos que empezaste tu pedido de {p} pero no llegaste a completarlo. Tranquilo: guardamos todo tal como lo dejaste.', 'Solo te falta un paso. Haz clic abajo y retoma exactamente donde estabas — no hace falta cargar nada de nuevo.', 'Si tuviste algún problema con el pago o la página, responde este correo y te ayudamos al instante.'],
      cta: () => 'Completar mi pedido',
    },
    abandoned_2: { lead: '¿Olvidaste algo? 🛒', s: () => '¿Olvidaste algo? 🛒', paras: (d) => ['Tu pedido de {p} todavía te está esperando. Complétalo ahora antes de que se agote.'].concat(d.social ? [`Estás en buena compañía: ${d.social}.`] : []), cta: () => 'Completar mi pedido' },
    abandoned_3: { lead: '¿Tienes dudas? Estamos para ayudarte 💬', s: () => '¿Tienes dudas? Estamos para ayudarte', paras: (d) => ['Si tuviste algún problema al completar tu compra de {p}, responde este correo. Nuestro equipo te responde en minutos.'].concat(d.guarantee ? [`Y compras protegido: garantía de ${d.guarantee} días.`] : []), cta: () => 'Completar mi pedido' },
    abandoned_4: {
      s: (d) => d && d.coupon ? `${d.coupon.pct}% de descuento en tu pedido — solo hoy` : 'Tu carrito expira pronto',
      paras: (d) => d.coupon
        ? ['Vamos a ser directos: queremos que {p} llegue hasta ti. Entonces preparamos algo:', `${d.coupon.pct}% de descuento con el código abajo — válido solamente hasta ${d.until}.`, 'Después de eso, el código deja de funcionar y el pedido vuelve al precio normal. No es frase de marketing: el sistema lo desactiva automáticamente.', 'Aplícalo en el checkout — tu carrito sigue guardado tal como lo dejaste.']
        : ['Tu carrito se liberará pronto. Completa ahora para asegurar {p}.'],
      cta: (d) => d.coupon ? `Usar mi ${d.coupon.pct}% OFF` : 'Finalizar ahora',
    },
    abandoned_5: {
      s: (d) => d && d.coupon ? `Nuestro mejor descuento — ${d.coupon.pct}% OFF` : 'Último correo sobre tu pedido',
      paras: (d) => d.coupon
        ? ['Este es el último correo que enviamos sobre tu pedido — lo prometemos.', 'Antes de cerrar tu carrito, dejamos nuestro mejor descuento:', `${d.coupon.pct}% OFF con el código abajo — válido hasta ${d.until}. Es el mayor descuento que ofrecemos.`, 'Si decides que no es para ti, todo bien — no te escribiremos más sobre este pedido.']
        : ['Este es el último correo que enviamos sobre tu pedido — lo prometemos.', 'Tu carrito se liberará pronto. Si decides que no es para ti, todo bien — no te escribiremos más.'],
      cta: (d) => d.coupon ? `Aprovechar el ${d.coupon.pct}% OFF` : 'Completar mi pedido',
    },
  },
  de: {
    greet: (n) => n ? `Hallo, ${n}!` : 'Hallo!',
    labels: {
      summary: 'Bestellübersicht', total: 'Gesamt', address: 'Lieferadresse',
      est: (d) => `Voraussichtliche Zustellung bis ${d}`, reason: (site) => `Sie erhalten diese E-Mail, weil Sie eine Bestellung bei ${site} begonnen haben.`,
      privacy: 'Dieser Zugang ist privat. Bitte teilen Sie den Sendungslink nicht.',
      shipSoon: 'Wir senden Ihnen den Sendungslink, sobald Ihre Bestellung das Versandzentrum verlässt.',
      yourItems: 'Ihre Artikel',
    },
    order_created: { icon: 'check', t: 'Bestellung eingegangen!', s: (o) => `Wir haben Ihre Bestellung ${o.number} erhalten`, b: 'Ihre Bestellung wartet auf die Zahlungsbestätigung — wir melden uns, sobald sie genehmigt ist.' },
    payment_approved: { icon: 'check', t: 'Danke für Ihren Einkauf!', s: (o) => `Zahlung bestätigt — Bestellung ${o.number}`, b: 'Wir haben Ihre Bestellung erhalten und sie wird bereits vorbereitet.' },
    ship_created: { icon: 'box', t: 'Ihre Bestellung wurde versandt!', s: (o) => `Ihre Sendungsnummer zur Bestellung ${o.number}`, b: 'Sie ist bereits unterwegs.', cta: () => 'Sendung verfolgen →', codeLabel: 'Sendungsnummer' },
    ship_step: { icon: 'box', t: 'Lieferupdate', s: (o, step) => `Lieferupdate — ${step}`, b: 'Ihre Lieferung ist einen Schritt weiter. Aktueller Status:', cta: () => 'Zeitleiste ansehen →', codeLabel: 'Sendungsnummer' },
    abandoned_1: {
      s: () => 'Ihre Bestellung ist gespeichert',
      paras: () => ['Wir haben gesehen, dass Sie Ihre Bestellung von {p} begonnen, aber nicht abgeschlossen haben. Keine Sorge: Wir haben alles genau so gespeichert, wie Sie es verlassen haben.', 'Es fehlt nur noch ein Schritt. Klicken Sie unten und machen Sie genau dort weiter — Sie müssen nichts erneut eingeben.', 'Falls es ein Problem mit der Zahlung oder der Seite gab, antworten Sie auf diese E-Mail und wir helfen sofort.'],
      cta: () => 'Bestellung abschließen',
    },
    abandoned_2: { lead: 'Etwas vergessen? 🛒', s: () => 'Etwas vergessen? 🛒', paras: (d) => ['Ihre Bestellung von {p} wartet noch auf Sie. Schließen Sie sie ab, bevor sie ausverkauft ist.'].concat(d.social ? [`Sie sind in guter Gesellschaft: ${d.social}.`] : []), cta: () => 'Bestellung abschließen' },
    abandoned_3: { lead: 'Fragen? Wir helfen gern 💬', s: () => 'Fragen? Wir helfen gern', paras: (d) => ['Falls es beim Abschluss Ihres Kaufs von {p} ein Problem gab, antworten Sie einfach auf diese E-Mail. Unser Team antwortet in Minuten.'].concat(d.guarantee ? [`Und Sie kaufen geschützt: ${d.guarantee} Tage Garantie.`] : []), cta: () => 'Bestellung abschließen' },
    abandoned_4: {
      s: (d) => d && d.coupon ? `${d.coupon.pct}% Rabatt auf Ihre Bestellung — nur heute` : 'Ihr Warenkorb läuft bald ab',
      paras: (d) => d.coupon
        ? ['Ganz direkt: Wir möchten, dass {p} bei Ihnen ankommt. Deshalb haben wir etwas vorbereitet:', `${d.coupon.pct}% Rabatt mit dem Code unten — gültig nur bis ${d.until}.`, 'Danach funktioniert der Code nicht mehr und die Bestellung kehrt zum Normalpreis zurück. Kein Marketing-Spruch: Das System deaktiviert ihn automatisch.', 'Im Checkout anwenden — Ihr Warenkorb ist weiterhin gespeichert.']
        : ['Ihr Warenkorb wird bald freigegeben. Schließen Sie jetzt ab, um {p} zu sichern.'],
      cta: (d) => d.coupon ? `Meine ${d.coupon.pct}% sichern` : 'Jetzt abschließen',
    },
    abandoned_5: {
      s: (d) => d && d.coupon ? `Unser bester Rabatt — ${d.coupon.pct}% OFF` : 'Letzte E-Mail zu Ihrer Bestellung',
      paras: (d) => d.coupon
        ? ['Dies ist die letzte E-Mail zu Ihrer Bestellung — versprochen.', 'Bevor wir Ihren Warenkorb schließen, hier unser bester Rabatt:', `${d.coupon.pct}% OFF mit dem Code unten — gültig bis ${d.until}. Es ist der größte Rabatt, den wir anbieten.`, 'Wenn Sie entscheiden, dass es nichts für Sie ist, völlig in Ordnung — wir schreiben nicht mehr zu dieser Bestellung.']
        : ['Dies ist die letzte E-Mail zu Ihrer Bestellung — versprochen.', 'Ihr Warenkorb wird bald freigegeben. Wenn es nichts für Sie ist, völlig in Ordnung — wir schreiben nicht mehr.'],
      cta: (d) => d.coupon ? `${d.coupon.pct}% OFF nutzen` : 'Bestellung abschließen',
    },
  },
};

const MAIL_LOCALE = { pt: 'pt-BR', en: 'en-US', es: 'es-ES', de: 'de-DE' };
function mailMoney(v, currency, lang) {
  try { return new Intl.NumberFormat(MAIL_LOCALE[lang] || 'en-US', { style: 'currency', currency: currency || 'BRL' }).format(Number(v) || 0); }
  catch { return `${currency || ''} ${(Number(v) || 0).toFixed(2)}`.trim(); }
}

function mailEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// caixa cinza com cabeçalho em caixa alta (resumo, código, endereço)
function mailBox(label, innerHtml) {
  return `<div style="background:#f6f7f9;border:1px solid #eceef2;border-radius:10px;padding:16px 18px;margin:18px 0 0;text-align:center">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#8a94a4;font-weight:700;margin-bottom:10px">${mailEsc(label)}</div>
    ${innerHtml}
  </div>`;
}

// layout único: faixa escura com a logo da loja, conteúdo centralizado com ícone,
// caixas de resumo/código/endereço, cupom tracejado e botão azul — usado por todos os tipos
function renderEmailHtml({ fromName, logoUrl, icon, title, greet, lead, parasHtml, body, code, codeLabel, estLine, extra, couponCode, ctaLabel, ctaUrl, summary, address, addressLabel, footNote, reasonNote, supportEmail, centered }) {
  const e = mailEsc;
  const sans = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
  const iconHtml = icon === 'check'
    ? `<div style="display:inline-block;width:54px;height:54px;line-height:54px;border-radius:12px;background:#34c777;color:#ffffff;font-size:28px;font-weight:800;text-align:center">✓</div>`
    : icon === 'box' ? `<div style="font-size:44px;line-height:1">📦</div>` : '';
  const summaryHtml = summary && summary.items && summary.items.length ? mailBox(summary.heading, `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${summary.items.map((it) => `<tr>
        <td align="left" style="font-size:13.5px;line-height:1.5;color:#2a303b;font-weight:600;padding:5px 10px 5px 0">${e((it.qty > 1 ? it.qty + '× ' : '') + it.title)}</td>
        <td align="right" style="font-size:13.5px;color:#d93025;font-weight:700;white-space:nowrap;padding:5px 0">${e(it.priceFmt || '')}</td>
      </tr>`).join('')}
      ${summary.items.length > 1 ? `<tr>
        <td align="left" style="font-size:13.5px;color:#15181e;font-weight:800;padding:10px 10px 0 0;border-top:1px solid #e4e7ec">${e(summary.totalLabel)}</td>
        <td align="right" style="font-size:14.5px;color:#d93025;font-weight:800;padding:10px 0 0;border-top:1px solid #e4e7ec">${e(summary.totalFmt)}</td>
      </tr>` : ''}
    </table>`) : '';
  const codeHtml = code ? mailBox(codeLabel || '', `
    <div style="font-size:21px;font-weight:800;letter-spacing:2px;color:#15181e;font-family:${sans}">${e(code)}</div>
    ${estLine ? `<div style="font-size:12.5px;font-weight:700;color:#16a34a;margin-top:8px">${e(estLine)}</div>` : ''}`) : '';
  const addressHtml = address ? mailBox(addressLabel || '', `<div style="font-size:13.5px;color:#4b5563;line-height:1.6">${e(address)}</div>`) : '';
  const couponHtml = couponCode ? `<div style="border:1.5px dashed #c6ccd8;border-radius:8px;padding:20px 16px;margin:20px 0 0;text-align:center">
    <span style="font-size:22px;font-weight:800;letter-spacing:6px;color:#15181e">${e(couponCode)}</span>
  </div>` : '';
  const align = centered ? 'center' : 'left';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef0f4;font-family:${sans}">
  <div style="max-width:560px;margin:0 auto;background:#ffffff">
    <div style="background:#1b2130;text-align:center;padding:24px 20px">
      ${logoUrl ? `<img src="${e(logoUrl)}" alt="${e(fromName || '')}" style="max-height:46px;max-width:240px;vertical-align:middle">`
        : `<span style="color:#ffffff;font-size:17px;font-weight:800;letter-spacing:.14em;text-transform:uppercase">${e(fromName || '')}</span>`}
    </div>
    <div style="padding:30px 30px 28px;text-align:${align};color:#15181e">
      ${iconHtml ? `<div style="text-align:center;margin-bottom:16px">${iconHtml}</div>` : ''}
      ${title ? `<h1 style="margin:0 0 10px;font-size:23px;font-weight:700;color:#15181e;text-align:center">${e(title)}</h1>` : ''}
      ${lead ? `<p style="margin:0 0 14px;font-size:15px;font-weight:700;color:#15181e">${e(lead)}</p>` : (greet && !centered ? `<p style="margin:0 0 14px;font-size:15px;font-weight:700;color:#15181e">${e(greet)}</p>` : '')}
      ${centered && (greet || body) ? `<p style="margin:0;font-size:14px;line-height:1.7;color:#6b7280;text-align:center">${e([greet, body].filter(Boolean).join(' '))}</p>` : ''}
      ${!centered && body ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.75;color:#4b5563">${e(body).replace(/\n/g, '<br>')}</p>` : ''}
      ${(parasHtml || []).map((p) => `<p style="margin:0 0 13px;font-size:14px;line-height:1.75;color:#4b5563">${p}</p>`).join('')}
      ${extra ? `<p style="margin:12px 0 0;font-size:14px;font-weight:700;color:#15181e;text-align:center">${e(extra)}</p>` : ''}
      ${summaryHtml}
      ${codeHtml}
      ${addressHtml}
      ${couponHtml}
      ${ctaLabel && ctaUrl ? `<div style="text-align:center;margin:26px 0 0"><a href="${e(ctaUrl)}" style="display:inline-block;background:#3b7cf6;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:700;letter-spacing:.04em;padding:13px 30px;border-radius:8px">${e(ctaLabel)}</a></div>` : ''}
      ${footNote ? `<p style="margin:22px 0 0;font-size:12px;color:#8a94a4;text-align:center;line-height:1.6">${e(footNote)}</p>` : ''}
      ${reasonNote ? `<p style="margin:18px 0 0;font-size:11.5px;color:#9aa3b2;text-align:center;line-height:1.6">${e(reasonNote)}</p>` : ''}
    </div>
    ${supportEmail ? `<div style="background:#f4f6f9;border-top:1px solid #e8ebf0;text-align:center;padding:15px 20px">
      <span style="font-size:12px;color:#8a94a4">${e(supportEmail)}</span>
    </div>` : ''}
  </div></body></html>`;
}

// monta assunto+HTML de qualquer tipo, com dados reais ou de amostra
function buildEmail(cfg, type, lang, data) {
  const L = MAIL_I18N[lang] || MAIL_I18N.en;
  const T = L[type] || null;
  if (!T) throw new Error(`Tipo de e-mail desconhecido: ${type}`);
  const o = data.order || { number: '#1234' };
  const stepLabel = data.stepLabel || '';
  const isAbandoned = type.startsWith('abandoned');
  const hasItems = !isAbandoned && Array.isArray(o.items) && o.items.length > 0;
  const locale = MAIL_LOCALE[lang] || 'en-US';
  const d = {
    ...data,
    coupon: data.coupon && data.coupon.code ? data.coupon : null,
    until: new Date(Date.now() + 24 * 3600000).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  };
  const subject = type === 'ship_step' ? T.s(o, stepLabel) : T.s(isAbandoned ? d : o);
  // {p} vira o nome do produto em negrito (escapado)
  const prodHtml = `<strong>${mailEsc(data.product || L.labels.yourItems)}</strong>`;
  const parasHtml = isAbandoned && T.paras ? T.paras(d).map((p) => mailEsc(p).replace(/\{p\}/g, prodHtml)) : null;
  const site = data.site || (data.url ? (() => { try { return new URL(data.url).host; } catch { return null; } })() : null);
  const estLine = (type === 'ship_created' || type === 'ship_step') && data.estDelivery
    ? L.labels.est(new Date(data.estDelivery).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })) : null;
  const html = renderEmailHtml({
    fromName: cfg.fromName || cfg.fromEmail,
    logoUrl: cfg.logoUrl || '',
    icon: T.icon || null,
    title: isAbandoned ? null : T.t,
    greet: L.greet(data.name || ''),
    lead: T.lead || null,
    parasHtml,
    body: isAbandoned ? null : T.b,
    code: type === 'ship_created' || type === 'ship_step' ? data.code : null,
    codeLabel: T.codeLabel,
    estLine,
    extra: type === 'ship_step' ? stepLabel : null,
    couponCode: isAbandoned && d.coupon ? d.coupon.code : null,
    ctaLabel: T.cta ? T.cta(d) : null,
    ctaUrl: data.url || null,
    summary: hasItems ? {
      heading: L.labels.summary, totalLabel: L.labels.total,
      items: o.items.slice(0, 8).map((it) => ({ ...it, priceFmt: mailMoney((it.price || 0) * (it.qty || 1), o.currency, lang) })),
      totalFmt: mailMoney(o.total, o.currency, lang),
    } : null,
    address: !isAbandoned ? (o.addr || null) : null,
    addressLabel: L.labels.address,
    footNote: type === 'order_created' || type === 'payment_approved' ? L.labels.shipSoon
      : ((type === 'ship_created' || type === 'ship_step') && data.url ? L.labels.privacy : null),
    reasonNote: isAbandoned && site ? L.labels.reason(site) : null,
    supportEmail: cfg.replyTo || cfg.fromEmail || '',
    centered: !isAbandoned,
  });
  return { subject, html };
}

async function sendResend(cfg, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      from: cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail,
      to: [to],
      subject,
      html,
      ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json && (json.message || (json.error && json.error.message))) || `Resend respondeu ${res.status}`);
  return json;
}

async function logEmail(entry) {
  const log = (await db.readDoc('email_log', [])) || [];
  log.unshift({ at: new Date().toISOString(), ...entry });
  await db.writeDoc('email_log', log.slice(0, 400));
}

// dedup de envios automáticos: doc email_sent { "<tipo>:<id>": ts }
async function emailAlreadySent(map, key) { return !!map[key]; }

/* ---------- rotas do painel: e-mails ---------- */

app.get('/api/email/config', async (req, res) => {
  try {
    const c = await loadEmailCfg();
    res.json({
      apiKeySet: !!c.apiKey, fromEmail: c.fromEmail, fromName: c.fromName, replyTo: c.replyTo,
      logoUrl: c.logoUrl || '', coupons: c.coupons,
      lang: c.lang, automations: c.automations, antiDup: !!c.antiDup, ready: emailReady(c),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/email/config', async (req, res) => {
  try {
    const c = await loadEmailCfg();
    const b = req.body || {};
    if (typeof b.apiKey === 'string' && b.apiKey.trim() !== '') c.apiKey = b.apiKey.trim();
    if (b.apiKey === '') c.apiKey = '';
    if (typeof b.fromEmail === 'string') c.fromEmail = b.fromEmail.trim().toLowerCase();
    if (typeof b.fromName === 'string') c.fromName = b.fromName.trim().slice(0, 60);
    if (typeof b.replyTo === 'string') c.replyTo = b.replyTo.trim().toLowerCase();
    if (typeof b.logoUrl === 'string') {
      const u = b.logoUrl.trim().slice(0, 300);
      c.logoUrl = /^https?:\/\//i.test(u) ? u : '';
    }
    if (['pt', 'es', 'en', 'de'].includes(b.lang)) c.lang = b.lang;
    if (b.automations && typeof b.automations === 'object') {
      // trava anti-duplicação: só liga automação com a checkbox marcada
      if (!b.antiDup && Object.values(b.automations).some(Boolean)) {
        return res.status(400).json({ error: 'Pra ligar automações, confirme a checkbox anti-duplicação (confira o que a Shopify ainda envia).' });
      }
      for (const k of Object.keys(EMAILCFG_DEFAULTS.automations)) {
        if (typeof b.automations[k] === 'boolean') c.automations[k] = b.automations[k];
      }
    }
    if (typeof b.antiDup === 'boolean') c.antiDup = b.antiDup;
    if (b.coupons && typeof b.coupons === 'object') {
      for (const k of ['c1', 'c2']) {
        const cp = b.coupons[k];
        if (!cp || typeof cp !== 'object') continue;
        if (typeof cp.code === 'string') c.coupons[k].code = cp.code.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
        const pct = parseInt(cp.pct, 10);
        if (pct >= 1 && pct <= 90) c.coupons[k].pct = pct;
      }
    }
    if (b.crm && typeof b.crm === 'object') {
      if (Array.isArray(b.crm.delaysMin)) {
        const ds = b.crm.delaysMin.map((v) => parseInt(v, 10)).filter((v) => v >= 5 && v <= 60 * 24 * 14);
        if (ds.length === 5) c.crm.delaysMin = ds;
        else return res.status(400).json({ error: 'Informe 5 atrasos em minutos (entre 5 min e 14 dias), separados por vírgula.' });
      }
      if (b.crm.guaranteeDays != null) {
        const g = parseInt(b.crm.guaranteeDays, 10);
        c.crm.guaranteeDays = g >= 1 && g <= 365 ? g : 0;
      }
      if (typeof b.crm.socialProof === 'string') c.crm.socialProof = b.crm.socialProof.trim().slice(0, 80);
    }
    await saveEmailCfg(c);
    res.json({ ok: true, ready: emailReady(c) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const MAIL_SAMPLE = {
  order: {
    number: '#1042', total: 169.9, currency: 'EUR',
    items: [{ title: 'Conjunto de perfumes Premium, Kit 2 unidades', qty: 1, price: 169.9 }],
    addr: 'Av. Corrientes 1234, Piso 5, Buenos Aires, C1043, AR',
  },
  name: 'Maria', code: 'TK-A1B2C', url: 'https://exemplo.com', stepLabel: '—',
  estDelivery: new Date(Date.now() + 14 * 86400000).toISOString(),
  product: 'Conjunto de perfumes Premium, Kit 2 unidades', site: 'www.sualoja.com',
};

// dados de amostra por tipo: cupom real configurado (ou exemplo) nos e-mails 4 e 5
function mailSampleFor(cfg, type) {
  const d = { ...MAIL_SAMPLE };
  if (type === 'abandoned_4') d.coupon = cfg.coupons.c1.code ? cfg.coupons.c1 : { code: 'CUPOM10', pct: cfg.coupons.c1.pct || 10 };
  if (type === 'abandoned_5') d.coupon = cfg.coupons.c2.code ? cfg.coupons.c2 : { code: 'CUPOM15', pct: cfg.coupons.c2.pct || 15 };
  d.social = (cfg.crm && cfg.crm.socialProof) || null;
  d.guarantee = (cfg.crm && cfg.crm.guaranteeDays) || null;
  return d;
}

app.get('/api/email/preview', async (req, res) => {
  try {
    const c = await loadEmailCfg();
    const lang = ['pt', 'es', 'en', 'de'].includes(req.query.lang) ? req.query.lang : c.lang;
    const type = String(req.query.type || 'payment_approved');
    const data = { ...mailSampleFor(c, type), stepLabel: (SHIP_I18N[lang] || SHIP_I18N.en).steps.intransit };
    const { subject, html } = buildEmail({ ...c, fromName: c.fromName || 'Sua Loja' }, type, lang, data);
    res.type('html').send(`<!-- ${mailEsc(subject)} -->` + html);
  } catch (e) { res.status(400).type('html').send(`<p style="font-family:system-ui;padding:20px">${mailEsc(e.message)}</p>`); }
});

app.post('/api/email/test', async (req, res) => {
  try {
    const c = await loadEmailCfg();
    if (!emailReady(c)) return res.status(400).json({ error: 'Configure a chave do Resend e o remetente primeiro.' });
    const { type, lang, to } = req.body || {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to || ''))) return res.status(400).json({ error: 'Informe um e-mail de destino válido.' });
    const l = ['pt', 'es', 'en', 'de'].includes(lang) ? lang : c.lang;
    const ty = String(type || 'payment_approved');
    const data = { ...mailSampleFor(c, ty), stepLabel: (SHIP_I18N[l] || SHIP_I18N.en).steps.intransit };
    const { subject, html } = buildEmail(c, ty, l, data);
    await sendResend(c, to, `[TESTE] ${subject}`, html);
    await logEmail({ to, type: `teste:${type}`, subject, status: 'enviado' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/email/log', async (req, res) => {
  try { res.json({ log: ((await db.readDoc('email_log', [])) || []).slice(0, 100) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// e-mail de rastreio sob demanda (botão no modal do envio)
app.post('/api/ship/email', async (req, res) => {
  try {
    const c = await loadEmailCfg();
    if (!emailReady(c)) return res.status(400).json({ error: 'Configure o Resend primeiro (aba E-mails).' });
    const shipments = (await db.readDoc('shipments', {})) || {};
    const s = shipments[(req.body || {}).key];
    if (!s) return res.status(404).json({ error: 'Envio não encontrado.' });
    if (!s.email) return res.status(400).json({ error: 'Este pedido não tem e-mail de cliente.' });
    const lang = (await loadShipCfg()).lang || c.lang;
    const entrega = (s.steps || []).find((st) => st.id === 'delivered');
    const { subject, html } = buildEmail(c, 'ship_created', lang, {
      order: { number: s.number, items: s.items, total: s.total, currency: s.currency, addr: s.addr || null },
      name: (s.customerName || '').split(' ')[0],
      code: s.code, url: `${appBaseUrl(req)}/t/${s.code}`,
      estDelivery: entrega ? entrega.revealAt : null,
    });
    await sendResend(c, s.email, subject, html);
    s.emailStatus = 'enviado';
    await db.writeDoc('shipments', shipments);
    await logEmail({ to: s.email, type: 'ship_created', subject, status: 'enviado', orderKey: s.key });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- automações: ciclo de e-mails (roda no cron) ---------- */

async function runEmailCycle(baseUrl) {
  const c = await loadEmailCfg();
  if (!emailReady(c)) return { skipped: true, reason: 'Resend não configurado.' };
  const a = c.automations;
  if (!a.orderCreated && !a.paymentApproved && !a.shipping && !a.delivery) return { skipped: true, reason: 'Automações desligadas.' };
  let ctx;
  try { ctx = await ensureFlowConfig(); } catch { return { skipped: true, reason: 'Flow não configurado.' }; }
  const sent = (await db.readDoc('email_sent', {})) || {};
  const cutoff = Date.now() - 60 * 86400000;
  for (const k of Object.keys(sent)) if (sent[k] < cutoff) delete sent[k];
  let enviados = 0;
  const erros = [];
  const shipLang = (await loadShipCfg()).lang || c.lang;

  // pedidos recentes (pagos e pendentes)
  if ((a.paymentApproved || a.orderCreated) && ctx.pool.length) {
    try {
      const from = new Date(Date.now() - 48 * 3600000);
      const results = await cached(`emailorders:${ctx.pool.map((s) => s.id).join(',')}`, 60000, () => collectOrders(ctx.pool, from, new Date()));
      for (const o of results.flatMap((r) => r.orders)) {
        if (enviados >= 25) break;
        if (!o.email) continue;
        const tipo = o.status === 'paid' ? (a.paymentApproved ? 'payment_approved' : null)
          : (o.status === 'pending' ? (a.orderCreated ? 'order_created' : null) : null);
        if (!tipo) continue;
        const key = `${tipo}:${o.orderId}`;
        if (sent[key]) continue;
        try {
          const { subject, html } = buildEmail(c, tipo, shipLang, { order: o, name: (o.customerName || '').split(' ')[0] });
          await sendResend(c, o.email, subject, html);
          sent[key] = Date.now();
          enviados++;
          await logEmail({ to: o.email, type: tipo, subject, status: 'enviado', orderKey: `${o.storeId}:${o.orderId}` });
        } catch (e) { erros.push(e.message.slice(0, 120)); if (erros.length > 3) break; }
      }
    } catch (e) { erros.push(`pedidos: ${e.message}`.slice(0, 120)); }
  }

  // etapas do rastreio reveladas → e-mail de atualização
  if (a.shipping || a.delivery) {
    const shipments = (await db.readDoc('shipments', {})) || {};
    let mudou = false;
    for (const s of Object.values(shipments)) {
      if (enviados >= 25) break;
      if (!s.email) continue;
      s.notified = s.notified || [];
      for (const st of s.steps || []) {
        if (['confirmed', 'preparing'].includes(st.id)) continue; // cobertos pelo ship_created
        if (new Date(st.revealAt).getTime() > Date.now()) break;
        if (s.notified.includes(st.id)) continue;
        const toggle = st.id === 'shipped' ? a.shipping : a.delivery;
        if (!toggle) { continue; }
        try {
          const stepLabel = (SHIP_I18N[shipLang] || SHIP_I18N.en).steps[st.id] || st.id;
          const entrega = (s.steps || []).find((x) => x.id === 'delivered');
          const { subject, html } = buildEmail(c, 'ship_step', shipLang, {
            order: { number: s.number, items: s.items, total: s.total, currency: s.currency, addr: s.addr || null },
            name: (s.customerName || '').split(' ')[0],
            stepLabel, code: s.code, url: `${baseUrl}/t/${s.code}`,
            estDelivery: entrega ? entrega.revealAt : null,
          });
          await sendResend(c, s.email, subject, html);
          s.notified.push(st.id);
          mudou = true;
          enviados++;
          await logEmail({ to: s.email, type: `ship_step:${st.id}`, subject, status: 'enviado', orderKey: s.key });
        } catch (e) { erros.push(e.message.slice(0, 120)); break; }
      }
    }
    if (mudou) await db.writeDoc('shipments', shipments);
  }

  await db.writeDoc('email_sent', sent);
  return { enviados, erros };
}

/* ---------- CRM de recuperação (checkouts abandonados) ---------- */

const CRM_STAGES = [
  { k: 's1', horas: 1, tipo: 'abandoned_1', nome: 'Pedido guardado' },
  { k: 's2', horas: 24, tipo: 'abandoned_2', nome: 'Esqueceu algo?' },
  { k: 's3', horas: 48, tipo: 'abandoned_3', nome: 'Dúvidas? Suporte' },
  { k: 's4', horas: 72, tipo: 'abandoned_4', nome: 'Cupom 1 (desconto)' },
  { k: 's5', horas: 96, tipo: 'abandoned_5', nome: 'Cupom final' },
];

async function fetchAbandoned(store, sinceDays = 7) {
  const params = new URLSearchParams({ limit: '250', created_at_min: new Date(Date.now() - sinceDays * 86400000).toISOString() });
  const { data } = await shopifyFetch(store, `checkouts.json?${params}`);
  return (data.checkouts || []).map((ck) => ({
    id: String(ck.id),
    storeId: store.id, storeName: store.name,
    email: ck.email || null,
    consent: ck.buyer_accepts_marketing !== false,
    url: ck.abandoned_checkout_url || null,
    total: parseFloat(ck.total_price) || 0,
    currency: ck.currency,
    locale: ck.customer_locale || null,
    createdAt: ck.created_at,
    name: ck.billing_address ? [ck.billing_address.first_name, ck.billing_address.last_name].filter(Boolean).join(' ') : null,
    product: (ck.line_items && ck.line_items[0])
      ? ck.line_items[0].title + (ck.line_items.length > 1 ? ` (+${ck.line_items.length - 1})` : '')
      : null,
  }));
}

// leads (todos os checkouts) + elegíveis + estado da sequência
// elegível = com e-mail, consentimento, URL e sem compra posterior (janela 7d)
async function crmSnapshot() {
  const c = await loadEmailCfg();
  const crm = (await db.readDoc('crm', { sent: {} })) || { sent: {} };
  crm.sent = crm.sent || {};
  let ctx;
  try { ctx = await ensureFlowConfig(); } catch { ctx = { pool: [] }; }
  let eligible = [];
  const leads = [];
  const erros = [];
  if (ctx.pool.length) {
    // e-mails que JÁ compraram nos últimos 7 dias (anti-duplicação + conversão)
    let compradores = new Set();
    let pedidos = [];
    try {
      const from = new Date(Date.now() - 7 * 86400000);
      const results = await cached(`crmorders:${ctx.pool.map((s) => s.id).join(',')}`, 60000, () => collectOrders(ctx.pool, from, new Date()));
      pedidos = results.flatMap((r) => r.orders);
      compradores = new Set(pedidos.filter((o) => o.email).map((o) => o.email.toLowerCase()));
    } catch { /* segue sem o filtro */ }
    for (const store of ctx.pool) {
      try {
        const cks = await cached(`crmck:${store.id}`, 60000, () => fetchAbandoned(store));
        for (const ck of cks) {
          const comprou = !!(ck.email && compradores.has(ck.email.toLowerCase()));
          const status = !ck.email ? 'sem_email' : (comprou ? 'convertido' : 'abandonado');
          const lead = { ...ck, status, stages: crm.sent[ck.id] || {} };
          leads.push(lead);
          if (status === 'abandonado' && ck.consent && ck.url) eligible.push(lead);
        }
      } catch (e) {
        const falta = /403|forbidden|scope/i.test(String(e.message));
        erros.push(`${store.name}: ${falta ? 'falta o escopo read_checkouts no app da loja' : String(e.message).slice(0, 100)}`);
      }
    }
    // recuperados: 1º e-mail enviado e compra do mesmo e-mail depois dele
    var recuperados = [];
    const sentIds = Object.keys(crm.sent);
    if (sentIds.length && pedidos.length) {
      const byEmail = {};
      for (const o of pedidos) if (o.email) (byEmail[o.email.toLowerCase()] = byEmail[o.email.toLowerCase()] || []).push(o);
      for (const [ckId, stages] of Object.entries(crm.sent)) {
        const first = Math.min(...Object.values(stages).filter((v) => typeof v === 'number'));
        const em = (stages._email || '').toLowerCase();
        for (const o of byEmail[em] || []) {
          if (o.createdAt.getTime() > first) { recuperados.push({ email: em, number: o.number, total: o.total, currency: o.currency, at: o.createdAt }); break; }
        }
      }
    }
  }
  leads.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  eligible.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  return { cfg: c, crm, leads: leads.slice(0, 400), eligible: eligible.slice(0, 200), recuperados: recuperados || [], erros };
}

// e-mails da sequência que estão "vencidos" agora (usado pelo ciclo e pela simulação)
function crmDue(cfg, crm, eligible) {
  const due = [];
  for (const ck of eligible) {
    const min = (Date.now() - new Date(ck.createdAt).getTime()) / 60000;
    const stages = crm.sent[ck.id] || {};
    for (let i = 0; i < CRM_STAGES.length; i++) {
      const st = CRM_STAGES[i];
      const delay = cfg.crm.delaysMin[i] || 0;
      if (stages[st.k] || min < delay) continue;
      due.push({ ck, st, idx: i });
      break; // uma etapa por ciclo por checkout
    }
  }
  return due;
}

app.get('/api/crm', async (req, res) => {
  try {
    const { cfg, crm, leads, eligible, recuperados, erros } = await crmSnapshot();
    const porEtapa = Object.fromEntries(CRM_STAGES.map((s) => [s.k, 0]));
    let abordados = 0;
    for (const stages of Object.values(crm.sent)) {
      let any = false;
      for (const st of CRM_STAGES) if (stages[st.k]) { porEtapa[st.k]++; any = true; }
      if (any) abordados++;
    }
    const abandonados = leads.filter((l) => l.status === 'abandonado').length;
    const convertidos = leads.filter((l) => l.status === 'convertido').length;
    res.json({
      enabled: !!cfg.automations.abandoned,
      ready: emailReady(cfg),
      antiDup: !!cfg.antiDup,
      coupons: cfg.coupons,
      crmCfg: cfg.crm,
      stages: CRM_STAGES.map((s, i) => ({ ...s, delayMin: cfg.crm.delaysMin[i], enviados: porEtapa[s.k] })),
      kpis: {
        leads: leads.length,
        abandonados,
        convertidos,
        emailsEnviados: Object.values(porEtapa).reduce((a, b) => a + b, 0),
        abordados,
        recuperados: recuperados.length,
        taxa: abordados ? Math.round((recuperados.length / abordados) * 100) : 0,
        receitaRecuperada: recuperados.reduce((s, r) => s + (r.total || 0), 0),
      },
      leads: leads.map((l) => ({
        id: l.id, storeName: l.storeName, email: l.email, name: l.name, product: l.product,
        locale: l.locale, total: l.total, currency: l.currency, createdAt: l.createdAt,
        status: l.status, consent: l.consent,
        etapas: CRM_STAGES.map((s) => !!(l.stages && l.stages[s.k])),
      })),
      recuperados, erros,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// simulação: mostra o que sairia agora, sem enviar nada
app.post('/api/crm/simulate', async (req, res) => {
  try {
    const { cfg, crm, eligible } = await crmSnapshot();
    const due = crmDue(cfg, crm, eligible).slice(0, 50);
    res.json({
      ok: true,
      ativa: !!cfg.automations.abandoned,
      ready: emailReady(cfg),
      sairia: due.map(({ ck, st, idx }) => ({
        email: ck.email, etapa: idx + 1, tema: st.nome, tipo: st.tipo,
        produto: ck.product, loja: ck.storeName,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function runCrmCycle() {
  const { cfg, crm, eligible } = await crmSnapshot();
  if (!cfg.automations.abandoned) return { skipped: true, reason: 'Automação de recuperação desligada.' };
  if (!emailReady(cfg)) return { skipped: true, reason: 'Resend não configurado.' };
  let enviados = 0;
  const erros = [];
  for (const { ck, st } of crmDue(cfg, crm, eligible)) {
    if (enviados >= 20) break;
    const stages = crm.sent[ck.id] || {};
    try {
      const lang = ['pt', 'es', 'en', 'de'].includes((ck.locale || '').slice(0, 2)) ? ck.locale.slice(0, 2) : cfg.lang;
      const coupon = st.k === 's4' ? cfg.coupons.c1 : (st.k === 's5' ? cfg.coupons.c2 : null);
      const { subject, html } = buildEmail(cfg, st.tipo, lang, {
        name: (ck.name || '').split(' ')[0], url: ck.url, product: ck.product,
        coupon: coupon && coupon.code ? coupon : null,
        social: cfg.crm.socialProof || null, guarantee: cfg.crm.guaranteeDays || null,
      });
      await sendResend(cfg, ck.email, subject, html);
      stages[st.k] = Date.now();
      stages._email = ck.email;
      crm.sent[ck.id] = stages;
      enviados++;
      await logEmail({ to: ck.email, type: st.tipo, subject, status: 'enviado' });
    } catch (e) { erros.push(e.message.slice(0, 120)); }
  }
  await db.writeDoc('crm', crm);
  return { enviados, erros };
}

app.post('/api/crm/run', async (req, res) => {
  try { res.json({ ok: true, ...(await runCrmCycle()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Caixa de entrada (suporte) ---------- */

app.get('/api/inbox', async (req, res) => {
  try {
    const list = (await db.readDoc('inbox', [])) || [];
    res.json({
      conversas: list.slice(0, 100),
      contagem: { todas: list.length, abertas: list.filter((c) => c.status === 'aberto').length, resolvidas: list.filter((c) => c.status === 'resolvido').length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// novo contato (envia de verdade via Resend) ou registro manual de e-mail recebido
app.post('/api/inbox/new', async (req, res) => {
  try {
    const { email, subject, message, modo } = req.body || {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) return res.status(400).json({ error: 'E-mail inválido.' });
    if (!String(message || '').trim()) return res.status(400).json({ error: 'Escreva a mensagem.' });
    const recebido = modo === 'recebido';
    const c = await loadEmailCfg();
    if (!recebido) {
      if (!emailReady(c)) return res.status(400).json({ error: 'Configure o Resend primeiro (aba E-mails).' });
      const html = renderEmailHtml({ fromName: c.fromName || c.fromEmail, logoUrl: c.logoUrl || '', greet: '', body: String(message).slice(0, 4000), ctaLabel: null, ctaUrl: null, supportEmail: c.replyTo || c.fromEmail || '' });
      await sendResend({ ...c, fromEmail: c.replyTo || c.fromEmail }, email, String(subject || 'Contato').slice(0, 150), html);
      await logEmail({ to: email, type: 'suporte', subject: String(subject || 'Contato'), status: 'enviado' });
    }
    const list = (await db.readDoc('inbox', [])) || [];
    list.unshift({
      id: crypto.randomUUID(), email: String(email).toLowerCase(), subject: String(subject || '(sem assunto)').slice(0, 150),
      status: 'aberto', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      msgs: [{ dir: recebido ? 'in' : 'out', at: new Date().toISOString(), text: String(message).slice(0, 4000) }],
    });
    await db.writeDoc('inbox', list.slice(0, 300));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inbox/reply', async (req, res) => {
  try {
    const { id, message, modo } = req.body || {};
    const list = (await db.readDoc('inbox', [])) || [];
    const convo = list.find((x) => x.id === id);
    if (!convo) return res.status(404).json({ error: 'Conversa não encontrada.' });
    if (!String(message || '').trim()) return res.status(400).json({ error: 'Escreva a mensagem.' });
    const recebido = modo === 'recebido';
    if (!recebido) {
      const c = await loadEmailCfg();
      if (!emailReady(c)) return res.status(400).json({ error: 'Configure o Resend primeiro (aba E-mails).' });
      const html = renderEmailHtml({ fromName: c.fromName || c.fromEmail, logoUrl: c.logoUrl || '', greet: '', body: String(message).slice(0, 4000), ctaLabel: null, ctaUrl: null, supportEmail: c.replyTo || c.fromEmail || '' });
      await sendResend({ ...c, fromEmail: c.replyTo || c.fromEmail }, convo.email, `Re: ${convo.subject}`, html);
      await logEmail({ to: convo.email, type: 'suporte', subject: `Re: ${convo.subject}`, status: 'enviado' });
    }
    convo.msgs.push({ dir: recebido ? 'in' : 'out', at: new Date().toISOString(), text: String(message).slice(0, 4000) });
    convo.updatedAt = new Date().toISOString();
    if (recebido) convo.status = 'aberto';
    await db.writeDoc('inbox', list);
    res.json({ ok: true, convo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inbox/status', async (req, res) => {
  try {
    const { id, status } = req.body || {};
    const list = (await db.readDoc('inbox', [])) || [];
    const convo = list.find((x) => x.id === id);
    if (!convo) return res.status(404).json({ error: 'Conversa não encontrada.' });
    convo.status = status === 'resolvido' ? 'resolvido' : 'aberto';
    convo.updatedAt = new Date().toISOString();
    await db.writeDoc('inbox', list);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// contexto da compra: pedidos recentes com o e-mail da conversa
app.get('/api/inbox/context', async (req, res) => {
  try {
    const email = String(req.query.email || '').toLowerCase();
    let pedidos = [];
    try {
      const { pool } = await ensureFlowConfig();
      if (pool.length && email) {
        const from = new Date(Date.now() - 45 * 86400000);
        const results = await cached(`inboxctx:${pool.map((s) => s.id).join(',')}`, 60000, () => collectOrders(pool, from, new Date()));
        pedidos = results.flatMap((r) => r.orders)
          .filter((o) => (o.email || '').toLowerCase() === email)
          .map((o) => ({ number: o.number, storeName: o.storeName, total: o.total, currency: o.currency, status: o.status, createdAt: o.createdAt }));
      }
    } catch { /* sem flow */ }
    res.json({ pedidos: pedidos.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  'read_shopify_payments',                  // Payouts (repasses do Shopify Payments)
  'read_checkouts',                         // CRM: checkouts abandonados das lojas de checkout
  'read_customers',                         // nome/e-mail do cliente (rastreio e CRM)
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
function makeState(shop, role) {
  // ns: conta dona do fluxo — o callback (sem cookie) usa isso pra salvar a loja no ambiente certo
  const payload = Buffer.from(JSON.stringify({ shop, role: role || null, ns: db.currentNs(), exp: Date.now() + OAUTH_STATE_MINUTES * 60000, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
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

    const role = (req.body || {}).role === 'vitrine' ? 'vitrine' : 'checkout';
    // token Storefront colado no assistente: guarda pendente por loja (a loja só existe após o callback)
    const sfPending = (await db.readDoc('sf_pending', {})) || {};
    if (role === 'checkout' && (req.body || {}).storefrontToken) {
      sfPending[shop] = String(req.body.storefrontToken).trim();
    } else { delete sfPending[shop]; }
    await db.writeDoc('sf_pending', sfPending);

    const url = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(oauthRedirectUri(req))}` +
      `&state=${encodeURIComponent(makeState(shop, role))}`;
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

    // papel escolhido no assistente (veio assinado no state): vitrine ou checkout
    try {
      await applyStoreRole(store.id, st.role === 'vitrine' ? 'vitrine' : 'checkout');
    } catch { /* não impede a conexão */ }

    // token Storefront que ficou pendente do assistente (checkout direto)
    try {
      const sfPending = (await db.readDoc('sf_pending', {})) || {};
      if (sfPending[shop]) {
        await validateAndSaveSfToken(store, sfPending[shop]);
        delete sfPending[shop];
        await db.writeDoc('sf_pending', sfPending);
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

// valida um token Storefront contra a própria loja. Com save=true (padrão), persiste.
async function validateAndSaveSfToken(store, token, { save = true } = {}) {
  token = String(token || '').trim();
  if (!token) {
    if (save) {
      const all = await loadSfTokens();
      if (all[store.id]) { delete all[store.id]; await db.writeDoc('storefront_tokens', all); }
    }
    return { ok: true, removed: true };
  }
  let r;
  try {
    r = await fetch(`https://${store.domain}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
      body: JSON.stringify({ query: '{ shop { name } }' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch { return { ok: false, error: `Sem resposta de ${store.domain} ao validar o token (rede/timeout).` }; }
  const txt = await r.text().catch(() => '');
  if (r.status === 401 || r.status === 403) {
    return { ok: false, error: 'A loja recusou esse token Storefront (401/403). Confira se copiou o "public access token" do canal Headless da loja de checkout.' };
  }
  if (!r.ok) return { ok: false, error: `A loja respondeu ${r.status} ao validar o token. ${txt.slice(0, 120)}` };
  let j; try { j = JSON.parse(txt); } catch { j = null; }
  if (!j || j.errors || !(j.data && j.data.shop)) return { ok: false, error: 'Token Storefront inválido para esta loja.' };
  if (save) await saveSfToken(store.id, token);
  return { ok: true, shop: j.data.shop.name };
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
// monta o carrinho com VÁRIAS linhas [{variantId, quantity}] e devolve o checkoutUrl
async function buildCheckoutUrlLines(store, lines) {
  const clean = (lines || []).filter((l) => l && l.variantId).map((l) => ({
    merchandiseId: `gid://shopify/ProductVariant/${l.variantId}`,
    quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
  }));
  if (!clean.length) throw new Error('Nenhum produto com variante para o carrinho.');
  const q = 'mutation cc($lines:[CartLineInput!]!){cartCreate(input:{lines:$lines}){cart{checkoutUrl} userErrors{field message}}}';
  const data = await storefrontRequest(store, q, { lines: clean });
  const ue = (data.cartCreate && data.cartCreate.userErrors) || [];
  if (ue.length) throw new Error(ue[0].message);
  const url = data.cartCreate && data.cartCreate.cart && data.cartCreate.cart.checkoutUrl;
  if (!url) throw new Error('A Storefront API não devolveu o checkoutUrl.');
  return url;
}
async function buildCheckoutUrl(store, variantId) {
  return buildCheckoutUrlLines(store, [{ variantId, quantity: 1 }]);
}

/* ---------- 1. o script que roda na loja do cliente ---------- */

function buildStorefrontScript(panelUrl, cfg, tracking) {
  const tk = tracking || {};
  // sem template literal aninhado: o script vai como texto puro para o navegador do cliente
  return `/* Painel Contingência — redirect vitrine → checkout */
(function () {
  var PANEL = ${JSON.stringify(panelUrl)};
  var MODE = ${JSON.stringify(cfg.mode)};
  var KEEP = ${JSON.stringify(!!cfg.keepParams)};
  var TRIGGER = ${JSON.stringify(cfg.trigger === 'load' ? 'load' : 'click')};
  var TRACK = ${JSON.stringify(!!tk.enabled)};
  var FBPX = ${JSON.stringify(tk.fbPixelId || '')};
  var GADS = ${JSON.stringify(tk.gadsId || '')};

  try {
    if (!window.Shopify || !window.Shopify.shop) return;
    if (window.top !== window.self) return;              // não redireciona dentro do editor de tema
    if (/\\/admin/.test(location.pathname)) return;

    var m = location.pathname.match(/\\/products\\/([^\\/?#]+)/);
    var handle = m ? m[1] : null;
    var ehCarrinho = /\\/cart/.test(location.pathname);
    var ehProdutoOuCarrinho = !!handle || ehCarrinho;     // modo "ao abrir" só age aqui; modo "ao clicar" age em QUALQUER página (home, coleção, produto em destaque, etc.)

    /* ---- Tracking na vitrine (Facebook Pixel + Google Ads) ----
       Configurado na aba Tracking do painel. Se o tema já tiver o Pixel
       (window.fbq existe), não inicializa de novo — evita evento duplicado.
       O gtag grava o gclid em cookie do domínio raiz, que o checkout
       (subdomínio) enxerga na hora da conversão. */
    function initTracking() {
      if (!TRACK) return;
      try {
        if (FBPX && !window.fbq) {
          !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
          fbq('init', FBPX);
          fbq('track', 'PageView');
          if (handle) fbq('track', 'ViewContent');
        }
        if (GADS) {
          window.dataLayer = window.dataLayer || [];
          window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
          if (!window.__pcGtagLoaded) {
            window.__pcGtagLoaded = 1;
            var gs = document.createElement('script');
            gs.async = true;
            gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + GADS;
            (document.head || document.documentElement).appendChild(gs);
            gtag('js', new Date());
          }
          gtag('config', GADS);
        }
      } catch (err) { /* tracking nunca quebra a loja */ }
    }
    initTracking();

    function trackCheckout() {
      try { if (TRACK && FBPX && window.fbq) fbq('track', 'InitiateCheckout'); } catch (err) {}
    }

    /* ---- presença pro Live View do painel (Visitantes agora / Sessões) ----
       Ping anônimo: só um id aleatório de sessão, sem nenhum dado do cliente.
       A localização aproximada vem do IP, lida pelos headers no servidor. */
    var SID = '';
    try {
      SID = sessionStorage.getItem('__pc_sid') || '';
      if (!SID) { SID = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('__pc_sid', SID); }
    } catch (e0) { SID = Math.random().toString(36).slice(2); }
    function beacon(ev) {
      try { fetch(PANEL + '/api/beacon?sid=' + SID + '&ev=' + ev + '&shop=' + encodeURIComponent(Shopify.shop), { credentials: 'omit', keepalive: true }); } catch (e1) {}
    }
    try {
      if (!sessionStorage.getItem('__pc_sv')) { sessionStorage.setItem('__pc_sv', '1'); beacon('view'); }
      else { beacon('beat'); }
    } catch (e2) { beacon('view'); }
    setInterval(function () { if (!document.hidden) beacon('beat'); }, 25000);
    // carrinho: escuta passiva (não bloqueia nada) do add-to-cart
    var BEACON_ADD = /(add to cart|adicionar ao carrinho|añadir al carrito)/i;
    window.addEventListener('click', function (e) {
      try {
        var t = e.target && e.target.closest ? e.target.closest('button, a, input[type="submit"], [role="button"]') : null;
        if (t && BEACON_ADD.test((t.textContent || t.value || ''))) beacon('cart');
      } catch (e3) {}
    }, true);
    window.addEventListener('submit', function (e) {
      try {
        var f = e.target;
        var a = f && f.getAttribute ? (f.getAttribute('action') || '') : '';
        if (/\\/cart\\/add/.test(a)) beacon('cart');
      } catch (e4) {}
    }, true);

    var qs = new URLSearchParams(location.search);
    if (qs.get('noredirect') === '1') return;             // atalho para você testar a vitrine

    var adParams = ['fbclid', 'gclid', 'ttclid', 'twclid', 'msclkid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    function readStoredParams() {
      try { return JSON.parse(localStorage.getItem('utmify_params') || '{}') || {}; } catch (e) { return {}; }
    }
    function setCookie(name, value, days) {
      try {
        var d = new Date();
        d.setTime(d.getTime() + (days || 30) * 24 * 60 * 60 * 1000);
        document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; expires=' + d.toUTCString();
      } catch (e) {}
    }
    function saveStoredParams(params) {
      try {
        localStorage.setItem('utmify_params', JSON.stringify(params));
      } catch (e) {}
      try {
        setCookie('utmify_params', JSON.stringify(params), 30);
      } catch (e) {}
    }
    function getParamsFromSearch() {
      var params = {};
      for (var i = 0; i < adParams.length; i++) {
        var key = adParams[i];
        if (qs.has(key)) params[key] = qs.get(key);
      }
      return params;
    }
    function mergeParams(base, extra) {
      var out = {};
      for (var key in base) if (base.hasOwnProperty(key) && base[key] != null && base[key] !== '') out[key] = base[key];
      for (var key in extra) if (extra.hasOwnProperty(key) && extra[key] != null && extra[key] !== '') out[key] = extra[key];
      return out;
    }
    function appendParams(url, params) {
      if (!params || Object.keys(params).length === 0) return url;
      try {
        var u = new URL(url, location.href);
        Object.keys(params).forEach(function (key) { u.searchParams.set(key, params[key]); });
        return u.toString();
      } catch (e) {
        var sep = url.indexOf('?') === -1 ? '?' : '&';
        return url + sep + new URLSearchParams(params).toString();
      }
    }

    var pageParams = getParamsFromSearch();
    if (Object.keys(pageParams).length) saveStoredParams(pageParams);
    var storedParams = readStoredParams();

    // modo "ads": só redireciona quem veio de anúncio
    if (MODE === 'ads') {
      var veioDeAnuncio = adParams.some(function (p) { return qs.has(p) || storedParams[p]; });
      if (!veioDeAnuncio) return;
    }

    function irPara(alvo) {
      if (!alvo) return;
      if (KEEP) {                       // leva utm/fbclid para a outra loja
        var params = mergeParams(storedParams, pageParams);
        if (Object.keys(params).length) alvo = appendParams(alvo, params);
      }
      location.replace(alvo);                              // replace: não suja o histórico
    }

    // monta a lista de itens: TODO o carrinho da vitrine (/cart.js) + o produto atual (buy-now).
    // Cada item vai como handle:quantidade:variantId — o variantId leva o VALOR escolhido pro checkout.
    function coletarItens() {
      var atualQty = 1;
      var qi = document.querySelector('form[action*="/cart/add"] [name="quantity"], input[name="quantity"]');
      if (qi && parseInt(qi.value, 10) > 0) atualQty = parseInt(qi.value, 10);
      var atualVid = null;
      var vi = document.querySelector('form[action*="/cart/add"] [name="id"]');
      if (vi && vi.value) atualVid = String(vi.value);
      return fetch('/cart.js', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cart) {
          var porVar = {};                                     // variantId → { handle, qty }
          if (cart && cart.items) cart.items.forEach(function (it) {
            var h = it.handle || (it.url ? (it.url.match(/\\/products\\/([^\\/?#]+)/) || [])[1] : null);
            var vid = it.variant_id || it.id;
            if (h && vid) { vid = String(vid); if (porVar[vid]) porVar[vid].qty += (it.quantity || 1); else porVar[vid] = { handle: h, qty: (it.quantity || 1) }; }
          });
          if (handle && atualVid && !porVar[atualVid]) porVar[atualVid] = { handle: handle, qty: atualQty };
          var arr = Object.keys(porVar).map(function (vid) { return porVar[vid].handle + ':' + porVar[vid].qty + ':' + vid; });
          if (!arr.length && handle) arr.push(handle + ':' + atualQty + (atualVid ? ':' + atualVid : ''));
          return arr.join(',');
        })
        .catch(function () { return handle ? (handle + ':' + atualQty + (atualVid ? ':' + atualVid : '')) : ''; });
    }

    function resolverAgora() {
      return coletarItens().then(function (items) {
        if (!items) return null;                             // carrinho vazio e fora de produto
        var u = PANEL + '/api/resolve?shop=' + encodeURIComponent(Shopify.shop) + '&items=' + encodeURIComponent(items);
        return fetch(u, { credentials: 'omit' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { return (d && d.url) ? d.url : null; })
          .catch(function () { return null; });
      });
    }

    if (TRIGGER === 'load') {
      if (!ehProdutoOuCarrinho) return;                   // "ao abrir" só redireciona em produto/carrinho (nunca a home inteira sozinha)
      resolverAgora().then(irPara);
      return;
    }

    // ----- modo "ao clicar em comprar" -----
    var bypass = false;

    function bloquear(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    function refazer(el) {                                  // nada mapeado: refaz a compra normal da loja
      bypass = true;
      try {
        if (el.tagName === 'A' && el.href) { location.href = el.href; return; }
        var form = el.closest ? el.closest('form') : null;
        if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); return; }
        el.click();
      } catch (err) { try { el.click(); } catch (e2) {} }
    }

    // CHAVE PRO 100%: bloqueia PRIMEIRO, depois resolve o carrinho INTEIRO (fresco)
    // e só então redireciona — assim leva todos os itens e nunca escapa pro checkout da vitrine.
    function decidir(refazerFn) {
      beacon('checkout'); // marca "No checkout" no Live View do painel
      resolverAgora().then(function (u) {
        if (!u) return refazerFn();
        trackCheckout();
        // espera curta pro beacon do InitiateCheckout sair antes de trocar de página
        setTimeout(function () { irPara(u); }, (TRACK && FBPX && window.fbq) ? 250 : 0);
      });
    }

    /* IMPORTANTE: "Adicionar ao carrinho" NÃO redireciona — deixa abrir o carrinho
       (drawer lateral) normalmente. O redirect acontece só no CHECKOUT / comprar agora.
       Assim o cliente monta o carrinho e, ao clicar em "Finalizar/Check out", vai pro
       checkout da loja de destino com todos os itens. Agnóstico de tema. */

    // seletores de CHECKOUT / comprar-agora (não inclui add-to-cart)
    var SELETOR = '.shopify-payment-button, .shopify-payment-button__button, [data-shopify="payment-button"],'
      + ' [name="checkout"], [id*="checkout" i], [class*="checkout" i],'
      + ' a[href*="/checkout"], a[href$="/cart"], [href*="/checkout"]';
    // texto de checkout / comprar-agora (NÃO "add to cart")
    var RE_CHECKOUT = /(check\\s?out|finalizar (compra|pedido|)|ir para o pagamento|comprar agora|buy it now|buy now|proceed to (checkout|pay))/i;
    var RE_ADD = /(add to cart|adicionar ao carrinho|añadir al carrito)/i;

    function alvoCheckout(t) {
      if (!t || !t.closest) return null;
      var b = t.closest('button, a, input[type="submit"], [role="button"]');
      if (!b) return null;
      var txt = (b.textContent || b.value || '').trim();
      if (RE_ADD.test(txt)) return null;                   // é "adicionar ao carrinho" → ignora
      try { if (b.closest(SELETOR)) return b; } catch (err) { /* seletor exótico */ }
      if (RE_CHECKOUT.test(txt)) return b;                 // reconhece "Check out"/"Finalizar" por texto
      var href = b.getAttribute && b.getAttribute('href');
      if (href && /\\/checkout/.test(href)) return b;
      return null;
    }

    /* listeners no WINDOW (capture): na captura o evento passa por window ANTES de
       document, então ganhamos de apps de checkout (ex.: Pagou Aí) que registram
       capture no document com stopImmediatePropagation — independente da ordem de load.
       Se nada estiver mapeado, refazer() re-dispara o clique e o app do tema segue como fallback. */
    window.addEventListener('click', function (e) {
      if (bypass) return;
      var el = alvoCheckout(e.target);
      if (!el) return;
      bloquear(e);                                         // bloqueia SEMPRE primeiro (não escapa)
      decidir(function () { refazer(el); });
    }, true);

    // checkout via <form> (ex.: form[action="/cart"] com botão name=checkout) — nunca /cart/add
    window.addEventListener('submit', function (e) {
      if (bypass) return;
      var form = e.target;
      if (!form || !form.matches) return;
      var act = (form.getAttribute && form.getAttribute('action')) || '';
      var ehCheckout = /\\/checkout/.test(act) || (/\\/cart(\\?|$|\\/)/.test(act) && !/\\/cart\\/add/.test(act));
      if (!ehCheckout) return;                             // add-to-cart passa direto (abre o drawer)
      bloquear(e);
      decidir(function () { bypass = true; if (form.requestSubmit) form.requestSubmit(); else form.submit(); });
    }, true);
  } catch (e) { /* nunca quebra a loja do cliente */ }
})();`;
}

// servido público (é o navegador do cliente que baixa)
app.get('/redirect.js', async (req, res) => {
  try {
    const cfg = await loadRedirectConfig();
    const tracking = await loadTrackingConfig();
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=60'); // curto: mudanças de config propagam rápido
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!cfg.enabled) return res.send('/* redirect desligado no painel */');
    res.send(buildStorefrontScript(appBaseUrl(req), cfg, tracking));
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

    const vitrineStore = stores.find((s) => s.id === f.vitrineId);
    if (!vitrineStore) return res.status(404).json({ error: 'Vitrine não configurada.' });
    const vitrineProducts = await cached(`products:${vitrineStore.id}`, 60000, () => fetchProducts(vitrineStore));
    const targetProducts = await cached(`products:${target.id}`, 60000, () => fetchProducts(target));
    const map = await loadProductMap();
    const bySku = suggestBySku(vitrineProducts, targetProducts);

    // itens a levar: carrinho da vitrine (items=handle:qtd:variantId,...) ou 1 produto (handle/product)
    let pedidos = [];
    if (req.query.items) {
      pedidos = String(req.query.items).split(',').map((s) => {
        const [h, q, vid] = s.split(':');
        return { handle: String(h || '').trim().toLowerCase(), qty: Math.max(1, parseInt(q, 10) || 1), vid: vid ? String(vid) : null };
      }).filter((x) => x.handle);
    } else if (handle) {
      pedidos = [{ handle: String(handle).toLowerCase(), qty: Math.max(1, parseInt(req.query.qty, 10) || 1), vid: req.query.variant ? String(req.query.variant) : null }];
    } else if (product) {
      const p = vitrineProducts.find((x) => String(x.id) === String(product));
      if (p) pedidos = [{ handle: p.handle, qty: 1, vid: null }];
    }
    if (!pedidos.length) return res.status(404).json({ error: 'Nenhum item informado.' });

    // escolhe no produto de checkout a variante com o MESMO valor da variante da vitrine
    function casarVariante(alvo, precoVitrine) {
      const vs = alvo.variantList || [];
      if (!vs.length) return alvo.variantId;
      if (precoVitrine != null) {
        const igual = (v) => Math.abs(v.price - precoVitrine) < 0.005;
        const exata = vs.find((v) => v.available && igual(v)) || vs.find(igual);
        if (exata) return exata.id;
        // sem preço igual: pega a variante mais próxima do valor
        const perto = vs.slice().sort((a, b) => Math.abs(a.price - precoVitrine) - Math.abs(b.price - precoVitrine))[0];
        if (perto) return perto.id;
      }
      return alvo.variantId || (vs.find((v) => v.available) || vs[0]).id;
    }

    // mapeia cada item da vitrine → produto+variante da loja de checkout (par manual, senão SKU)
    const lines = [];
    let primeiroAlvo = null;
    for (const it of pedidos) {
      const origem = vitrineProducts.find((p) => p.handle === it.handle);
      if (!origem) continue;
      // preço da variante escolhida na vitrine (pelo id) — senão o menor preço do produto
      let precoVitrine = origem.priceMin;
      if (it.vid && origem.variantList) {
        const vv = origem.variantList.find((v) => String(v.id) === it.vid);
        if (vv) precoVitrine = vv.price;
      }
      const alvoId = (map[target.id] || {})[String(origem.id)] || bySku[origem.id] || null;
      if (!alvoId) continue;
      const alvo = targetProducts.find((p) => String(p.id) === String(alvoId));
      if (!alvo) continue;
      const variantId = casarVariante(alvo, precoVitrine);
      if (!variantId) continue;
      if (!primeiroAlvo) primeiroAlvo = alvo;
      lines.push({ variantId, quantity: it.qty });
    }
    if (!lines.length) return res.status(404).json({ error: 'Nenhum item mapeado nesta loja de checkout.' });

    const productUrl = `https://${target.domain}/products/${primeiroAlvo.handle}`;
    let url = productUrl;
    let via = 'product';
    let warning = null;

    // checkout direto: monta o carrinho (com TODOS os itens) e manda pro pagamento
    if (cfg.destination === 'checkout') {
      try {
        url = await buildCheckoutUrlLines(target, lines);
        via = 'checkout';
      } catch (e) {
        via = 'product-fallback';
        warning = e.message;
      }
    }

    res.json({
      ok: true,
      via,
      warning,
      itens: lines.length,
      loja: { id: target.id, name: target.name, domain: target.domain },
      produto: { id: primeiroAlvo.id, title: primeiroAlvo.title, handle: primeiroAlvo.handle },
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
    const r = await validateAndSaveSfToken(store, (req.body || {}).token);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
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

/* ---------- Live View: presença da vitrine + agregado estilo Shopify ----------
 *
 * O redirect.js manda pings anônimos (/api/beacon) com um id de sessão:
 *  - 'view' 1x por sessão, 'beat' a cada ~25s, 'cart' ao adicionar, 'checkout' no clique.
 *  - A geolocalização vem dos headers da Vercel (x-vercel-ip-*), sem serviço externo.
 * O painel lê tudo agregado em /api/liveview: visitantes agora, sessões de hoje,
 * comportamento (carrinho/checkout/comprado), sessões por local e vendas do dia.
 */

const LIVE_PRESENCE_MIN = 5;   // "visitante agora" = ping nos últimos 5 min
const LIVE_FLAG_MIN = 20;      // carrinho/checkout contam por 20 min

app.get('/api/beacon', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sid = String(req.query.sid || '').replace(/[^\w-]/g, '').slice(0, 40);
    const ev = String(req.query.ev || 'beat');
    if (!sid) return res.status(204).end();
    const dec = (v) => { try { return decodeURIComponent(String(v || '')); } catch { return String(v || ''); } };
    const h = req.headers;
    const geo = {
      cc: String(h['x-vercel-ip-country'] || '').toUpperCase() || null,
      reg: dec(h['x-vercel-ip-country-region']) || null,
      city: dec(h['x-vercel-ip-city']) || null,
      lat: h['x-vercel-ip-latitude'] != null ? Number(h['x-vercel-ip-latitude']) : null,
      lng: h['x-vercel-ip-longitude'] != null ? Number(h['x-vercel-ip-longitude']) : null,
    };
    const nowMs = Date.now();
    const sess = (await db.readDoc('live_sessions', {})) || {};
    for (const k of Object.keys(sess)) if (nowMs - (sess[k].t || 0) > 30 * 60000) delete sess[k];
    const cur = sess[sid] || {};
    sess[sid] = {
      t: nowMs,
      cc: geo.cc || cur.cc || null,
      reg: geo.reg || cur.reg || null,
      city: geo.city || cur.city || null,
      lat: geo.lat != null && !Number.isNaN(geo.lat) ? geo.lat : (cur.lat != null ? cur.lat : null),
      lng: geo.lng != null && !Number.isNaN(geo.lng) ? geo.lng : (cur.lng != null ? cur.lng : null),
      cart: ev === 'cart' ? 1 : (cur.cart || 0),
      ck: ev === 'checkout' ? 1 : (cur.ck || 0),
    };
    await db.writeDoc('live_sessions', sess);

    if (ev === 'view') {
      const today = new Date().toISOString().slice(0, 10);
      let day = (await db.readDoc('live_day', {})) || {};
      if (day.day !== today) day = { day: today, count: 0, sids: {}, locs: {}, series: {} };
      if (!day.sids[sid]) {
        day.sids[sid] = 1;
        day.count = (day.count || 0) + 1;
        const lk = [geo.cc || '??', geo.reg || '', geo.city || ''].join('|');
        day.locs[lk] = (day.locs[lk] || 0) + 1;
        const bucket = Math.floor((nowMs - Date.parse(`${today}T00:00:00Z`)) / 1800000); // fatias de 30 min
        day.series[bucket] = (day.series[bucket] || 0) + 1;
        if (Object.keys(day.sids).length > 8000) day.sids = {}; // trava de tamanho — mantém só a contagem
        await db.writeDoc('live_day', day);
      }
    }
    res.status(204).end();
  } catch {
    res.status(204).end(); // beacon nunca devolve erro pro navegador do cliente
  }
});

app.get('/api/liveview', async (req, res) => {
  try {
    const { stores } = await selectStores(req);
    const now = new Date();
    const from = startOfDay(now);
    let orders = [];
    if (stores.length) {
      const key = `liveview:${stores.map((s) => s.id).join(',')}`;
      const results = await cached(key, 25000, () => collectOrders(stores, from, now));
      orders = results.flatMap((r) => r.orders);
    }
    orders.sort((a, b) => b.createdAt - a.createdAt);
    const m = sumMetrics(orders);
    const nowMs = Date.now();

    const sess = (await db.readDoc('live_sessions', {})) || {};
    const vivas = Object.values(sess);
    const ativas = vivas.filter((s) => nowMs - (s.t || 0) < LIVE_PRESENCE_MIN * 60000);
    const carts = vivas.filter((s) => s.cart && !s.ck && nowMs - (s.t || 0) < LIVE_FLAG_MIN * 60000).length;
    const inCheckout = vivas.filter((s) => s.ck && nowMs - (s.t || 0) < LIVE_FLAG_MIN * 60000).length;
    const purchased = orders.filter((o) => nowMs - o.createdAt.getTime() < 10 * 60000).length;

    const day = (await db.readDoc('live_day', {})) || {};
    const today = new Date().toISOString().slice(0, 10);
    const doDia = day.day === today;

    // vendas por produto (hoje)
    const prod = {};
    for (const o of orders) {
      for (const it of o.items) {
        const k = it.title || '—';
        if (!prod[k]) prod[k] = { title: k, qty: 0, value: 0 };
        prod[k].qty += it.qty;
        prod[k].value += it.qty * it.price;
      }
    }

    // novos × recorrentes (orders_count do cliente na hora do pedido)
    let novos = 0;
    let recorrentes = 0;
    for (const o of orders) {
      if (o.customerOrders == null) continue;
      if (o.customerOrders > 1) recorrentes++; else novos++;
    }

    const meiaHora = (d) => Math.floor((d.getTime() - from.getTime()) / 1800000);
    const salesSeries = {};
    const orderSeries = {};
    for (const o of orders) {
      const i = meiaHora(o.createdAt);
      salesSeries[i] = (salesSeries[i] || 0) + o.total;
      orderSeries[i] = (orderSeries[i] || 0) + 1;
    }

    res.json({
      visitorsNow: ativas.length,
      sessionsToday: doDia ? (day.count || 0) : 0,
      sales: m.sales,
      orders: m.orders,
      behavior: { carts, checkout: inCheckout, purchased },
      byLocation: Object.entries(doDia ? (day.locs || {}) : {})
        .map(([k, n]) => { const [cc, reg, city] = k.split('|'); return { cc, reg, city, sessions: n }; })
        .sort((a, b) => b.sessions - a.sessions).slice(0, 8),
      sessionSeries: doDia ? (day.series || {}) : {},
      salesSeries,
      orderSeries,
      newVsReturning: { novos, recorrentes },
      byProduct: Object.values(prod).sort((a, b) => b.value - a.value).slice(0, 8),
      orderPoints: orders.filter((o) => o.lat != null && o.lng != null).slice(0, 300)
        .map((o) => ({ lat: o.lat, lng: o.lng, t: o.createdAt.toISOString(), total: o.total, city: o.city, country: o.country, number: o.number })),
      visitorPoints: ativas.filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat, lng: s.lng, city: s.city || null })),
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
