// Coding Plan 额度采集 → data.json → git push（GitHub Pages 数据源）
// 用法：node update.mjs [--no-push]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NO_PUSH = process.argv.includes('--no-push');

const pad = (n) => String(n).padStart(2, '0');

// ---------- 配置 ----------
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
if (!cfg.zhipuKey) { console.error('✗ config.json 缺少 zhipuKey'); process.exit(1); }

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

// ---------- 主流程 ----------
const zhipu = await fetchZhipu();
const volc = fetchVolc();

const zWorstPct = Math.max(...zhipu.limits.map((l) => l.pct));
const vSessionPct = volc.periods.find((p) => p.key === 'session')?.pct ?? null;

// history：追加本次快照，保留最近 200 条
let history = [];
const dataPath = join(ROOT, 'data.json');
if (existsSync(dataPath)) {
  try { history = JSON.parse(readFileSync(dataPath, 'utf8')).history || []; } catch {}
}
history.push({ ts: Date.now(), zWorstPct, vSessionPct });
history = history.slice(-200);

const data = { ts: Date.now(), zhipu, volc, history };
writeFileSync(dataPath, JSON.stringify(data));
console.log(`[智谱] OK ${zhipu.level} ` + zhipu.limits.map((l) => `${l.label}=${l.pct.toFixed(0)}%`).join(' '));
console.log(`[火山] OK ${volc.edition} ` + volc.periods.map((p) => `${p.key}=${p.pct.toFixed(1)}%`).join(' '));

// ---------- 推送 ----------
if (NO_PUSH) { console.log('（--no-push：跳过 git 推送）'); process.exit(0); }
const git = (args) => {
  const r = spawnSync('git', args, { shell: true, encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败: ' + ((r.stderr || '') + (r.stdout || '')).slice(0, 300));
  return r.stdout;
};
git(['add', 'data.json']);
const staged = git(['status', '--porcelain', 'data.json']).trim();
if (!staged) { console.log('数据无变化，跳过推送'); process.exit(0); }
git(['commit', '-m', `snapshot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
git(['push']);
console.log('✓ 已推送，Pages 稍后自动更新');
