/* =========================================================
 * storage.js —— 数据访问层
 *
 * 现在用 PostgreSQL（通过后端 API）+ LocalStorage 兜底缓存。
 * 设计目标仍是：把"数据从哪里来"统一收口在这一层。
 * 对外 async 接口保持不变，上层业务代码（app.js）无需改动。
 *
 * 存储策略：
 *  - 读取：优先读后端 API（PostgreSQL）。失败则回退 LocalStorage，保证离线/服务器异常时页面仍可用。
 *  - 写入：先同步落地 LocalStorage（保证 UI 不阻塞），再异步写后端。
 *  - 因此「清空浏览器缓存」后，下次打开会从 PostgreSQL 重新拉取数据，不再丢失。
 *  - 首次打开若本机 LocalStorage 有旧数据而 PG 为空，会自动上传一次（migrateFromLocalIfNeeded）。
 * ========================================================= */

const DB = (function () {
  const KEYS = {
    themes: 'zhutian.themes',
    current: 'zhutian.current',     // 当前进行中的挑战
    history: 'zhutian.history',     // 历史挑战记录
    settings: 'zhutian.settings',   // 系统设置
    seeded: 'zhutian.seeded',       // 是否已初始化过默认数据
    cyclePool: 'zhutian.cyclePool', // 不重复抽取：本轮已完成主题 id 池
  };

  // 后端 API 基地址（与静态站点同域，避免跨域）。可用 <meta name="td-api-base"> 覆盖。
  const API_BASE =
    (document.querySelector('meta[name="td-api-base"]') &&
      document.querySelector('meta[name="td-api-base"]').content) ||
    '/theme-day-api';
  const TOKEN = 'd9f1a3b17e70874198830f14b494886c5301c83b0fa9b323';

  // ---------- LocalStorage 兜底 ----------
  function localRead(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function localWrite(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 隐私模式等场景下 setItem 可能抛错，忽略 */
    }
  }

  // ---------- 后端 API ----------
  async function apiGet(key, fallback) {
    const r = await fetch(
      `${API_BASE}/api/state?key=${encodeURIComponent(key)}`,
      { headers: { 'x-td-token': TOKEN } }
    );
    if (!r.ok) throw new Error('api get ' + r.status);
    const j = await r.json();
    return j.value === null || j.value === undefined ? fallback : j.value;
  }
  async function apiSet(key, value) {
    const r = await fetch(`${API_BASE}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-td-token': TOKEN },
      body: JSON.stringify({ key, value }),
    });
    if (!r.ok) throw new Error('api set ' + r.status);
  }
  async function apiDelete(key) {
    const r = await fetch(
      `${API_BASE}/api/state?key=${encodeURIComponent(key)}`,
      { method: 'DELETE', headers: { 'x-td-token': TOKEN } }
    );
    if (!r.ok) throw new Error('api delete ' + r.status);
  }

  // ---------- 统一读写（PG 优先，LocalStorage 兜底） ----------
  async function read(key, fallback) {
    try {
      const v = await apiGet(key, fallback);
      localWrite(key, v); // 缓存到本地，供离线/异常时回退
      return v;
    } catch (e) {
      console.warn('[DB] 读取后端失败，回退 LocalStorage：', key, e);
      return localRead(key, fallback);
    }
  }
  async function write(key, value) {
    localWrite(key, value); // 本地即时落地，UI 不阻塞
    try {
      await apiSet(key, value);
    } catch (e) {
      console.warn('[DB] 写入后端失败，仅本地保存：', key, e);
    }
  }

  // 首次迁移：本机 LocalStorage 有数据而 PG 为空时，自动上传
  let migrated = false;
  async function migrateFromLocalIfNeeded() {
    if (migrated) return;
    migrated = true;
    for (const k of Object.values(KEYS)) {
      const local = localRead(k, null);
      if (local === null) continue;
      try {
        const remote = await apiGet(k, null);
        if (remote === null) await apiSet(k, local);
      } catch (e) {
        /* 单条失败不影响其余 */
      }
    }
  }

  return {
    KEYS,
    migrateFromLocalIfNeeded,

    /* ---------- 主题库 ---------- */
    async getThemes() {
      return read(KEYS.themes, []);
    },
    async saveThemes(themes) {
      return write(KEYS.themes, themes);
    },

    /* ---------- 当前进行中的挑战 ---------- */
    async getCurrentChallenge() {
      return read(KEYS.current, null);
    },
    async setCurrentChallenge(challenge) {
      return write(KEYS.current, challenge);
    },

    /* ---------- 历史挑战 ---------- */
    async getHistory() {
      return read(KEYS.history, []);
    },
    async saveHistory(history) {
      return write(KEYS.history, history);
    },

    /* ---------- 系统设置 ---------- */
    async getSettings() {
      const s = await read(KEYS.settings, null);
      return s || { maxRedraws: 3 };
    },
    async saveSettings(settings) {
      return write(KEYS.settings, settings);
    },

    /* ---------- 不重复抽取：已完成主题 id 池 ---------- */
    async getCyclePool() {
      return read(KEYS.cyclePool, []);
    },
    async setCyclePool(arr) {
      return write(KEYS.cyclePool, arr);
    },

    /* ---------- 初始化标记 ---------- */
    async isSeeded() {
      return read(KEYS.seeded, false);
    },
    async setSeeded(v) {
      return write(KEYS.seeded, v);
    },

    /* ---------- 批量导入（备份还原）：直接写后端 ---------- */
    async importAll(data) {
      if (!data || typeof data !== 'object') return;
      // 本地先落一份，保证即时可用
      for (const [k, v] of Object.entries(data)) localWrite(k, v);
      try {
        const r = await fetch(`${API_BASE}/api/import`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-td-token': TOKEN },
          body: JSON.stringify({ data }),
        });
        if (!r.ok) throw new Error('import ' + r.status);
      } catch (e) {
        console.warn('[DB] 批量导入后端失败，仅本地保存', e);
      }
    },

    /* ---------- 清空所有数据（设置页用） ---------- */
    async clearAll() {
      for (const k of Object.values(KEYS)) {
        try { localStorage.removeItem(k); } catch (e) {}
        try { await apiDelete(k); } catch (e) {}
      }
    },
  };
})();
