/* =========================================================
 * app.js —— 主题天 应用主逻辑
 * 视图：首页 / 主题管理 / 历史 / 设置
 * 数据：通过 DB（storage.js）访问，方便后续切换到后端
 * ========================================================= */
(function () {
  'use strict';

  /* -------------------- 全局状态 -------------------- */
  let themes = [];
  let history = [];
  let settings = { maxRedraws: 3 };
  let current = null;               // 当前进行中的挑战
  let themeFilter = 'all';
  let themeSearch = '';
  let confirmCallback = null;       // 二次确认回调
  let reasonPresets = null;         // 原因模式下的预设数组（null=关闭）
  let reasonIndex = 0;              // 当前预设原因下标

  // 提前结束可切换的预设原因
  const DEFAULT_END_REASONS = [
    '临时有事，先暂停一下',
    '这阵子状态不太对',
    '主题不太适合最近的生活节奏',
    '时间排不开，下次再来',
    '想换个别的小目标试试',
    '最近忙别的，先到这儿',
  ];

  let pendingMoodDate = null;        // 当前正在记心情的日期
  let moodIndex = 0;                 // 当前预设心情下标
  const DEFAULT_MOODS = [
    '今天状态不错 ☀️',
    '慢慢来，比较快',
    '有点累，但坚持了',
    '心情平静，挺好',
    '小确幸的一天',
    '尽力就好，不勉强',
    '今天很开心 🌿',
    '专注当下的感觉真好',
  ];

  /* -------------------- 小工具 -------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function uid(prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* -------------------- 日期工具（本地日期，YYYY-MM-DD） -------------------- */
  function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function todayStr() { return toISO(new Date()); }
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDaysISO(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return toISO(d); }
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
  function fmtCN(s) { const [, m, d] = s.split('-'); return `${Number(m)}月${Number(d)}日`; }
  function fmtDot(s) { const [, m, d] = s.split('-'); return `${m}.${d}`; }

  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  /* -------------------- 完成时的随机鼓励语 -------------------- */
  const ENCOURAGE = [
    '今天也很棒呀 ✦',
    '又坚持了一天～',
    '小目标达成，给自己鼓个掌 👏',
    '稳稳的，继续保持',
    '今天的你很可靠',
    '积少成多，今天也是一步',
    '完成啦，轻松一下吧 ☁️',
    '生活的小仪式，get ✓',
  ];
  function randomEncourage() { return ENCOURAGE[randInt(0, ENCOURAGE.length - 1)]; }

  /* -------------------- Toast 轻提示 -------------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 250);
    }, 1600);
  }

  /* -------------------- 二次确认弹窗 -------------------- */
  function showConfirm(text, onOk, opts = {}) {
    $('#confirm-text').textContent = text;
    confirmCallback = onOk;
    const wrap = $('#confirm-reason-wrap');
    if (opts && opts.reason) {
      reasonPresets = (opts.presets && opts.presets.length) ? opts.presets : DEFAULT_END_REASONS;
      reasonIndex = 0;
      $('#confirm-reason-input').value = reasonPresets[0];
      wrap.hidden = false;
    } else {
      reasonPresets = null;
      wrap.hidden = true;
    }
    $('#confirm-modal').hidden = false;
  }
  function closeConfirm() {
    $('#confirm-modal').hidden = true;
    confirmCallback = null;
    reasonPresets = null;
  }

  /* -------------------- 初始化 -------------------- */
  async function ensureSeed() {
    if (await DB.isSeeded()) {
      // 老数据兼容：为缺失 id 的主题补一个稳定 id
      // （否则下面"不重复抽取池"用 theme.id 匹配时会全部落空，导致已完成的主题又被抽回来）
      const list = await DB.getThemes();
      if (Array.isArray(list) && list.length) {
        let changed = false;
        const fixed = list.map((t) => {
          if (t && t.id) return t;
          changed = true;
          return { ...t, id: uid('t') };
        });
        if (changed) await DB.saveThemes(fixed);
      }
      return;
    }
    const seeded = DEFAULT_THEMES.map((t) => ({ id: uid('t'), createdAt: new Date().toISOString(), ...t }));
    await DB.saveThemes(seeded);
    await DB.setSeeded(true);
  }

  // 加载/刷新全部状态（不绑定事件，避免重复监听）
  async function loadState() {
    await ensureSeed();
    settings = await DB.getSettings();
    themes = await DB.getThemes();
    history = await DB.getHistory();
    // 老数据兼容：为缺失 id 的历史记录补一个稳定 id
    // （否则删除时用 id 匹配会全部落空，导致点删除无反应）
    if (Array.isArray(history) && history.length) {
      let changed = false;
      const fixed = history.map((h) => {
        if (h && h.id) return h;
        changed = true;
        return { ...h, id: uid('h') };
      });
      if (changed) { history = fixed; await DB.saveHistory(history); }
    }
    let cur = await DB.getCurrentChallenge();
    if (cur && todayStr() > cur.endDate) {
      await finalizeChallenge(cur, 'completed');
      cur = null;
    }
    current = cur;
  }

  async function init() {
    try {
      await DB.migrateFromLocalIfNeeded(); // 首次：本机旧 LocalStorage 数据上传到 PostgreSQL
    } catch (e) {
      console.warn('[init] 本地迁移到 PG 失败（可忽略，后续读写会自动同步）', e);
    }
    try {
      await loadState();
      bindEvents();
      switchView('home');
    } catch (e) {
      console.error('[init] 出错', e);
      try { bindEvents(); } catch (_) {}
      try { switchView('home'); } catch (_) {}
    }
    // 注意：不再注册 Service Worker。旧版 cache-first SW 会导致「改了不生效」死锁，
    // 已由 index.html 内联脚本强制注销，本项目纯静态无需离线缓存。

    // 安全网 1：500ms 后检查，首页为空则立即重渲染
    setTimeout(() => { ensureHomeRendered(); }, 500);
    // 安全网 2：1.5s 后再次检查（应对 SW controllerchange 刷新打断首次渲染）
    setTimeout(() => { ensureHomeRendered(); }, 1500);
    // 安全网 3：页面从后台切回前台时，首页为空则重渲染
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) setTimeout(() => { ensureHomeRendered(); }, 100);
    });
  }

  /** 确保 #home-body 有内容，没有就重新渲染 */
  function ensureHomeRendered() {
    const body = $('#home-body');
    if (!body) return;
    const html = (body.innerHTML || '').trim();
    if (!html || html.length < 20) {
      console.warn('[安全网] 首页内容为空，强制 renderHome');
      try { switchView('home'); } catch (_) {}
    }
  }

  /* -------------------- PWA：Service Worker（离线缓存，无推送） -------------------- */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') {
      // file:// 下 Service Worker 不可用，需通过本地服务器或部署访问
      console.info('[PWA] file:// 下离线缓存不可用，请用本地服务器或部署访问');
      return;
    }
    navigator.serviceWorker.register('./sw.js').then(
      () => console.info('[PWA] Service Worker 已注册，支持离线 / 添加到主屏幕'),
      (err) => console.warn('[PWA] Service Worker 注册失败', err)
    );
    // 当新版本的 Service Worker 接管页面时，稍等首次渲染完成后再刷新一次，
    // 避免「SW 已更新但页面仍显示旧缓存资源」的残留（尤其旧版 cache-first 的死锁）。
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      // 延迟 300ms 让当前页面的首次渲染完成后再刷新
      setTimeout(() => { location.reload(); }, 300);
    });
  }

  /* -------------------- 挑战结束 → 写入历史 -------------------- */
  async function finalizeChallenge(challenge, status, reason) {
    const doneDays = Object.values(challenge.completions || {}).filter((c) => c.done).length;
    const planned = challenge.duration;
    const rate = planned ? Math.round((doneDays / planned) * 100) : 0;
    const record = {
      id: challenge.id,
      themeName: challenge.theme.name,
      emoji: challenge.theme.emoji,
      color: challenge.theme.color,
      startDate: challenge.startDate,
      endDate: challenge.endDate,
      plannedDays: planned,
      doneDays,
      rate,
      status, // 'completed' | 'ended_early'
      endReason: (reason || '').toString().trim(),
      completedDates: Object.keys(challenge.completions || {}).filter(
        (k) => challenge.completions[k] && challenge.completions[k].done
      ),
      finishedAt: new Date().toISOString(),
    };
    // 自然完成（非提前结束）且用户确实完成过至少一天的主题，才放入不重复抽取池
    // （只让"真的做过"的主题休息，轮完一圈再重来；0 天完成的视为没做，可再被抽到）
    if (status === 'completed' && doneDays > 0 && challenge.theme && challenge.theme.id) {
      const pool = await DB.getCyclePool();
      if (!pool.includes(challenge.theme.id)) {
        pool.push(challenge.theme.id);
        await DB.setCyclePool(pool);
      }
    }
    history = await DB.getHistory();
    history.push(record);
    await DB.saveHistory(history);
    await DB.setCurrentChallenge(null);
    current = null;
  }

  /* -------------------- 计算当前挑战的天数信息 -------------------- */
  function dayInfo(ch) {
    const diff = Math.min(Math.max(daysBetween(ch.startDate, todayStr()), 0), ch.duration - 1);
    const currentDay = diff + 1;
    const remaining = ch.duration - diff; // 含今天
    const doneDays = Object.values(ch.completions || {}).filter((c) => c.done).length;
    return { currentDay, remaining, doneDays, diff };
  }

  /* ============================================================
   * 首页
   * ============================================================ */
  function renderHome() {
    const body = $('#home-body');
    try {
      if (!current) {
        body.innerHTML = `
          <div class="empty-card">
            <div class="empty-emoji">🐰</div>
            <h2>今天还没有主题</h2>
            <p>给生活安排一个小目标吧</p>
            <button class="btn btn-primary btn-block" data-action="draw">抽一个主题</button>
          </div>` + safeHeatmap();
        return;
      }
      body.innerHTML = buildActiveCard(current) + safeHeatmap();
    } catch (e) {
      console.error('[renderHome] 异常兜底', e);
      try {
        body.innerHTML = `<div class="empty-card"><div class="empty-emoji">🐰</div><h2>今天还没有主题</h2><p>给生活安排一个小目标吧</p><button class="btn btn-primary btn-block" data-action="draw">抽一个主题</button></div>`;
      } catch (_) {}
    }
  }

  /** 热力图独立 try/catch：即使出错也不影响首页主体渲染 */
  function safeHeatmap() {
    try { return renderHeatmap(); }
    catch (e) { console.error('[renderHeatmap] 异常', e); return ''; }
  }

  function buildActiveCard(ch) {
    const info = dayInfo(ch);
    const t = ch.theme;
    const today = todayStr();
    const doneToday = !!(ch.completions[today] && ch.completions[today].done);

    // 本轮进度：今天与往日可点击补卡/取消，未来不可改
    let rows = '';
    for (let i = 0; i < ch.duration; i++) {
      const date = addDaysISO(ch.startDate, i);
      const done = !!(ch.completions[date] && ch.completions[date].done);
      const isToday = date === today;
      const isFuture = date > today;
      let cls = 'round-dot', rowCls = 'round-row', label = '未到', action = '';
      if (done) { cls += ' done'; label = '已完成'; }
      else if (isToday) { cls += ' today'; label = '今天'; }
      else if (isFuture) { label = '未到'; }
      else { label = '未完成'; }
      const clickable = !isFuture;
      if (clickable) rowCls += ' clickable';
      if (clickable) action = done ? '取消' : (isToday ? '完成' : '补卡');
      const mood = (done && ch.completions[date] && ch.completions[date].mood) ? ch.completions[date].mood : '';
      rows += `<div class="${rowCls}"${clickable ? ` data-action="toggle-day" data-date="${date}"` : ''}>
        <span class="${cls}"></span>
        <span class="round-date">${fmtCN(date)}</span>
        <span class="round-label">${label}</span>
        ${action ? `<span class="round-action">${action}</span>` : ''}
        ${mood ? `<div class="mood-note">💭 ${esc(mood)}</div>` : ''}
      </div>`;
    }

    const canRedraw = ch.redrawCount < settings.maxRedraws;
    const redrawLeft = settings.maxRedraws - ch.redrawCount;
    const redrawTimesCN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const redrawLeftCN = redrawLeft >= 0 && redrawLeft <= 10 ? redrawTimesCN[redrawLeft] : String(redrawLeft);

    const doneBtn = doneToday
      ? `<button class="btn btn-done btn-block pop" disabled>✓ 今日已完成</button>`
      : `<button class="btn btn-primary btn-block" data-action="complete">今日完成</button>`;

    const redrawBtn = canRedraw
      ? `<button class="btn btn-pill" data-action="redraw">↻ 换一个</button>
         <span class="redraw-left">还有 ${redrawLeftCN} 次轮换机会</span>`
      : '';

    return `
      <div class="theme-card" style="border-left:6px solid ${esc(t.color)}">
        <div class="deco">${esc(t.emoji)}</div>
        <span class="emoji">${esc(t.emoji)}</span>
        <div class="label">今天的主题</div>
        <h2 class="name">${esc(t.name)}</h2>
        <p class="intro">${esc(t.intro)}</p>

        <div class="goal-box">
          <span class="goal-tag">今日必须完成</span>
          <span class="goal-text">${esc(t.goal)}</span>
        </div>

        <div class="day-info">
          <div class="day-pill"><div class="num">${info.currentDay}<span style="font-size:13px;color:var(--text2)"> / ${ch.duration}</span></div><div class="cap">第几天</div></div>
          <div class="day-pill"><div class="num">${info.remaining}</div><div class="cap">剩余天数</div></div>
        </div>

        <div class="progress-wrap">
          <div class="progress-meta"><span>完成进度</span><span>${info.doneDays} / ${ch.duration} 天</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.round((info.doneDays / ch.duration) * 100)}%;background:${esc(t.color)}"></div></div>
        </div>

        <div class="round-progress">${rows}</div>
        ${info.currentDay > 1 ? `<p class="round-hint">漏打卡了？点上面的往日可以补卡 / 取消 ✦</p>` : ''}

        <div class="card-actions">
          ${doneBtn}
          <div class="row-actions">
            ${redrawBtn}
            <button class="btn btn-text" data-action="end-early">提前结束</button>
          </div>
        </div>

        <div class="date-foot">${fmtDot(ch.startDate)} ～ ${fmtDot(ch.endDate)}</div>
      </div>`;
  }

  /* -------------------- 首页打卡热力图（当月日历） -------------------- */
  function collectCheckinDates() {
    const set = new Set();
    // 当前进行中挑战的逐日打卡
    if (current && current.completions) {
      Object.keys(current.completions).forEach((k) => {
        if (current.completions[k] && current.completions[k].done) set.add(k);
      });
    }
    // 历史记录（新记录含 completedDates；老记录无此字段则跳过，不点亮）
    history.forEach((h) => {
      (h.completedDates || []).forEach((d) => set.add(d));
    });
    return set;
  }

  function renderHeatmap() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const todayISO = todayStr();
    const checkins = collectCheckinDates();

    const first = new Date(y, m, 1);
    const startWeekday = (first.getDay() + 6) % 7; // 周一为一周起点
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const weekHead = ['一', '二', '三', '四', '五', '六', '日'];
    let monthDone = 0;
    const cellHTML = cells.map((iso) => {
      if (!iso) return '<span class="hm-cell empty"></span>';
      const on = checkins.has(iso);
      if (on) monthDone++;
      const isToday = iso === todayISO;
      const cls = 'hm-cell' + (on ? ' on' : '') + (isToday ? ' today' : '');
      return `<span class="${cls}">${Number(iso.slice(8, 10))}</span>`;
    }).join('');

    return `
      <div class="heatmap">
        <div class="hm-head">
          <span class="hm-title">${y}年${m + 1}月 · 打卡日历</span>
          <span class="hm-stat">本月 ${monthDone} 天 · 累计 ${checkins.size} 天</span>
        </div>
        <div class="hm-week">${weekHead.map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="hm-grid">${cellHTML}</div>
        <div class="hm-legend"><span class="hm-dot"></span>打过卡的日子</div>
      </div>`;
  }

  /* -------------------- 抽主题（带动画） -------------------- */
  async function drawTheme() {
    const enabled = themes.filter((t) => t.enabled);
    if (enabled.length === 0) {
      toast('请先在「主题」里启用至少一个主题');
      return;
    }
    const pool = (await DB.getCyclePool()).filter(Boolean); // 清掉历史残留的空值
    let eligible = enabled.filter((t) => t.id && !pool.includes(t.id));
    if (eligible.length === 0) {
      // 所有主题都已完成过一轮，重置后重新开始
      eligible = enabled.slice();
      await DB.setCyclePool([]);
    }
    const chosen = eligible[randInt(0, eligible.length - 1)];
    const duration = randInt(3, 7);
    runDrawAnimation(chosen, duration, eligible);
  }

  function runDrawAnimation(chosen, duration, enabledPool) {
    const body = $('#home-body');
    body.innerHTML = `
      <div class="draw-card">
        <div class="draw-hint">正在抽取今天的主题…</div>
        <div class="draw-emoji" id="draw-emoji">🎲</div>
        <div class="draw-name" id="draw-name">？</div>
      </div>`;
    const emojiEl = $('#draw-emoji');
    const nameEl = $('#draw-name');

    let ticks = 0;
    const total = 11; // 约 0.8s
    const timer = setInterval(() => {
      ticks++;
      const r = enabledPool[randInt(0, enabledPool.length - 1)];
      emojiEl.textContent = r.emoji;
      nameEl.textContent = r.name;
      nameEl.classList.remove('flip');
      void nameEl.offsetWidth;
      nameEl.classList.add('flip');
      if (ticks >= total) {
        clearInterval(timer);
        // 停在最终结果
        emojiEl.textContent = chosen.emoji;
        nameEl.textContent = chosen.name;
        setTimeout(() => startChallenge(chosen, duration), 450);
      }
    }, 70);
  }

  async function startChallenge(theme, duration) {
    const start = todayStr();
    const challenge = {
      id: uid('c'),
      theme: {
        id: theme.id,
        name: theme.name, emoji: theme.emoji, color: theme.color,
        intro: theme.intro, goal: theme.goal, tips: theme.tips || '',
      },
      startDate: start,
      duration,
      endDate: addDaysISO(start, duration - 1),
      redrawCount: 0,
      status: 'active',
      completions: {},
      createdAt: new Date().toISOString(),
    };
    await DB.setCurrentChallenge(challenge);
    current = challenge;
    renderHome();
    toast(`接下来的 ${duration} 天都是「${theme.name}」`);
  }

  async function redrawTheme() {
    if (!current) return;
    if (current.redrawCount >= settings.maxRedraws) {
      toast('本轮已达到换主题次数上限');
      return;
    }
    const enabled = themes.filter((t) => t.enabled);
    if (enabled.length === 0) { toast('没有可抽取的主题'); return; }
    const pool = (await DB.getCyclePool()).filter(Boolean);
    let eligible = enabled.filter((t) => t.id && !pool.includes(t.id));
    if (eligible.length === 0) { eligible = enabled.slice(); await DB.setCyclePool([]); }
    // 换一个时避免又抽到当前这一个
    let pickFrom = eligible.filter((t) => t.id !== (current.theme.id || null));
    if (pickFrom.length === 0) pickFrom = eligible;
    const chosen = pickFrom[randInt(0, pickFrom.length - 1)];
    const duration = randInt(3, 7);
    current.redrawCount += 1;
    current.theme = {
      id: chosen.id,
      name: chosen.name, emoji: chosen.emoji, color: chosen.color,
      intro: chosen.intro, goal: chosen.goal, tips: chosen.tips || '',
    };
    current.duration = duration;
    current.startDate = todayStr();
    current.endDate = addDaysISO(current.startDate, duration - 1);
    current.completions = {};
    await DB.setCurrentChallenge(current);
    renderHome();
    toast(`已换成「${chosen.name}」，还有 ${settings.maxRedraws - current.redrawCount} 次轮换机会`);
  }

  async function completeToday() {
    if (!current) return;
    const today = todayStr();
    if (current.completions[today] && current.completions[today].done) {
      toast('今天已经打过勾啦');
      return;
    }
    current.completions[today] = { done: true, time: new Date().toISOString() };
    await DB.setCurrentChallenge(current);
    renderHome();
    const btn = $('.btn-done');
    if (btn) { btn.classList.add('pop'); }
    toast(randomEncourage());
    askMood(today);
  }

  /* 点击进度里的某一天：今天/往日可补卡或取消，未来不可改 */
  async function toggleDay(date) {
    if (!current) return;
    if (date > todayStr()) return; // 未来不允许
    const wasDone = !!(current.completions[date] && current.completions[date].done);
    if (wasDone) {
      current.completions[date] = { done: false, time: null };
    } else {
      current.completions[date] = { done: true, time: new Date().toISOString(), backfill: date !== todayStr() };
    }
    await DB.setCurrentChallenge(current);
    renderHome();
    const isToday = date === todayStr();
    if (wasDone) toast(isToday ? '已取消今日完成' : '已取消补卡');
    else {
      toast(isToday ? randomEncourage() : '已补卡 ✓');
      askMood(date);
    }
  }

  /* 打卡完成后弹出轻量心情记录 */
  function askMood(date) {
    if (!current) return;
    pendingMoodDate = date;
    moodIndex = 0;
    $('#mood-input').value = DEFAULT_MOODS[0];
    $('#mood-modal').hidden = false;
  }
  function closeMood() {
    $('#mood-modal').hidden = true;
    pendingMoodDate = null;
  }
  async function saveMood() {
    const date = pendingMoodDate;
    const val = $('#mood-input').value.trim();
    closeMood();
    if (!current || !date || !current.completions[date]) return;
    current.completions[date].mood = val;
    await DB.setCurrentChallenge(current);
    renderHome();
  }
  async function skipMood() {
    closeMood();
    renderHome();
  }

  async function endEarly() {
    if (!current) return;
    showConfirm('提前结束本轮主题天～给这次结束加个原因吧', async (reason) => {
      await finalizeChallenge(current, 'ended_early', reason);
      renderHome();
      toast('已结束本轮，可以重新抽主题啦');
    }, { reason: true });
  }

  /* ============================================================
   * 主题管理
   * ============================================================ */
  function renderThemes() {
    const body = $('#themes-body');
    const summary = $('#themes-summary');
    const total = themes.length;
    const enabledCount = themes.filter((t) => t.enabled).length;
    const disabledCount = total - enabledCount;
    summary.innerHTML = `<span class="ts-item"><b>${total}</b> 个主题</span>
      <span class="ts-div"></span>
      <span class="ts-item on">已启用 <b>${enabledCount}</b></span>
      <span class="ts-item off">已停用 <b>${disabledCount}</b></span>`;

    const kw = themeSearch.trim().toLowerCase();
    let list = themes.slice();
    if (themeFilter === 'enabled') list = list.filter((t) => t.enabled);
    else if (themeFilter === 'disabled') list = list.filter((t) => !t.enabled);
    if (kw) list = list.filter((t) => (t.name + t.intro).toLowerCase().includes(kw));

    if (list.length === 0) {
      body.innerHTML = `<div class="empty-list">没有匹配的主题，点右上角「＋ 新建」添加一个吧</div>`;
      return;
    }

    body.innerHTML = list.map((t) => `
      <div class="theme-item" style="border-left-color:${esc(t.color)}">
        <div class="ti-top">
          <span class="ti-emoji">${esc(t.emoji || '⭐')}</span>
          <div>
            <p class="ti-name">${esc(t.name)}</p>
            <p class="ti-intro">${esc(t.intro)}</p>
          </div>
        </div>
        <div class="ti-meta">
          <span class="chip ${t.enabled ? '' : 'off'}">${t.enabled ? '已启用' : '已停用'}</span>
          ${t.tips ? '<span class="chip">含小建议</span>' : ''}
          <label class="switch mini-switch" title="启用 / 停用">
            <input type="checkbox" data-action="toggle-theme" data-id="${t.id}" ${t.enabled ? 'checked' : ''}/>
            <span class="slider"></span>
          </label>
        </div>
        <div class="ti-actions">
          <button class="btn btn-ghost" data-action="edit-theme" data-id="${t.id}">编辑</button>
          <button class="btn btn-ghost" data-action="delete-theme" data-id="${t.id}">删除</button>
        </div>
      </div>`).join('');
  }

  function buildColorSwatches(currentColor) {
    const row = $('#color-row');
    row.innerHTML = THEME_PALETTE.map((c) =>
      `<span class="swatch ${c.toLowerCase() === String(currentColor).toLowerCase() ? 'active' : ''}" data-color="${c}" style="background:${c}"></span>`
    ).join('');
    $('#f-color').value = currentColor || THEME_PALETTE[0];
  }

  /* 常用 emoji 快捷选择（覆盖生活/运动/学习/心情等场景） */
  const EMOJI_PICKER = [
    '🐰','🥤','🏃','📚','🇬🇧','🗣️','🧹','💡','🌙','🚶',
    '📦','🧺','📷','📝','🎤','✨','🎵','🍵','💪','🌿',
    '☀️','🌸','⭐','❤️','😴','🎨','🧘','🍳','🛁','🧩',
    '📱','💻','🎮','🎯','🔥','🌈','🦋','🐱','🐶','🌻',
  ];

  function buildEmojiPicker(currentEmoji) {
    const picker = $('#emoji-picker');
    picker.innerHTML = EMOJI_PICKER.map((e) =>
      `<button type="button" class="emoji-opt ${e === currentEmoji ? 'active' : ''}" data-emoji="${e}">${e}</button>`
    ).join('');
  }

  function openThemeModal(theme) {
    const isEdit = !!theme;
    $('#theme-modal-title').textContent = isEdit ? '编辑主题' : '新建主题';
    $('#f-id').value = isEdit ? theme.id : '';
    $('#f-name').value = isEdit ? theme.name : '';
    $('#f-emoji').value = isEdit ? (theme.emoji || '') : '';
    $('#f-intro').value = isEdit ? theme.intro : '';
    $('#f-goal').value = isEdit ? theme.goal : '';
    $('#f-tips').value = isEdit ? (theme.tips || '') : '';
    $('#f-enabled').checked = isEdit ? theme.enabled : true;
    buildColorSwatches(isEdit ? theme.color : THEME_PALETTE[0]);
    buildEmojiPicker(isEdit ? (theme.emoji || '') : '');
    $('#theme-modal').hidden = false;
  }

  async function saveTheme(e) {
    e.preventDefault();
    const id = $('#f-id').value;
    const name = $('#f-name').value.trim();
    const intro = $('#f-intro').value.trim();
    const goal = $('#f-goal').value.trim();
    if (!name || !intro || !goal) { toast('请把名称、介绍、目标填完整'); return; }
    const data = {
      name,
      emoji: $('#f-emoji').value.trim() || '⭐',
      color: $('#f-color').value,
      intro,
      goal,
      tips: $('#f-tips').value.trim(),
      enabled: $('#f-enabled').checked,
    };
    if (id) {
      themes = themes.map((t) => (t.id === id ? { ...t, ...data } : t));
    } else {
      themes.push({ id: uid('t'), createdAt: new Date().toISOString(), ...data });
    }
    await DB.saveThemes(themes);
    $('#theme-modal').hidden = true;
    renderThemes();
    toast('已保存');
  }

  async function toggleTheme(id) {
    themes = themes.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t));
    await DB.saveThemes(themes);
    renderThemes();
  }

  async function deleteTheme(id) {
    const t = themes.find((x) => x.id === id);
    if (!t) return;
    showConfirm(`确定删除「${t.name}」吗？历史记录仍会保留。`, async () => {
      themes = themes.filter((x) => x.id !== id);
      await DB.saveThemes(themes);
      closeConfirm();
      renderThemes();
      toast('已删除');
    });
  }

  /* ============================================================
   * 历史 + 统计
   * ============================================================ */
  function computeStats() {
    const total = history.length;
    if (total === 0) {
      return { total: 0, days: 0, rate: 0, most: '—', last: '—' };
    }
    let days = 0, planned = 0;
    const byTheme = {};
    history.forEach((h) => {
      days += h.doneDays;
      planned += h.plannedDays;
      byTheme[h.themeName] = (byTheme[h.themeName] || 0) + h.doneDays;
    });
    const rate = planned ? Math.round((days / planned) * 100) : 0;
    let most = '—', max = -1;
    Object.keys(byTheme).forEach((k) => { if (byTheme[k] > max) { max = byTheme[k]; most = k; } });
    const last = history[history.length - 1];
    return { total, days, rate, most, last: `${last.emoji} ${last.themeName}` };
  }

  function renderHistory() {
    const body = $('#history-body');
    const s = computeStats();
    const statHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${s.total}</div><div class="stat-cap">累计挑战（次）</div></div>
        <div class="stat-card"><div class="stat-num">${s.days}</div><div class="stat-cap">累计坚持（天）</div></div>
        <div class="stat-card"><div class="stat-num">${s.rate}%</div><div class="stat-cap">平均完成率</div></div>
        <div class="stat-card"><div class="stat-num">${esc(s.most)}</div><div class="stat-cap">坚持最多主题</div></div>
        <div class="stat-card wide"><div class="stat-num">${esc(s.last)}</div><div class="stat-cap">最近完成主题</div></div>
      </div>`;

    let listHTML = '';
    if (history.length === 0) {
      listHTML = `<div class="empty-list">还没有挑战记录，去首页抽一个主题开始吧 🐰</div>`;
    } else {
      listHTML = history.slice().reverse().map((h) => {
        const early = h.status === 'ended_early';
        const statusText = early ? '提前结束' : '已达成';
        return `
          <div class="history-item ${early ? 'early' : ''}" style="border-left-color:${esc(h.color)}" data-hid="${esc(h.id)}">
            <button class="hi-del" data-action="delete-history" data-id="${esc(h.id)}" title="删除此记录">✕</button>
            <div class="hi-top">
              <span class="hi-emoji">${esc(h.emoji)}</span>
              <span class="hi-name">${esc(h.themeName)}</span>
              <span class="hi-status">${statusText}</span>
            </div>
            <p class="hi-dates">${fmtDot(h.startDate)} ～ ${fmtDot(h.endDate)} · 挑战 ${h.plannedDays} 天 · 完成 ${h.doneDays} 天</p>
            <div class="hi-rate">
              <div class="progress-track"><div class="progress-fill" style="width:${h.rate}%;background:${esc(h.color)}"></div></div>
              <span class="rate-num">完成率 ${h.rate}%</span>
            </div>
            ${early && h.endReason ? `<p class="hi-reason">📝 ${esc(h.endReason)}</p>` : ''}
          </div>`;
      }).join('');
    }
    body.innerHTML = statHTML + listHTML;
  }

  async function deleteHistoryRecord(id) {
    const record = history.find((h) => h.id === id);
    if (!record) return;
    showConfirm(`确定删除「${record.themeName}」这条历史记录吗？删除后统计数据会重新计算。`, async () => {
      history = history.filter((h) => h.id !== id);
      await DB.saveHistory(history);
      closeConfirm();
      renderHistory();
      toast('已删除');
    });
  }

  /* ============================================================
   * 设置
   * ============================================================ */
  function renderSettings() {
    const body = $('#settings-body');
    body.innerHTML = `
      <div class="settings-group backup-group">
        <div class="backup-btns">
          <button class="btn btn-ghost backup-btn" data-action="export-data">↓ 导出备份</button>
          <button class="btn btn-ghost backup-btn" data-action="import-data">↑ 导入备份</button>
        </div>
        <p class="hint">导出可保存所有数据为文件；导入可从备份恢复，覆盖当前数据。</p>
      </div>

      <!-- 导出结果展示区（初始隐藏） -->
      <div class="export-panel" id="export-panel" hidden>
        <div class="export-header">
          <span>备份内容预览</span>
          <button class="export-close" data-action="close-export">✕</button>
        </div>
        <pre class="export-content" id="export-content"></pre>
        <button class="btn btn-primary btn-block" id="export-download" data-action="download-backup">下载备份文件</button>
      </div>

      <!-- 导入区域（初始隐藏） -->
      <div class="import-panel" id="import-panel" hidden>
        <div class="import-header">
          <span>选择备份文件</span>
          <button class="export-close" data-action="close-import">✕</button>
        </div>
        <input type="file" id="import-file" accept=".json,.txt" hidden />
        <button class="btn btn-ghost btn-block" id="import-pick" data-action="pick-import-file">选择 .json 备份文件</button>
        <pre class="import-preview" id="import-preview"></pre>
        <button class="btn btn-primary btn-block" id="import-confirm-btn" data-action="confirm-import" disabled>确认导入（将覆盖当前数据）</button>
      </div>

      <div class="settings-group">
        <h3>每轮最多重新抽取次数</h3>
        <p class="hint">抽到暂时不方便执行的主题时，可以「换一个」，上限防止无限刷新。</p>
        <div class="setting-row">
          <span class="label">换主题次数上限</span>
          <div class="stepper">
            <button data-action="step-redraw" data-dir="-1">－</button>
            <span class="val" id="redraw-val">${settings.maxRedraws}</span>
            <button data-action="step-redraw" data-dir="1">＋</button>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3>数据管理</h3>
        <p class="hint">数据保存在本机浏览器，长期可用，无需登录。</p>
        <button class="btn btn-ghost btn-block" data-action="clear-data">清除所有数据并恢复默认</button>
      </div>

      <div class="settings-group">
        <h3>关于 主题天</h3>
        <p class="about-text">打开 → 看今天主题 → 完成目标 → 打勾。<br/>
        一个给自己增加小目标与仪式感的轻量生活工具。<br/>
        预置 14 个主题，可随时在「主题」里增删改。</p>
      </div>`;
  }

  /* -------------------- 导出备份 -------------------- */
  let exportDataCache = null; // 缓存导出数据供下载用

  async function exportData() {
    const allThemes = await DB.getThemes();
    const allHistory = await DB.getHistory();
    const curChallenge = await DB.getCurrentChallenge();
    const cyclePool = await DB.getCyclePool();
    const appSettings = await DB.getSettings();

    const backup = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      appName: '主题天',
      themes: allThemes,
      history: allHistory,
      currentChallenge: curChallenge || null,
      cyclePool: cyclePool || [],
      settings: appSettings,
    };

    exportDataCache = backup;
    const jsonStr = JSON.stringify(backup, null, 2);

    // 显示导出面板
    const panel = $('#export-panel');
    const content = $('#export-content');
    content.textContent = jsonStr;
    panel.hidden = false;

    // 展开导出时收起导入面板
    if ($('#import-panel')) $('#import-panel').hidden = true;

    toast('已生成备份，可预览或下载');
  }

  function downloadBackup() {
    if (!exportDataCache) { toast('请先导出'); return; }
    const jsonStr = JSON.stringify(exportDataCache, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `theme-day-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('备份文件已开始下载');
  }

  function closeExport() {
    $('#export-panel').hidden = true;
  }

  /* -------------------- 导入备份 -------------------- */
  let importParsedData = null;

  function showImportPanel() {
    $('#import-panel').hidden = false;
    $('#export-panel').hidden = true;
    $('#import-preview').textContent = '';
    $('#import-confirm-btn').disabled = true;
    importParsedData = null;
  }

  function closeImport() {
    $('#import-panel').hidden = true;
    importParsedData = null;
  }

  function pickImportFile() {
    $('#import-file').click();
  }

  async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // 基本校验：必须有 themes 字段且是数组
      if (!data.themes || !Array.isArray(data.themes)) {
        toast('无效的备份文件：缺少主题数据');
        return;
      }

      importParsedData = data;
      const preview = $('#import-preview');
      preview.textContent = JSON.stringify({
        version: data.version || '?',
        exportedAt: data.exportedAt || '?',
        themeCount: data.themes.length,
        historyCount: (data.history || []).length,
        hasCurrentChallenge: !!data.currentChallenge,
      }, null, 2);
      $('#import-confirm-btn').disabled = false;
      toast(`已读取备份：${data.themes.length} 个主题，${(data.history||[]).length} 条历史`);
    } catch (err) {
      toast('文件解析失败，请检查是否为有效的 JSON 备份');
      importParsedData = null;
      $('#import-confirm-btn').disabled = true;
    }
    // 重置 input 以便重复选同一文件
    e.target.value = '';
  }

  async function confirmImport() {
    if (!importParsedData) return;
    showConfirm('确定导入此备份吗？当前所有数据将被覆盖，此操作不可恢复！', async () => {
      try {
        if (importParsedData.themes) await DB.saveThemes(importParsedData.themes);
        if (importParsedData.history) await DB.saveHistory(importParsedData.history);
        if (importParsedData.currentChallenge) await DB.setCurrentChallenge(importParsedData.currentChallenge);
        else await DB.setCurrentChallenge(null);
        if (importParsedData.cyclePool) await DB.setCyclePool(importParsedData.cyclePool);
        if (importParsedData.settings) await DB.saveSettings(importParsedData.settings);

        closeConfirm();
        closeImport();
        await loadState();
        renderSettings();
        switchView('home');
        toast('导入成功 ✓ 已恢复备份数据');
      } catch (err) {
        closeConfirm();
        toast('导入失败：' + err.message);
      }
    });
  }

  async function stepRedraw(dir) {
    let v = settings.maxRedraws + dir;
    v = Math.max(1, Math.min(3, v));
    settings.maxRedraws = v;
    await DB.saveSettings(settings);
    $('#redraw-val').textContent = v;
    if (current) renderHome(); // 立即反映剩余次数
    toast(`每轮最多换 ${v} 次`);
  }

  async function clearData() {
    showConfirm('确定清除所有数据吗？此操作不可恢复，将恢复默认主题。', async () => {
      await DB.clearAll();
      await DB.setSeeded(false);
      closeConfirm();
      await loadState();
      switchView('home');
      toast('已清空，已恢复默认主题');
    });
  }

  /* ============================================================
   * 视图切换 & 事件
   * ============================================================ */
  function switchView(v) {
    $$('.view').forEach((el) => el.classList.remove('active'));
    const view = $('#view-' + v);
    if (view) view.classList.add('active');
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    if (v === 'home') renderHome();
    else if (v === 'themes') renderThemes();
    else if (v === 'history') renderHistory();
    else if (v === 'settings') renderSettings();
  }

  function bindEvents() {
    // 点击委托
    document.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('[data-view]');
      if (viewBtn) { switchView(viewBtn.dataset.view); return; }

      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id;

      switch (action) {
        case 'draw': drawTheme(); break;
        case 'complete': completeToday(); break;
        case 'toggle-day': toggleDay(actionEl.dataset.date); break;
        case 'redraw': redrawTheme(); break;
        case 'end-early': endEarly(); break;
        case 'mood-skip': skipMood(); break;
        case 'open-new-theme': openThemeModal(null); break;
        case 'edit-theme': {
          const t = themes.find((x) => x.id === id);
          if (t) openThemeModal(t);
          break;
        }
        case 'delete-theme': deleteTheme(id); break;
        case 'delete-history': deleteHistoryRecord(id); break;
        // toggle-theme 仅由 change 事件处理，避免点击时重复切换
        case 'close-modal': $('#theme-modal').hidden = true; break;
        case 'close-confirm': closeConfirm(); break;
        case 'step-redraw': stepRedraw(Number(actionEl.dataset.dir)); break;
        case 'clear-data': clearData(); break;
        case 'export-data': exportData(); break;
        case 'download-backup': downloadBackup(); break;
        case 'close-export': closeExport(); break;
        case 'import-data': showImportPanel(); break;
        case 'close-import': closeImport(); break;
        case 'pick-import-file': pickImportFile(); break;
        case 'confirm-import': confirmImport(); break;
      }
    });

    // 开关用 change 事件（点击委托会重复切换）
    document.addEventListener('change', (e) => {
      const el = e.target.closest('[data-action="toggle-theme"]');
      if (el) toggleTheme(el.dataset.id);
    });

    // 确认弹窗确定按钮
    $('#confirm-ok').addEventListener('click', () => {
      const cb = confirmCallback;
      const reason = reasonPresets ? ($('#confirm-reason-input').value || '').trim() : null;
      confirmCallback = null;
      reasonPresets = null;
      $('#confirm-modal').hidden = true;
      if (cb) cb(reason);
    });

    // 提前结束：换一个预设原因
    $('#confirm-swap-reason').addEventListener('click', () => {
      if (!reasonPresets || !reasonPresets.length) return;
      reasonIndex = (reasonIndex + 1) % reasonPresets.length;
      $('#confirm-reason-input').value = reasonPresets[reasonIndex];
    });

    // 打卡记心情
    $('#mood-save').addEventListener('click', saveMood);
    $('#mood-swap').addEventListener('click', () => {
      moodIndex = (moodIndex + 1) % DEFAULT_MOODS.length;
      $('#mood-input').value = DEFAULT_MOODS[moodIndex];
    });
    $('#mood-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) skipMood(); });

    // 主题表单提交
    $('#theme-form').addEventListener('submit', saveTheme);

    // 颜色色板点击
    $('#color-row').addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      $$('.swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      $('#f-color').value = sw.dataset.color;
    });

    // Emoji 快捷选择器点击
    $('#emoji-picker').addEventListener('click', (e) => {
      const opt = e.target.closest('.emoji-opt');
      if (!opt) return;
      $$('.emoji-opt').forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
      $('#f-emoji').value = opt.dataset.emoji;
    });

    // 手动输入 emoji 时同步高亮
    $('#f-emoji').addEventListener('input', () => {
      const val = $('#f-emoji').value;
      $$('.emoji-opt').forEach((o) => o.classList.toggle('active', o.dataset.emoji === val));
    });

    // 主题搜索
    $('#theme-search').addEventListener('input', (e) => {
      themeSearch = e.target.value;
      renderThemes();
    });

    // 主题筛选
    $('#theme-filter').addEventListener('click', (e) => {
      const seg = e.target.closest('.seg-item');
      if (!seg) return;
      themeFilter = seg.dataset.filter;
      $$('#theme-filter .seg-item').forEach((s) => s.classList.toggle('active', s === seg));
      renderThemes();
    });

    // 点击遮罩关闭弹窗
    $$('.modal-mask').forEach((mask) => {
      mask.addEventListener('click', (e) => { if (e.target === mask) mask.hidden = true; });
    });

    // 导入文件选择（用事件委托，避免设置页重渲染后监听器丢失，也避免初始化时元素尚未存在而报错）
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'import-file') { handleImportFile(e); }
    });
  }

  /* -------------------- 启动 -------------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
