// Coding Plan 额度采集 → data.json → git push（GitHub Pages 数据源）
// 用法：node update.mjs [--no-push]  默认采集并推送；--no-push 仅本地更新
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
if (!cfg.zhipuKey) { console.error('✗ config.json 缺少 zhipuKey'); process.exit(1); }

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
  const p = spawnSync('arkcli', ['usage', 'plan', '--format', 'json'], { shell: true, encoding: 'utf8' });
  const out = (p.stdout || '') + (p.stderr || '');
  let j;
  try { j = JSON.parse(out.slice(out.indexOf('{'))); }
  catch { throw new Error('arkcli 输出无法解析（可能未登录，运行 arkcli auth login）: ' + out.slice(0, 150)); }
  const item = (j.items || [])[0];
  if (!item) throw new Error('arkcli 未返回用量: ' + out.slice(0, 150));
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

// ---------- 主流程 ----------
const zhipu = await safe(fetchZhipu, '智谱');
const volc = await safe(fetchVolc, '火山');
const deepseek = await safe(fetchDeepseek, 'DeepSeek');
const xf = await safe(fetchXf, 'xf');

const zWorstPct = zhipu?.limits?.length ? Math.max(...zhipu.limits.map((l) => l.pct)) : null;
const vSessionPct = volc?.periods?.find((p) => p.key === 'session')?.pct ?? null;

// history：追加本次快照，保留最近 200 条
let history = [];
const dataPath = join(ROOT, 'data.json');
if (existsSync(dataPath)) {
  try { history = JSON.parse(readFileSync(dataPath, 'utf8')).history || []; } catch {}
}
history.push({ ts: Date.now(), zWorstPct, vSessionPct });
history = history.slice(-200);

const data = { ts: Date.now(), zhipu, volc, deepseek, xf, history };
writeFileSync(dataPath, JSON.stringify(data));
if (zhipu && !zhipu.error) console.log(`[智谱] OK ${zhipu.level} ` + zhipu.limits.map((l) => `${l.label}=${l.pct.toFixed(0)}%`).join(' '));
else console.log('[智谱] 未采集成功：' + (zhipu?.error || '未知'));
if (volc && !volc.error) console.log(`[火山] OK ${volc.edition} ` + volc.periods.map((p) => `${p.key}=${p.pct.toFixed(1)}%`).join(' '));
else console.log('[火山] 未采集成功：' + (volc?.error || '未知'));
if (deepseek && !deepseek.error) console.log(`[DeepSeek] OK 余额 ¥${deepseek.total.toFixed(2)}（可用=${deepseek.isAvailable}）`);
else if (deepseek?.error) console.log('[DeepSeek] 未采集成功');
else console.log('[DeepSeek] 未配置（config.json 的 deepseekKey 为空，跳过）');
if (xf && !xf.error) console.log(`[xf] OK 余额 $${xf.balance.toFixed(2)} · 今日 $${xf.todayCost.toFixed(2)} / ${xf.todayTokens} tokens`);
else if (xf?.error) console.log('[xf] 未采集成功');
else console.log('[xf] 未配置（config.json 的 xf 段为空，跳过）');

// ---------- 推送 ----------
if (NO_PUSH) { console.log('（--no-push：仅本地更新 data.json）'); process.exit(0); }
const git = (args) => {
  const r = spawnSync('git', args, { shell: true, encoding: 'utf8', cwd: ROOT });
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
// 策略：每次 push 失败 → 轮换 hosts 中 github.com 的 IP → flushdns → 重试；
// 需要计划任务以最高权限运行（写 hosts 需管理员）。最终失败也不报错，commit 已保留待下轮推。
const GH_IPS = [
  '140.82.112.3', '140.82.112.4', '140.82.113.3', '140.82.113.4',
  '140.82.114.3', '140.82.114.4', '140.82.116.3', '140.82.116.4',
  '20.205.243.166', '20.27.177.113',
];
const HOSTS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
function rotateHosts() {
  try {
    const raw = readFileSync(HOSTS, 'utf8');
    const m = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(\s+github\.com)/m);
    if (!m) return 'hosts 无 github.com 条目，跳过轮换';
    const idx = GH_IPS.indexOf(m[1]);
    const next = GH_IPS[(idx + 1) % GH_IPS.length];
    const updated = raw
      .replace(/^(\d{1,3}(?:\.\d{1,3}){3})(\s+github\.com)/m, next + '$2')
      .replace(/^(\d{1,3}(?:\.\d{1,3}){3})(\s+www\.github\.com)/m, next + '$2');
    writeFileSync(HOSTS, updated, 'utf8');
    spawnSync('ipconfig', ['/flushdns'], { shell: true });
    return `${m[1]} → ${next}`;
  } catch (e) { return '轮换失败：' + String(e.message || e).slice(0, 80); }
}
let pushed = false;
const pushT0 = Date.now();
for (let i = 1; i <= 6 && !pushed; i++) {
  try { git(['push']); pushed = true; }
  catch (e) {
    const msg = String(e.message).replace(/\n/g, ' ').slice(0, 120);
    if (Date.now() - pushT0 > 150000) { console.log(`push 第${i}次失败（${msg}）；重试总时长超 150s 预算，放弃（commit 已保留，下轮再推）`); break; }
    const rot = rotateHosts();
    console.log(`push 第${i}次失败：${msg}；已轮换 GitHub IP：${rot}，5 秒后重试`);
    if (i < 6) await new Promise((r) => setTimeout(r, 5000));
  }
}
if (pushed) console.log('✓ 已推送，Pages 稍后自动更新');
