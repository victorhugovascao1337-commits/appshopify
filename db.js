/*
 * Camada de persistência.
 *
 * - Com SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY definidos (Vercel), grava no Postgres
 *   do Supabase, na tabela `app_state` (key text pk, value jsonb).
 * - Sem eles (local), grava nos arquivos JSON em data/ — o comportamento de sempre.
 *
 * Os documentos são os mesmos JSON que o app já usava: stores, flow, automatch, postpurchase.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
const TABLE = 'app_state';

/* ---------- criptografia dos tokens (AES-256-GCM) ---------- */

function encKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) return null;
  // aceita hex de 64 chars ou qualquer texto (derivado por sha256)
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plain) {
  const key = encKey();
  if (!key || !plain) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${out.toString('base64')}`;
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value; // texto puro antigo
  const key = encKey();
  if (!key) throw new Error('ENCRYPTION_KEY ausente — não dá para ler os tokens criptografados.');
  const [, , iv, tag, data] = value.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/* ---------- driver: arquivos locais ---------- */

const FILES = {
  stores: 'stores.json',
  flow: 'flow.json',
  automatch: 'automatch.json',
  postpurchase: 'postpurchase.json',
};

function fileRead(key, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, FILES[key]), 'utf8'));
  } catch {
    return fallback;
  }
}

function fileWrite(key, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, FILES[key]), JSON.stringify(value, null, 2));
}

/* ---------- driver: Supabase (PostgREST, sem dependência extra) ---------- */

async function sbRequest(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  if (!text) return null; // 201/204 com return=minimal vêm sem corpo
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function sbRead(key, fallback) {
  const rows = await sbRequest(`${TABLE}?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows && rows.length ? rows[0].value : fallback;
}

async function sbWrite(key, value) {
  await sbRequest(TABLE, {
    method: 'POST',
    body: [{ key, value, updated_at: new Date().toISOString() }],
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

/* ---------- API pública ---------- */

async function readDoc(key, fallback) {
  return USE_SUPABASE ? sbRead(key, fallback) : fileRead(key, fallback);
}

async function writeDoc(key, value) {
  return USE_SUPABASE ? sbWrite(key, value) : fileWrite(key, value);
}

// tokens ficam criptografados no banco; o resto do app segue vendo texto puro
async function readStores() {
  const raw = await readDoc('stores', []);
  return (Array.isArray(raw) ? raw : []).map((s) => ({ ...s, token: decrypt(s.token) }));
}

async function writeStores(stores) {
  await writeDoc('stores', stores.map((s) => ({ ...s, token: encrypt(s.token) })));
}

async function ping() {
  if (!USE_SUPABASE) return { driver: 'files', ok: true };
  await sbRequest(`${TABLE}?select=key&limit=1`);
  return { driver: 'supabase', ok: true };
}

module.exports = {
  USE_SUPABASE,
  hasEncryptionKey: () => !!encKey(),
  readDoc,
  writeDoc,
  readStores,
  writeStores,
  encrypt,
  decrypt,
  ping,
};
