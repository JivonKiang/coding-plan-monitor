// Coding Plan 额度采集 → data.json → git push（GitHub Pages 数据源）
// 用法：node update.mjs [--no-push]  默认采集并推送；--no-push 仅本地更新
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
const VOLC_LABEL = { session: '5小时窗口', weekly: '每周窗口', monthly: '每月窗口' };
const toMs = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v); return isNaN(t) ? null : t;
};

function fetchVolc() {
  const edition = cfg.volcEdition === 'Lite' ? 'Lite' : 'Pro';
  // 只 parse stdout（stderr 混入警告会污染拼接文本导致解析失败），失败重试 2 次应对链路抖动
  let j = null, lastErr = '';
  for (let i = 0; i < 3 && !j; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    const p = spawnSync('arkcli', ['usage', 'plan', '--format', 'json'], { shell: true, encoding: 'utf8' });
    const so = p.stdout || '';
    try { j = JSON.parse(so.slice(so.indexOf('{'))); }
    catch { lastErr = 'stdout=' + so.slice(0, 120) + ' stderr=' + (p.stderr || '').slice(0, 120); }
  }
  if (!j) throw new Error('arkcli 输出无法解析（重试 3 次失败，可能未登录，运行 arkcli auth login）: ' + lastErr);
  const item = (j.items || [])[0];
  if (!item) throw new Error('arkcli 未返回用量: ' + JSON.stringify(j).slice(0, 150));
  const caps = VOLC_CAPS[edition];
  return {
    edition,
    user: j.viewer?.user_name || j.viewer?.user_id || '',
    profile: j.viewer?.profile || '',
    periods: (item.periods || []).map((pe) => {
      const cap = caps[pe.label] || 0;
      return {
        key: pe.label, label: VOLC_LABEL[pe.label] || pe.label,
        cap, pct: Number(pe.percent) || 0,
        used: Math.round((Number(pe.percent) || 0) / 100 * cap),
        reset: toMs(pe.reset_at),
      };
    }),
  };
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
  return {
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
  if (r1?.totalCredits != null) return shape(r1);
  if (r1?.login || r1?.netError) {
    await qfQuickLogin();
    const r2 = await qfReadBalance();
    if (r2?.totalCredits != null) return shape(r2);
  }
  throw new Error(QF_ERROR);
}

// ---------- 主流程 ----------
const zhipu = await safe(fetchZhipu, '智谱');
const volc = await safe(fetchVolc, '火山');
const deepseek = await safe(fetchDeepseek, 'DeepSeek');
const xf = await safe(fetchXf, 'xf');
const qianfan = await safe(fetchQianfan, '千帆');
const intel = await safe(() => collectIntel({ root: ROOT }), '情报');

const zWorstPct = zhipu?.limits?.length ? Math.max(...zhipu.limits.map((l) => l.pct)) : null;
const vSessionPct = volc?.periods?.find((p) => p.key === 'session')?.pct ?? null;

// history：追加本次快照，保留最近 200 条；daily：按天聚合消耗快照（趋势预测数据底座）
let history = [], daily = [];
const dataPath = join(ROOT, 'data.json');
if (existsSync(dataPath)) {
  try { const prev = JSON.parse(readFileSync(dataPath, 'utf8')); history = prev.history || []; daily = prev.daily || []; } catch {}
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

const data = { ts: Date.now(), zhipu, volc, deepseek, xf, qianfan, intel, history, daily };
writeFileSync(dataPath, JSON.stringify(data));
if (zhipu && !zhipu.error) console.log(`[智谱] OK ${zhipu.level} ` + zhipu.limits.map((l) => `${l.label}=${l.pct.toFixed(0)}%`).join(' '));
else if (zhipu?.error) console.log('[智谱] 未采集成功');
else console.log('[智谱] 未配置（config.json 的 zhipuKey 为空，跳过）');
if (volc && !volc.error) console.log(`[火山] OK ${volc.edition} ` + volc.periods.map((p) => `${p.key}=${p.pct.toFixed(1)}%`).join(' '));
else console.log('[火山] 未采集成功：' + (volc?.error || '未知'));
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
