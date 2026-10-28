// Coding Plan 额度采集 → data.json → git push（GitHub Pages 数据源）
// 用法：node update.mjs [--no-push]  默认采集并推送；--no-push 仅本地更新
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, openSync, readSync, closeSync, statSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { collectIntel } from './intel.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NO_PUSH = process.argv.includes('--no-push');

// ---------- 防并发锁（计划任务/手动/serve 同时触发时只跑一个）----------
const LOCK = join(ROOT, 'update.lock');
if (existsSync(LOCK)) {
  try {
    if (Date.now() - Number(readFileSync(LOCK, 'utf8')) < 180000) { console.log('已有采集在运行，本次跳过'); process.exit(0); }
    unlinkSync(LOCK); // 超过 3 分钟视为残留锁
  } catch {}
}
writeFileSync(LOCK, String(Date.now()));
process.on('exit', () => { try { unlinkSync(LOCK); } catch {} });

const pad = (n) => String(n).padStart(2, '0');

// ---------- 配置 ----------
// config.json 缺失时降级为空对象：各采集器已有未配置判断，缺失只影响对应平台
const CFG_PATH = join(ROOT, 'config.json');
const cfg = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};

// 可选平台采集失败不中断整体快照（返回 {error} 由页面展示；返回 null 表示未配置）
async function safe(fn, name) {
  try { return await fn(); }
  catch (e) { console.error('⚠ [' + name + '] 采集失败: ' + (e.message || e)); return { error: String(e.message || e) }; }
}

// ---------- 智谱 ----------
async function zhipuGet(path) {
  const r = await fetch('https://open.bigmodel.cn' + path, { headers: { Authorization: cfg.zhipuKey } });
  const j = await r.json();
  if (j.code !== 200) throw new Error('智谱 ' + path.split('?')[0] + ' → ' + JSON.stringify(j).slice(0, 200));
  return j.data ?? j;
}

async function fetchZhipu() {
  if (!cfg.zhipuKey) return null; // 已退订/未配置 → 返回 null，页面显示已退订态
  const q = await zhipuGet('/api/monitor/usage/quota/limit');
  const limits = (q.limits || []).map((l) => ({
    label: { 3: '5小时窗口', 6: '每周窗口' }[l.unit] || l.type || '?',
    cap: Number(l.usage), used: Number(l.currentValue),
    pct: Number(l.percentage), reset: l.nextResetTime || null,
  }));

  // 近 7 天模型用量（时间格式必须 yyyy-MM-dd HH:mm:ss，时间戳会 500）
  const end = new Date();
  const start = new Date(Date.now() - 6 * 864e5); start.setHours(0, 0, 0, 0);
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`;
  const mu = await zhipuGet('/api/monitor/usage/model-usage?startTime=' + encodeURIComponent(fmt(start)) + '&endTime=' + encodeURIComponent(fmt(end)));

  const x = mu.x_time || [], tk = mu.tokensUsage || [], cc = mu.modelCallCount || [];
  const dateOf = (s) => String(s).slice(0, 10);
  const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = dateOf(x[x.length - 1] || fmtDate(end));

  // 7 个自然日补全（yyyy-mm-dd，与 x_time 对齐）
  const days = [];
  for (let i = 0; i < 7; i++) days.push(fmtDate(new Date(start.getTime() + i * 864e5)));

  const byModelDaily = {};
  for (const m of mu.modelDataList || []) {
    const daily = days.map((d) => {
      let s = 0;
      x.forEach((t, i) => { if (dateOf(t) === d) s += m.tokensUsage[i] || 0; });
      return s;
    });
    byModelDaily[m.modelName] = { daily, total: daily.reduce((a, b) => a + b, 0) };
  }

  const dayTotals = days.map((d) => {
    let s = 0, c = 0;
    x.forEach((t, i) => { if (dateOf(t) === d) { s += tk[i] || 0; c += cc[i] || 0; } });
    return { tokens: s, calls: c };
  });
  const tIdx = days.indexOf(today);
  const tu = mu.totalUsage || {};

  return {
    level: q.level || null,
    limits,
    totalTokens7d: Number(tu.totalTokensUsage) || dayTotals.reduce((a, b) => a + b.tokens, 0),
    totalCalls7d: Number(tu.totalModelCallCount) || dayTotals.reduce((a, b) => a + b.calls, 0),
    days,
    byModelDaily,
    today: {
      date: today,
      totalTokens: tIdx >= 0 ? dayTotals[tIdx].tokens : 0,
      totalCalls: tIdx >= 0 ? dayTotals[tIdx].calls : 0,
      byModel: Object.entries(byModelDaily)
        .map(([model, v]) => ({ model, tokens: v.daily[tIdx] || 0, share: v.total ? (v.daily[tIdx] || 0) / v.total : 0 }))
        .filter((m) => m.tokens > 0).sort((a, b) => b.tokens - a.tokens),
    },
  };
}

// ---------- 火山 ----------
const VOLC_CAPS = {
  Pro: { session: 6000, weekly: 45000, monthly: 90000 },
  Lite: { session: 1200, weekly: 9000, monthly: 18000 },
};
const VOLC_LABEL = { session: '5小时窗口', '5h': '5小时窗口', weekly: '每周窗口', monthly: '每月窗口' };
const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v); return isNaN(t) ? null : t;
};

// arkcli 的 label 两种写法都出现过（session / 5h），统一 key=session
const normKey = (l) => (l === '5h' ? 'session' : l);

// 额度上限：优先用 arkcli 返回的 total（Agent Plan 自带），兜底查本地容量表（Coding Plan 只回 percent）
function mapPeriods(item, caps) {
  return (item.periods || []).map((pe) => {
    const total = Number(pe.total);
    const cap = Number.isFinite(total) && total > 0 ? total : (caps[normKey(pe.label)] || 0);
    const used = pe.used != null ? Number(pe.used) : Math.round((Number(pe.percent) || 0) / 100 * cap);
    const pct = pe.percent != null ? Number(pe.percent) : (cap > 0 ? (used / cap) * 100 : 0);
    return {
      key: normKey(pe.label), label: VOLC_LABEL[pe.label] || pe.label,
      cap, pct, used: Math.round(used), reset: toMs(pe.reset_at),
    };
  });
}

function fetchVolcOne(profile, home) {
  const edition = cfg.volcEdition === 'Lite' ? 'Lite' : 'Pro';
  const args = ['usage', 'plan', '--all', '--format', 'json'];
  if (profile) args.push('--profile', profile);
  // 只 parse stdout（stderr 混入警告会污染拼接文本导致解析失败），失败重试 2 次应对链路抖动
  let j = null, lastErr = '';
  for (let i = 0; i < 3 && !j; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    // --all：一次拿全 4 个 SKU（personal 的 Coding Plan + Agent Plan，team 席位无绑定时返回 error 可忽略）
    // home：独立 USERPROFILE 状态目录（arkcli 单身份互斥，双账号各占一个目录，如 C:\Users\admin\.arkcli-8942）
    const p = spawnSync('arkcli', args, { shell: true, encoding: 'utf8', ...(home ? { env: { ...process.env, USERPROFILE: home } } : {}) });
    const so = p.stdout || '';
    try { j = JSON.parse(so.slice(so.indexOf('{'))); }
    catch { lastErr = 'stdout=' + so.slice(0, 200) + ' stderr=' + (p.stderr || '').slice(0, 200); }
  }
  if (!j) throw new Error('arkcli 输出无法解析（重试 3 次失败，可能未登录' + (profile ? ' / profile ' + profile : '') + '，运行 arkcli auth login）: ' + lastErr);
  const items = j.items || [];
  const pick = (product) => items.find((it) => it.product === product && it.edition !== 'team' && it.periods?.length);
  const coding = pick('coding-plan'), agent = pick('agent-plan');
  // 未返回用量时多留一段原文：面板只做展示，排查前请手跑 arkcli usage plan --all --format json 看全文
  if (!coding && !agent) throw new Error('arkcli 未返回已订阅套餐用量（面板仅显示前 400 字，排查请手跑 arkcli usage plan --all --format json 看全文）: '
    + JSON.stringify(items).slice(0, 400));
  const viewer = { user: j.viewer?.user_name || j.viewer?.user_id || '', profile: j.viewer?.profile || '' };
  return {
    user: viewer.user,
    coding: coding
      ? { ...viewer, edition, product: 'coding-plan', tier: coding.tier || edition, periods: mapPeriods(coding, VOLC_CAPS[edition]) }
      : null,
    agent: agent
      ? { ...viewer, edition: 'Personal', product: 'agent-plan', tier: agent.tier || '', periods: mapPeriods(agent, {}) }
      : null,
  };
}

// 多账号：config.volcProfiles = [{label, profile, home?}]，每个账号独立登录态（arkcli --profile）；
// arkcli 为单身份互斥（后登录者清掉先登录者 identity），双账号需各占独立状态目录（home 指向，如 C:\Users\admin\.arkcli-8942）
function fetchVolc() {
  const list = Array.isArray(cfg.volcProfiles) && cfg.volcProfiles.length
    ? cfg.volcProfiles
    : [{ label: '', profile: '' }];
  const accounts = list.map(({ label = '', profile = '', home = '' }) => {
    try {
      const r = fetchVolcOne(profile, home);
      return { label, profile, user: r.user, coding: r.coding, agent: r.agent };
    } catch (e) {
      return { label, profile, user: '', coding: null, agent: null, error: String(e?.message || e) };
    }
  });
  const first = accounts.find((a) => a.coding || a.agent);
  if (!first) throw new Error(accounts[0]?.error || 'arkcli 未返回已订阅套餐用量');
  return { accounts, coding: first.coding, agent: first.agent };
}

// ---------- DeepSeek（官方按量）----------
async function fetchDeepseek() {
  if (!cfg.deepseekKey) return null;
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: 'Bearer ' + cfg.deepseekKey },
  });
  if (!r.ok) throw new Error('balance → HTTP ' + r.status);
  const j = await r.json();
  const b = (j.balance_infos || [])[0] || {};
  return {
    currency: b.currency || 'CNY',
    total: Number(b.total_balance) || 0,
    granted: Number(b.granted_balance) || 0,
    toppedUp: Number(b.topped_up_balance) || 0,
    isAvailable: j.is_available !== false,
  };
}

// ---------- xf（bw.gsykj.com · sub2api 面板）----------
const XF_TOKENS = join(ROOT, 'xf_tokens.json'); // refresh_token 轮换持久化（gitignored）
const XF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 plan-monitor/1.0'; // 固定 UA（JWT 含 UA/IP 指纹）
const xfBase = () => (cfg.xf?.baseUrl || '').replace(/\/+$/, '');

const xfLoad = () => { try { return JSON.parse(readFileSync(XF_TOKENS, 'utf8')); } catch { return null; } };
const xfSave = (t) => writeFileSync(XF_TOKENS, JSON.stringify(t));

async function xfApi(path, token) {
  const r = await fetch(xfBase() + path, { headers: { Authorization: 'Bearer ' + token, 'User-Agent': XF_UA, Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { const e = new Error('token 失效'); e.status = 401; throw e; }
  if (j.code !== 0) throw new Error(path.split('?')[0] + ' → ' + JSON.stringify(j).slice(0, 150));
  return j.data;
}

async function xfLogin() {
  const r = await fetch(xfBase() + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': XF_UA },
    body: JSON.stringify({ email: cfg.xf.email, password: cfg.xf.password }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.data?.requires_2fa) throw new Error('该账号开启了 2FA，脚本无法自动登录（需在面板关闭 2FA 或改用一次性临时令牌）');
  if (j.code !== 0 || !j.data?.access_token) throw new Error('登录失败: ' + JSON.stringify(j).slice(0, 150));
  xfSave({ access_token: j.data.access_token, refresh_token: j.data.refresh_token, savedAt: Date.now() });
  return j.data.access_token;
}

// refresh_token 优先（一次性轮换，用后必须保存新对），无/失效再密码登录（login 限流 20/min）
async function xfEnsureToken() {
  const t = xfLoad();
  if (t?.refresh_token) {
    try {
      const r = await fetch(xfBase() + '/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': XF_UA },
        body: JSON.stringify({ refresh_token: t.refresh_token }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.code === 0 && j.data?.access_token) {
        xfSave({ access_token: j.data.access_token, refresh_token: j.data.refresh_token, savedAt: Date.now() });
        return j.data.access_token;
      }
    } catch { /* refresh 失败走密码登录 */ }
  }
  return xfLogin();
}

async function fetchXf() {
  if (!xfBase() || !cfg.xf?.email || !cfg.xf?.password) return null;
  const token = await xfEnsureToken();
  let profile, stats;
  try {
    [profile, stats] = await Promise.all([
      xfApi('/api/v1/user/profile', token),
      xfApi('/api/v1/usage/dashboard/stats', token),
    ]);
  } catch (e) {
    if (e.status !== 401) throw e;
    const t2 = await xfLogin(); // refresh 得到的 token 仍失效 → 重新登录
    [profile, stats] = await Promise.all([
      xfApi('/api/v1/user/profile', t2),
      xfApi('/api/v1/usage/dashboard/stats', t2),
    ]);
  }
  let keysCount = null;
  try { const k = await xfApi('/api/v1/keys', token); keysCount = (k.items || []).length; } catch { /* 可选 */ }
  // 近 7 日分模型花费（用于财务提示：钱到底花在哪个模型）
  let models = null;
  try {
    const md = await xfApi('/api/v1/usage/dashboard/models', token)
      .catch(async (e) => (e.status === 401 ? xfApi('/api/v1/usage/dashboard/models', await xfLogin()) : Promise.reject(e)));
    models = (md.models || []).map((m) => ({
      model: m.model,
      requests: m.requests,
      tokens: m.total_tokens,
      actualCost: Number(m.actual_cost) || 0,
    }));
  } catch { /* 可选 */ }
  return {
    models,
    baseUrl: xfBase(),
    cnyPerUsd: Number(cfg.xf?.cnyPerUsd) || 0.1479, // 充值比例 ¥300 = $2028，$1 ≈ ¥0.1479
    balance: Number(profile.balance) || 0,
    frozen: Number(profile.frozen_balance) || 0,
    totalRecharged: Number(profile.total_recharged) || 0,
    todayCost: Number(stats.today_actual_cost ?? stats.today_cost) || 0,
    todayTokens: Number(stats.today_tokens) || 0,
    todayRequests: Number(stats.today_requests) || 0,
    totalCost: Number(stats.total_actual_cost ?? stats.total_cost) || 0,
    totalTokens: Number(stats.total_tokens) || 0,
    keysCount,
  };
}

// ---------- 千帆 Token Plan（专用 Edge 登录态 + 页面内 fetch 控制台接口）----------
// 登录态存在独立 profile（qf-edge-profile）里，与用户日常浏览器隔离；
// Cookie 已在登录时改写为长有效期（400 天），浏览器重启后仍可复用。
const QF_PORT = 9227;
const QF_PROFILE = join(process.env.TEMP || 'C:\\Users\\admin\\AppData\\Local\\Temp', 'qf-edge-profile');
const QF_CONSOLE = 'https://console.bce.baidu.com/qianfan/resource/token-plan';
const QF_LOGIN = 'https://login.bce.baidu.com/?redirect=' + encodeURIComponent(QF_CONSOLE);
const QF_API = '/api/qianfan/charge/tokenPlanPersonal/resource';
const QF_ERROR = '控制台登录态失效（需在专用浏览器完成一次快捷登录）';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qfEdgePath = () => [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

async function qfCdpVersion() {
  try {
    const r = await fetch(`http://127.0.0.1:${QF_PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
}

async function qfEnsurePage() {
  let up = await qfCdpVersion();
  if (!up) {
    const exe = qfEdgePath();
    if (!exe) throw new Error('未找到 Edge');
    spawn(exe, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + QF_PROFILE, '--remote-debugging-port=' + QF_PORT,
      '--window-size=1280,900', QF_CONSOLE,
    ], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40 && !up; i++) { await sleep(1000); up = await qfCdpVersion(); }
  }
  if (!up) throw new Error('专用浏览器未启动');
  const tabs = await (await fetch(`http://127.0.0.1:${QF_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  return tabs.find((t) => t.type === 'page' && /console\.bce\.baidu\.com/.test(t.url)) || tabs.find((t) => t.type === 'page');
}

async function qfCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('CDP 连接超时')), 6000); });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const call = (method, params = {}, ms = 20000) => new Promise((res) => {
    const myId = ++id; pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ timeout: true }); } }, ms);
  });
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.timeout) throw new Error('页面响应超时');
    if (r.result?.exceptionDetails) throw new Error('页面脚本异常');
    return r.result?.result?.value;
  };
  return { call, evaluate, close: () => { try { ws.close(); } catch {} } };
}

// 读取余额：返回白名单字段，绝不带出 apiKey / resourceId / Cookie
async function qfReadBalance() {
  const tab = await qfEnsurePage();
  if (!tab?.webSocketDebuggerUrl) throw new Error('专用浏览器无可用标签页');
  const cdp = await qfCdp(tab.webSocketDebuggerUrl);
  try {
    return await cdp.evaluate(`(async () => {
      try {
        const res = await fetch('${QF_API}', { credentials: 'include', headers: { Accept: 'application/json' } });
        const txt = await res.text();
        if (!txt || txt.trim().startsWith('<')) return { login: true, status: res.status };
        const j = JSON.parse(txt);
        const it = (j.result && j.result.items && j.result.items[0]) || null;
        if (!it) return { empty: true, status: res.status };
        return {
          status: res.status, planType: it.planType, resourceStatus: it.resourceStatus,
          effectiveAt: it.effectiveAt, expiresAt: it.expiresAt, autoRenew: !!it.autoRenew,
          totalCredits: Number(it.totalCredits) || 0, usedCredits: Number(it.usedCredits) || 0,
        };
      } catch { return { netError: true }; }
    })()`);
  } finally { cdp.close(); }
}

// 读取福利包余额：/resource/token 页的独立接口（与套餐 tokenPlanPersonal 分离），白名单字段不带 resourceId/apiKey
async function qfReadWelfare() {
  const tab = await qfEnsurePage();
  if (!tab?.webSocketDebuggerUrl) throw new Error('专用浏览器无可用标签页');
  const cdp = await qfCdp(tab.webSocketDebuggerUrl);
  try {
    return await cdp.evaluate(`(async () => {
      try {
        const res = await fetch('/api/qianfan/charge/tokenPlan/resourceList?pageNo=1&pageSize=100&orderBy=startTime&order=ASC', { credentials: 'include', headers: { Accept: 'application/json' } });
        const txt = await res.text();
        if (!txt || txt.trim().startsWith('<')) return { login: true, status: res.status };
        const j = JSON.parse(txt);
        const it = (j.result && j.result.items && j.result.items[0]) || null;
        if (!it) return { empty: true, status: res.status };
        return {
          status: res.status, spec: Number(it.spec) || 0, used: Number(it.used) || 0,
          startTime: it.startTime || null, endTime: it.endTime || null,
        };
      } catch { return { netError: true }; }
    })()`);
  } finally { cdp.close(); }
}

// 登录态失效时自动走「快捷登录」（profile 内已缓存账号，无需短信/扫码）
async function qfQuickLogin() {
  const tab = await qfEnsurePage();
  const cdp = await qfCdp(tab.webSocketDebuggerUrl);
  try {
    await cdp.call('Page.enable');
    await cdp.call('Page.navigate', { url: QF_LOGIN });
    await sleep(6000);
    const ok = await cdp.evaluate(`(() => {
      const cb = document.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) cb.click();
      const c = [...document.querySelectorAll('button,div,a,span')]
        .filter(e => e.offsetParent && (e.textContent || '').trim() === '快捷登录');
      if (!c.length) return false;
      c.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0].click();
      return true;
    })()`);
    await sleep(6000);
    return ok;
  } finally { cdp.close(); }
}

async function fetchQianfan() {
  const shape = (r) => {
    const remain = +(r.totalCredits - r.usedCredits).toFixed(2);
    return {
      plan: r.planType || '', status: r.resourceStatus || '',
      total: r.totalCredits, used: r.usedCredits, remain,
      pct: r.totalCredits > 0 ? +(remain / r.totalCredits * 100).toFixed(2) : null,
      effectiveAt: r.effectiveAt || null, expiresAt: r.expiresAt || null,
      autoRenew: r.autoRenew === true,
    };
  };
  const r1 = await qfReadBalance();
  let base = null;
  if (r1?.totalCredits != null) base = shape(r1);
  if (!base && (r1?.login || r1?.netError)) {
    await qfQuickLogin();
    const r2 = await qfReadBalance();
    if (r2?.totalCredits != null) base = shape(r2);
  }
  if (!base) throw new Error(QF_ERROR);
  // 福利包（独立资源独立 key，采集失败不阻塞套餐主数据）
  try {
    const w = await qfReadWelfare();
    if (w?.spec > 0) {
      base.welfare = {
        spec: w.spec, used: w.used, remain: +(w.spec - w.used).toFixed(2),
        startTime: w.startTime, endTime: w.endTime,
      };
    }
  } catch { /* 福利包失败不影响主数据 */ }
  return base;
}

// ---------- 每日财务提示（当天生成一次，当天冻结，避免 2 分钟采集抖动）----------
function buildAdvice({ accounts, xf, qianfan, daily, today }) {
  const items = [];
  const push = (level, title, detail) => { if (items.length < 4) items.push({ level, title, detail }); };
  const usd = (n) => '$' + (Number(n) || 0).toFixed(2);
  const rate = Number(xf?.cnyPerUsd) || 0.1479;

  // ① xf 余额续航：用前几个完整日的日均消耗，不把今天的半截算进去
  if (xf && !xf.error && Number.isFinite(xf.balance)) {
    const hist = (daily || []).filter((d) => d.date !== today).slice(-3);
    const pool = (hist.length ? hist : (daily || []).slice(-3))
      .map((d) => Number(d.xfCost)).filter((n) => Number.isFinite(n) && n > 0);
    const avg = pool.length ? pool.reduce((a, b) => a + b, 0) / pool.length : 0;
    if (avg > 0) {
      const days = xf.balance / avg;
      const line = `余额 ${usd(xf.balance)}（≈¥${(xf.balance * rate).toFixed(0)}）· 近 ${pool.length} 日均 ${usd(avg)}/天 · 可撑 ≈${days.toFixed(1)} 天`;
      if (days < 5) push('red', 'xf 余额告急：本周内必须充值', line + '。按量通道是火山撞限后的唯一兜底，断档会直接卡住高峰任务。');
      else if (days < 10) push('amber', 'xf 余额偏紧：一周内安排充值', line + '。');
      else push('green', `xf 余额可撑 ≈${Math.floor(days)} 天，暂不用动`, line + '。');
    }
  }

  // ② 千帆 Pro：按账期内已用速率外推耗尽日
  if (qianfan && !qianfan.error && qianfan.total > 0 && qianfan.effectiveAt) {
    const elapsed = Math.max((Date.now() - new Date(qianfan.effectiveAt).getTime()) / 864e5, 0.5);
    const perDay = qianfan.used / elapsed;
    if (perDay > 0) {
      const daysLeft = qianfan.remain / perDay;
      // pct 字段=余量占比（(total-used)/total），"已用"必须用 used/total 另算——
      // 2026-10-28 主任质询后修正：旧文案 Math.round(qianfan.pct) 在透支时显示"已用 0%"
      const usedPct = Math.round(qianfan.used / qianfan.total * 100);
      const line = `已用 ${usedPct}%（${Math.round(qianfan.used).toLocaleString()}/${qianfan.total.toLocaleString()}）· ${elapsed.toFixed(1)} 天均 ${Math.round(perDay).toLocaleString()}/天 · ${qianfan.remain <= 0 ? '已透支（超出 ' + Math.abs(Math.round(qianfan.remain)).toLocaleString() + ' 积分）' : '约 ' + Math.ceil(daysLeft) + ' 天后耗尽'}`;
      if (daysLeft < 3) push('red', '千帆 Pro 即将耗尽：收强度或申请加购', line + '。加购/升级属花钱动作，需主任批准后再动。');
      else if (daysLeft < 7) push('amber', '千帆 Pro 用量偏快', line + '。检索/文档类优先压到 xf 低价模型。');
      else push('blue', '千帆 Pro 节奏正常', line + '。');
    }
  }

  // ②b 千帆福利包（独立资源，1 个月有效不结转）：按速率外推到期烧得完吗
  const wf = qianfan?.welfare;
  if (wf && wf.spec > 0 && wf.startTime) {
    const elapsedDays = Math.max((Date.now() - new Date(wf.startTime).getTime()) / 864e5, 0.5);
    const perDay = wf.used / elapsedDays;
    const daysLeft = wf.endTime ? Math.ceil((new Date(wf.endTime).getTime() - Date.now()) / 864e5) : null;
    const remain = wf.spec - wf.used;
    const line = `已用 ${Math.round(wf.used).toLocaleString()}/${wf.spec.toLocaleString()} 积分 · 均 ${Math.round(perDay).toLocaleString()}/天${daysLeft != null ? ` · 剩 ${daysLeft} 天到期` : ''}`;
    if (daysLeft != null && daysLeft <= 3 && remain > wf.spec * 0.1) push('red', '千帆福利包即将过期（不结转）', line + ` · 还剩 ${Math.round(remain).toLocaleString()} 积分会作废，加紧把批读/检索类任务路由到 baidu-qianfan-2/glm-5.3-flash。`);
    else if (daysLeft != null && perDay > 0 && perDay * daysLeft < remain * 0.9) push('amber', '千帆福利包按当前速率会烧不完', line + ` · 按此速率到期约剩 ${Math.round(remain - perDay * daysLeft).toLocaleString()} 积分作废，多派批读类任务。`);
    else push('blue', '千帆福利包节奏正常', line + '。');
  }

  // ③ 火山各账号已满窗口汇总（满额后继续硬顶只会限流重试）
  const full = [];
  for (const a of (accounts || [])) {
    const tag = a.label || a.profile || '默认';
    for (const [name, plan] of [['Coding', a.coding], ['Agent', a.agent]]) {
      for (const p of (plan?.periods || [])) {
        if (Number(p.pct) >= 98) full.push(`${tag} ${name} ${p.label} ${Number(p.pct).toFixed(0)}%`);
      }
    }
  }
  if (full.length) push('red', '火山额度已满：重活立刻切 xf / 8942', full.join('、') + '。满额窗口内请求会被限流。');

  // ④ 花费集中度：头部模型占一半以上时给单价对比与替代建议
  const models = (xf && !xf.error && Array.isArray(xf.models)) ? xf.models.filter((m) => Number(m.actualCost) > 0) : [];
  if (models.length) {
    const total = models.reduce((a, m) => a + Number(m.actualCost), 0);
    const sorted = [...models].sort((a, b) => b.actualCost - a.actualCost);
    const top = sorted[0];
    const unit = (m) => (m.tokens > 0 ? (Number(m.actualCost) / m.tokens) * 1e6 : 0);
    const share = total > 0 ? top.actualCost / total : 0;
    if (share >= 0.5) {
      const alt = sorted.slice(1).find((m) => unit(m) > 0 && unit(m) < unit(top) * 0.7);
      let detail = `近期 ${usd(top.actualCost)}（占 ${usd(total)} 的 ${Math.round(share * 100)}%），单价 $${unit(top).toFixed(2)}/M tk`;
      if (alt) {
        const save = top.actualCost - (top.tokens / 1e6) * unit(alt);
        detail += `；同量级 ${alt.model} 仅 $${unit(alt).toFixed(2)}/M，非关键任务切过去可省 ≈${usd(save)}（≈¥${Math.round(save * rate)}）`;
      }
      push('amber', `${top.model} 吃掉 ${Math.round(share * 100)}% 花费`, detail + '。');
    }
  }

  // 严重度排序：红 → 黄 → 蓝 → 绿
  const rank = { red: 0, amber: 1, blue: 2, green: 3 };
  items.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));

  return { date: today, generatedAt: Date.now(), items };
}

// ---------- magpie 路由健康（订阅组限频/中断监测，2026-10-28 主任令）----------
// 数据源：~/.config/magpie/routing/YYYY-MM-DD.jsonl（每行一次外部请求，tries 为逐上游尝试）
// 监测：①各上游当前 rest（rate=瞬时限频冷却 / quota=配额耗尽）②近窗最终失败=用户任务中断信号
//       ③tries.fail='rate' 次数 ④10 分钟分桶趋势。最终失败走 wb_notify 队列告警（1h 去重）。
function collectMagpieHealth() {
  const dir = join(homedir(), '.config', 'magpie', 'routing');
  const now = Date.now();
  const WIN_MS = 2 * 3600 * 1000;
  const dayNames = [];
  for (let k = 0; k < 2; k++) {
    const d = new Date(now - k * 86400000);
    dayNames.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
  }
  // tail 读：单文件上万行，每轮全读浪费；取末尾 ~4MB 覆盖近 2h 足够（监测的是"此刻是否在撞限频"）
  const tailLines = (name) => {
    const p = join(dir, name);
    if (!existsSync(p)) return [];
    const sz = statSync(p).size;
    const buf = Buffer.alloc(Math.min(sz, 4_000_000));
    const fd = openSync(p, 'r');
    try { readSync(fd, buf, 0, buf.length, Math.max(0, sz - buf.length)); } finally { closeSync(fd); }
    const txt = buf.toString('utf8');
    const lines = txt.split('\n').filter((l) => l.startsWith('{'));
    return lines;
  };
  const perProv = new Map();
  const bump = (id, key) => { const e = perProv.get(id) || { req: 0, ok: 0, rate: 0, quota: 0, otherFail: 0, msSum: 0, msN: 0 }; e[key]++; perProv.set(id, e); return e; };
  let req = 0, finalFail = 0;
  const buckets = new Map();
  let curGroup = null, curOrder = null, curOrderT = 0;
  for (const name of dayNames) {
    for (const line of tailLines(name)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const t0 = Date.parse(r.time || '');
      if (!t0 || now - t0 > WIN_MS) continue;
      req++;
      const st = Number(r.status) || 0;
      const bk = String(Math.floor(t0 / 600000)); // 10 分钟桶
      const b = buckets.get(bk) || { t: Math.floor(t0 / 600000) * 600000, req: 0, fail: 0 };
      b.req++;
      // 499=用户点停止按钮的正常事件，不算中断；真中断=429 配额/限频 或 5xx 服务错误（WorkBuddy 不重试→任务断）
      const isInterrupt = st !== 200 && st !== 201 && st !== 499;
      if (isInterrupt) { finalFail++; b.fail++; }
      buckets.set(bk, b);
      for (const tr of (r.tries || [])) {
        const id = String(tr.id || 'unknown');
        const e = bump(id, 'req');
        const ts = Number(tr.status) || 0;
        if (ts === 200) { e.ok++; if (Number(tr.ms) > 0) { e.msSum += Number(tr.ms); e.msN++; } }
        else if (tr.fail === 'rate') e.rate++;
        else if (tr.fail === 'quota' || (tr.rest && tr.rest.why === 'quota')) e.quota++;
        else e.otherFail++;
      }
      // 最新一条记录里的 order 携带当前各上游 rest 状态；跨天两个文件，只取时间最新者，
      // 否则旧文件末尾的过期 order 会覆盖新文件的 5 成员组
      if (Array.isArray(r.order) && t0 >= curOrderT) { curGroup = r.group || curGroup; curOrder = r.order; curOrderT = t0; }
    }
  }
  const members = [];
  // 成员以最新一条记录的 subscription 组定义为准（含非火山兜底，如千帆福利包）；
  // order 提供各上游 name/rest 状态；不在 order 里（近期没被轮到）的兜底上游默认 up
  const groupList = Array.isArray(curGroup?.members) ? curGroup.members : [];
  const orderedIds = groupList.length
    ? groupList.map((m) => String(m).split('/')[0])
    : (curOrder || []).map((o) => String(o.id || ''));
  const orderMap = new Map((curOrder || []).map((o) => [String(o.id || ''), o]));
  for (const id of orderedIds) {
    if (!id) continue;
    const o = orderMap.get(id);
    const s = perProv.get(id);
    let state = 'up', until = null;
    const rest = o?.rest;
    if (rest) {
      until = rest.until ? Date.parse(rest.until) : null;
      if (rest.why === 'rate' && until && until > now) state = 'rate';
      else if (rest.why === 'quota' && until && until > now) state = 'quota';
    }
    members.push({ id, name: String(o?.name || id), state, until: until && until > now ? until : null,
      rate2h: s?.rate || 0, quota2h: s?.quota || 0, req2h: s?.req || 0,
      avgMs: s?.msN ? Math.round(s.msSum / s.msN) : null });
  }
  return {
    ts: now, windowSec: Math.round(WIN_MS / 1000), lines: req,
    groupId: curGroup?.id || 'subscription',
    available: members.filter((m) => m.state === 'up').length, total: members.length,
    members, req2h: req, finalFail2h: finalFail,
    buckets: [...buckets.values()].sort((a, b) => a.t - b.t),
  };
}
async function maybeNotifyMagpie(h) {
  if (!h || h.error || !(h.finalFail2h > 0)) return;
  const sp = join(ROOT, 'magpie_alert_state.json');
  let last = 0;
  try { last = JSON.parse(readFileSync(sp, 'utf8')).lastFinalFail || 0; } catch {}
  if (Date.now() - last < 3600 * 1000) return; // 1h 去重
  const r = spawnSync('python', [join(ROOT, '..', '00_System', 'bin', 'wb_notify.py'),
    `[magpie] 订阅组近2h有 ${h.finalFail2h} 次请求最终失败（任务级中断）；可用上游 ${h.available}/${h.total}，请查 monitor.jivonlab.com`, '--tag', 'magpie-route'],
    { shell: true, encoding: 'utf8' });
  if (r.status === 0) writeFileSync(sp, JSON.stringify({ lastFinalFail: Date.now() }));
}

// ---------- magpie 配置结构（路由组/回退环展示，2026-10-28 主任令；只读结构，不含任何密钥）----------
function fetchMagpieConfig() {
  const p = join(homedir(), '.config', 'magpie', 'providers.json');
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  return {
    ts: Date.now(),
    groups: (raw.groups || []).map((g) => ({ id: g.id, name: g.name || g.id, affinity: g.affinity || '', members: g.members || [] })),
    providers: (raw.providers || []).map((pr) => ({
      id: pr.id, name: pr.name || pr.id, host: host(pr.chat || ''), fallback: pr.fallback || [],
    })),
  };
}

// ---------- 主流程 ----------
const zhipu = await safe(fetchZhipu, '智谱');
const volcRes = await safe(fetchVolc, '火山');
const volc = volcRes?.error ? { error: volcRes.error } : (volcRes?.coding || null);
const volcAgent = volcRes?.error ? { error: volcRes.error } : (volcRes?.agent || null);
const deepseek = await safe(fetchDeepseek, 'DeepSeek');
const xf = await safe(fetchXf, 'xf');
const qianfan = await safe(fetchQianfan, '千帆');
const magpieHealth = await safe(() => collectMagpieHealth(), 'magpie');
const magpieConfig = await safe(fetchMagpieConfig, 'magpie配置');
await maybeNotifyMagpie(magpieHealth);
const intel = await safe(() => collectIntel({ root: ROOT }), '情报');

const zWorstPct = zhipu?.limits?.length ? Math.max(...zhipu.limits.map((l) => l.pct)) : null;
const vSessionPct = volc?.periods?.find((p) => p.key === 'session')?.pct ?? null;

// history：追加本次快照，保留最近 200 条；daily：按天聚合消耗快照（趋势预测数据底座）
let history = [], daily = [], prevAdvice = null, prevFailStreak = {};
const dataPath = join(ROOT, 'data.json');
if (existsSync(dataPath)) {
  try { const prev = JSON.parse(readFileSync(dataPath, 'utf8')); history = prev.history || []; daily = prev.daily || []; prevAdvice = prev.advice || null; prevFailStreak = prev.volcFailStreak || {}; } catch {}
}
history.push({ ts: Date.now(), zWorstPct, vSessionPct });
history = history.slice(-200);

// daily：每天一条消耗快照（同天覆盖，null 字段保留旧值避免采集失败抹数据），保留最近 60 天
const _d = new Date();
const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
const vUsed = (k) => volc?.periods?.find((p) => p.key === k)?.used ?? null;
const snap = {
  date: today,
  ts: Date.now(),
  vMonthly: vUsed('monthly'), vWeekly: vUsed('weekly'), vSessionUsed: vUsed('session'),
  zWeek: zhipu?.limits?.find((l) => (l.label || '').includes('周'))?.used ?? null,
  zTodayTk: zhipu?.today?.totalTokens ?? null, zTodayReq: zhipu?.today?.totalCalls ?? null,
  xfCost: xf?.todayCost ?? null, xfTk: xf?.todayTokens ?? null, xfReq: xf?.todayRequests ?? null,
  ds: deepseek?.total ?? null,
};
const di = daily.findIndex((x) => x.date === today);
if (di >= 0) { const old = daily[di]; for (const k of Object.keys(snap)) if (snap[k] == null && old[k] != null) snap[k] = old[k]; daily[di] = snap; }
else daily.push(snap);
daily = daily.slice(-60);

// 财务提示：每天零点后首次采集生成，当天冻结（同日多轮采集沿用旧结论）。
// 例外（2026-10-28 主任质询后新增）：千帆透支/告急、xf 告急、火山满额窗口
// 属"分钟级恶化"信号，当天冻结会让面板挂"约 5 天后耗尽"而实际已透支——
// 这三类命中时当轮强制重算。
const _critHit = (() => {
  const q = qianfan, x = xf, accs = volcRes?.accounts || [];
  const qCrit = q && !q.error && q.total > 0 && ((q.total - q.used) / q.total) <= 0.15;
  const xCrit = x && !x.error && Number.isFinite(x.balance) &&
    (() => { const h = (daily || []).filter((d) => d.date !== today).slice(-3).map((d) => Number(d.xfCost)).filter((n) => Number.isFinite(n) && n > 0); const avg = h.length ? h.reduce((a, b) => a + b, 0) / h.length : 0; return avg > 0 && (x.balance / avg) < 5; })();
  let vFull = false;
  for (const a of accs) for (const plan of [a.coding, a.agent]) for (const p of (plan?.periods || [])) if (Number(p.pct) >= 98) vFull = true;
  return qCrit || xCrit || vFull;
})();
const advice = (_critHit || !(prevAdvice && prevAdvice.date === today))
  ? buildAdvice({ accounts: volcRes?.accounts || null, xf, qianfan, daily, today })
  : prevAdvice;

// 保护②：火山各账号采集失败连续轮数（成功清零），供面板失败卡与告警使用
const failStreak = {};
for (const a of (volcRes?.accounts || [])) {
  const lb = a.label || a.profile || 'default';
  failStreak[lb] = a.error ? ((prevFailStreak[lb] || 0) + 1) : 0;
}

const data = { ts: Date.now(), zhipu, volc, volcAgent, volcAccounts: volcRes?.accounts || null, volcFailStreak: failStreak, deepseek, xf, qianfan, magpieHealth, magpieConfig, intel, history, daily, advice };
// 原子写：页面每 2 分钟拉一次，直接覆写会撞上"文件只写了一半"导致 JSON 解析失败（表现为部分卡片停在"加载中"）
writeFileSync(dataPath + '.tmp', JSON.stringify(data));
renameSync(dataPath + '.tmp', dataPath);
if (zhipu && !zhipu.error) console.log(`[智谱] OK ${zhipu.level} ` + zhipu.limits.map((l) => `${l.label}=${l.pct.toFixed(0)}%`).join(' '));
else if (zhipu?.error) console.log('[智谱] 未采集成功');
else console.log('[智谱] 未配置（config.json 的 zhipuKey 为空，跳过）');
for (const a of (volcRes?.accounts || [])) {
  const tag = a.label || a.profile || '默认';
  if (a.error) { console.log(`[火山 ${tag}] 未采集成功：${a.error}`); continue; }
  if (a.coding) console.log(`[火山 ${tag} Coding] OK ${a.coding.tier} ` + a.coding.periods.map((p) => `${p.key}=${p.pct.toFixed(1)}%`).join(' '));
  else console.log(`[火山 ${tag} Coding] 未订阅或未返回`);
  if (a.agent) console.log(`[火山 ${tag} Agent] OK ${a.agent.tier} ` + a.agent.periods.map((p) => `${p.key}=${p.used}/${p.cap}(${p.pct.toFixed(1)}%)`).join(' '));
  else console.log(`[火山 ${tag} Agent] 未订阅或未返回`);
}
if (!volcRes?.accounts?.length) {
  if (volc && !volc.error) console.log(`[火山 Coding] OK ${volc.tier} ` + volc.periods.map((p) => `${p.key}=${p.pct.toFixed(1)}%`).join(' '));
  else console.log('[火山 Coding] 未采集成功：' + (volc?.error || '未订阅或未返回'));
  if (volcAgent && !volcAgent.error) console.log(`[火山 Agent] OK ${volcAgent.tier} ` + volcAgent.periods.map((p) => `${p.key}=${p.used}/${p.cap}(${p.pct.toFixed(1)}%)`).join(' '));
  else console.log('[火山 Agent] 未采集成功：' + (volcAgent?.error || '未订阅或未返回'));
}
if (deepseek && !deepseek.error) console.log(`[DeepSeek] OK 余额 ¥${deepseek.total.toFixed(2)}（可用=${deepseek.isAvailable}）`);
else if (deepseek?.error) console.log('[DeepSeek] 未采集成功');
else console.log('[DeepSeek] 未配置（config.json 的 deepseekKey 为空，跳过）');
if (xf && !xf.error) console.log(`[xf] OK 余额 $${xf.balance.toFixed(2)} · 今日 $${xf.todayCost.toFixed(2)} / ${xf.todayTokens} tokens`);
else if (xf?.error) console.log('[xf] 未采集成功');
else console.log('[xf] 未配置（config.json 的 xf 段为空，跳过）');
if (qianfan && !qianfan.error) console.log(`[千帆] OK ${qianfan.plan} 余量 ${qianfan.pct}%（${qianfan.remain.toLocaleString()}/${qianfan.total.toLocaleString()}）到期 ${String(qianfan.expiresAt || '').slice(0, 10)}`);
else if (qianfan?.error) console.log('[千帆] 未采集成功：' + qianfan.error);
else console.log('[千帆] 未配置（跳过）');
if (intel && !intel.error) console.log(`[情报] OK 千帆 ${intel.qianfan.count} 模型 · 火山 ${intel.volc.discounts.filter((d) => d.status === 'active').length} 个活动折扣 · 告警 ${intel.alerts.length} 条${!intel.cached && intel.mail?.sent ? ` · 邮件已发 ${intel.mail.sent} 条` : ''}${intel.cached ? '（缓存）' : ''}`);
else console.log('[情报] 未采集成功：' + (intel?.error || '未知'));

// ---------- 推送 ----------
if (NO_PUSH) { console.log('（--no-push：仅本地更新 data.json）'); process.exit(0); }
const git = (args) => {
  // GIT_TERMINAL_PROMPT=0：非交互上下文（计划任务 S4U）拿不到凭据时快速失败，不卡终端提示
  const r = spawnSync('git', args, { shell: true, encoding: 'utf8', cwd: ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败: ' + ((r.stderr || '') + (r.stdout || '')).slice(0, 300));
  return r.stdout;
};
git(['add', 'data.json']);
const staged = git(['status', '--porcelain', 'data.json']).trim();
if (!staged) { console.log('数据无变化，跳过推送'); process.exit(0); }
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
git(['commit', '-m', `"snapshot ${stamp}"`]);
// ---------- push 自愈：失败自动轮换 hosts 里的 GitHub IP ----------
// 本机到 GitHub 直连属间歇性阻断（TLS 层被重置，同一 IP 时通时断）。
// 策略：push 前预检（当前 IP 不通则探测换新）；push 失败后用 curl 快速探测（3s/个）找池中可用 IP
// 换入 hosts + flushdns 再重试，找不到才盲轮换。需要计划任务以最高权限运行（写 hosts 需管理员）。
// 最终失败也不报错，commit 已保留待下轮推。
const GH_IPS = [
  '140.82.112.3', '140.82.112.4', '140.82.113.3', '140.82.113.4',
  '140.82.114.3', '140.82.114.4', '140.82.116.3', '140.82.116.4',
  '20.205.243.166', '20.27.177.113',
];
const HOSTS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
function ghIpInHosts() {
  try { const m = readFileSync(HOSTS, 'utf8').match(/^(\d{1,3}(?:\.\d{1,3}){3})(\s+github\.com)/m); return m ? m[1] : null; }
  catch { return null; }
}
function setHostsIp(ip) {
  try {
    const raw = readFileSync(HOSTS, 'utf8');
    if (!/^(\d{1,3}(?:\.\d{1,3}){3})(\s+github\.com)/m.test(raw)) return 'hosts 无 github.com 条目，跳过换 IP';
    writeFileSync(HOSTS, raw
      .replace(/^(\d{1,3}(?:\.\d{1,3}){3})(\s+github\.com)/m, ip + '$2')
      .replace(/^(\d{1,3}(?:\.\d{1,3}){3})(\s+www\.github\.com)/m, ip + '$2'), 'utf8');
    spawnSync('ipconfig', ['/flushdns'], { shell: true });
    return ip;
  } catch (e) { return '写 hosts 失败：' + String(e.message || e).slice(0, 80); }
}
function probeIp(ip) {
  try {
    const r = spawnSync('curl.exe', ['-s', '-o', 'NUL', '-w', '%{http_code}', '--resolve', 'github.com:443:' + ip, 'https://github.com', '-m', '3'], { shell: true, encoding: 'utf8', timeout: 4500 });
    return (r.stdout || '').trim() === '200';
  } catch { return false; }
}
function findGoodIp() {
  const cur = ghIpInHosts();
  const order = cur ? [cur, ...GH_IPS.filter((x) => x !== cur)] : [...GH_IPS];
  for (const ip of order) if (probeIp(ip)) return ip;
  return null;
}
// 预检：当前 hosts IP 探测不通就直接换成可用 IP，避免在必败 IP 上烧 20s 超时
{
  const pre = findGoodIp();
  if (pre && pre !== ghIpInHosts()) console.log('[push 预检] 当前 IP ' + ghIpInHosts() + ' 不通，已换为探测可用 IP ' + pre);
}
let pushed = false;
const pushT0 = Date.now();
for (let i = 1; i <= 6 && !pushed; i++) {
  try { git(['push']); pushed = true; }
  catch (e) {
    const msg = String(e.message).replace(/\n/g, ' ').slice(0, 120);
    if (Date.now() - pushT0 > 150000) { console.log(`push 第${i}次失败（${msg}）；重试总时长超 150s 预算，放弃（commit 已保留，下轮再推）`); break; }
    const good = findGoodIp();
    const rot = good ? setHostsIp(good) : setHostsIp(GH_IPS[(GH_IPS.indexOf(ghIpInHosts()) + 1) % GH_IPS.length]);
    console.log(`push 第${i}次失败：${msg}；探测换 GitHub IP：${rot}，5 秒后重试`);
    if (i < 6) await new Promise((r) => setTimeout(r, 5000));
  }
}
if (pushed) console.log('✓ 已推送，Pages 稍后自动更新');
