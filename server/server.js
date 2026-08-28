const express = require('express');
const { Pool } = require('pg');

const PORT = 8090;
const HOST = '127.0.0.1';
// 共享令牌：前后端共用，放在 HTTP 头 x-td-token，仅作基本防护（个人工具）
const TOKEN = process.env.TD_TOKEN || 'd9f1a3b17e70874198830f14b494886c5301c83b0fa9b323';

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  user: 'theme_day',
  password: process.env.PGPASS || '59933204ae9a26c887a383d20b800525',
  database: 'theme_day',
  max: 5,
});

const app = express();
app.use(express.json({ limit: '5mb' }));

// 简单共享令牌保护
app.use((req, res, next) => {
  if (req.headers['x-td-token'] !== TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// 单用户固定 uid（多设备共享同一份数据）
const UID = 'theme-day-user';

async function getVal(key) {
  const r = await pool.query('SELECT value_json FROM state WHERE uid=$1 AND key=$2', [UID, key]);
  if (!r.rows.length) return null;
  try { return JSON.parse(r.rows[0].value_json); } catch (e) { return null; }
}

const upsert = (key, value) => pool.query(
  `INSERT INTO state(uid,key,value_json,updated_at) VALUES($1,$2,$3,now())
   ON CONFLICT(uid,key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=now()`,
  [UID, key, JSON.stringify(value)]
);

app.get('/api/state', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    const value = await getVal(key);
    res.json({ value: value === undefined ? null : value });
  } catch (e) {
    console.error('[GET /api/state]', e);
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/api/state', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await upsert(key, value);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/state]', e);
    res.status(500).json({ error: 'db error' });
  }
});

app.delete('/api/state', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await pool.query('DELETE FROM state WHERE uid=$1 AND key=$2', [UID, key]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/state]', e);
    res.status(500).json({ error: 'db error' });
  }
});

// 批量导入：data 为 {key: value} 对象
app.post('/api/import', async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data required' });
  try {
    for (const [k, v] of Object.entries(data)) {
      await upsert(k, v);
    }
    res.json({ ok: true, count: Object.keys(data).length });
  } catch (e) {
    console.error('[POST /api/import]', e);
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/api/status', (req, res) => res.json({ ok: true }));

app.listen(PORT, HOST, () => {
  console.log('theme-day-api listening on ' + HOST + ':' + PORT);
});
