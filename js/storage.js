/* =========================================================
 * storage.js —— 数据访问层（LocalStorage 实现）
 *
 * 设计目标：把"数据从哪里来"统一收口在这一层。
 * 现在用浏览器 LocalStorage；将来若接入后端数据库，
 * 只需把下面每个方法的内部实现换成 fetch / 数据库调用，
 * 对外 async 接口保持不变，上层业务代码无需改动。
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

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('读取本地数据失败：', key, e);
      return fallback;
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  return {
    /* ---------- 主题库 ---------- */
    async getThemes() {
      return read(KEYS.themes, []);
    },
    async saveThemes(themes) {
      write(KEYS.themes, themes);
    },

    /* ---------- 当前进行中的挑战 ---------- */
    async getCurrentChallenge() {
      return read(KEYS.current, null);
    },
    async setCurrentChallenge(challenge) {
      if (challenge) write(KEYS.current, challenge);
      else localStorage.removeItem(KEYS.current);
    },

    /* ---------- 历史挑战 ---------- */
    async getHistory() {
      return read(KEYS.history, []);
    },
    async saveHistory(history) {
      write(KEYS.history, history);
    },

    /* ---------- 系统设置 ---------- */
    async getSettings() {
      const s = read(KEYS.settings, null);
      return s || { maxRedraws: 3 };
    },
    async saveSettings(settings) {
      write(KEYS.settings, settings);
    },

    /* ---------- 不重复抽取：已完成主题 id 池 ---------- */
    async getCyclePool() {
      return read(KEYS.cyclePool, []);
    },
    async setCyclePool(arr) {
      write(KEYS.cyclePool, arr);
    },

    /* ---------- 初始化标记 ---------- */
    async isSeeded() {
      return read(KEYS.seeded, false);
    },
    async setSeeded(v) {
      write(KEYS.seeded, v);
    },

    /* ---------- 清空所有本地数据（设置页用） ---------- */
    async clearAll() {
      Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
    },
  };
})();
