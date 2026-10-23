// 模型情报监测（独立模块）
// 采集：千帆模型清单（CLI）· 火山 Agent/Coding Plan 个人版折扣页 · DeepSeek 官方价格页
// 产出：data.json 的 intel 段（页面独立 section）+ 变更/折扣到期邮件告警（163 邮箱）
// 口径：只监测、只告警，不改任何配置（Base URL / 模型绑定一律留给用户手动改）
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_ROOT = dirname(fileURLToPath(import.meta.url));
const MAIL_TO = 'fmmujf@163.com';
const REFRESH_MS = 3 * 3600e3;   // 情报源 3 小时刷新一次（折扣/模型清单不需要 2 分钟粒度）
const EXPIRY_WARN_DAYS = 3;      // 折扣剩余 ≤3 天 → 邮件告警
const MAIL_DAILY_CAP = 5;        // 每日最多 5 封，避免刷爆 50 封/日额度
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const NPM_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '';

const readJson = (p, def) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; } };
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stripTags = (s) => String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();
const trCells = (tr) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1]));
const toNum = (s) => { const m = /-?\d+(?:\.\d+)?/.exec(String(s).replace(/,/g, '')); return m ? Number(m[0]) : null; };
const DAY = 864e5;

// 千帆/邮件 CLI 走 npm 全局 .cmd（计划任务 S4U 上下文里 PATH 可能不含 npm 目录）
function bin(name) {
  const cmd = NPM_DIR ? join(NPM_DIR, name + '.cmd') : '';
  return cmd && existsSync(cmd) ? cmd : name;
}

async function getHtml(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

// ---------- 千帆：模型清单 ----------
function collectQianfan() {
  const r = spawnSync(bin('qianfan'), ['models', 'list', '--format', 'json'], {
    encoding: 'utf8', shell: true, timeout: 60000, windowsHide: true,
  });
  if (r.status !== 0) throw new Error(((r.stderr || '') + (r.stdout || '')).slice(0, 200) || 'CLI 退出码 ' + r.status);
  const d = JSON.parse(String(r.stdout || '').replace(/^\uFEFF/, ''));
  const arr = Array.isArray(d) ? d : (d.data || d.models || d.items || []);
  const models = arr.map((m) => ({ id: String(m.id || m.modelId || ''), type: String(m.type || ''), charged: m.charge_status !== false }))
    .filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
  return { url: 'qianfan CLI: models list', models };
}

// ---------- 火山：个人版模型折扣 ----------
function parseCnDate(s) {
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:(\d{1,2}):(\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 23), +(m[5] || 59), +(m[6] || 59)).getTime();
}

function collectVolc(html) {
  // 1) 活动时段列表：<li>模型：2026年A月B日…至2026年C月D日…</li>
  const periods = [];
  for (const m of html.matchAll(/<li[^>]*>([\s\S]{0,500}?)<\/li>/gi)) {
    const t = stripTags(m[1]);
    const mm = /^(.+?)(?:模型)?\s*[:：]\s*(20\d{2}年\d{1,2}月\d{1,2}日(?:\d{1,2}:\d{2}:\d{2})?)\s*(?:至|→|~|-)\s*(20\d{2}年\d{1,2}月\d{1,2}日(?:\d{1,2}:\d{2}:\d{2})?)/.exec(t);
    if (!mm) continue;
    const start = parseCnDate(mm[2]), end = parseCnDate(mm[3]);
    if (!start || !end) continue;
    const names = mm[1].split(/[、,，/]/).map((s) => s.replace(/模型$/, '').trim()).filter(Boolean);
    for (const n of names) periods.push({ model: n, start, end });
  }
  // 2) 折扣规则表：模型 / 活动状态 / 优惠规则
  const rules = [];
  for (const tr of html.matchAll(/<tr[\s\S]{0,1600}?<\/tr>/gi)) {
    const c = trCells(tr[0]);
    if (c.length < 2) continue;
    const body = c[c.length - 1];
    if (!/折|抵扣系数/.test(body)) continue;
    const modelCell = c.find((x, i) => i < c.length - 1 && (x === 'Auto 模式' || /^[a-z0-9][a-z0-9.\-_ ]*$/i.test(x) && /-|kimi|glm|deepseek|auto/i.test(x)));
    if (!modelCell) continue;
    const dm = /享\s*(\d+(?:\.\d+)?)\s*折/.exec(body);
    let discount = dm ? Number(dm[1]) / 10 : null;               // 5 折 → 0.5
    const coef = /抵扣系数为\s*([\d.]+)/.exec(body);
    if (discount == null && coef) discount = Number(coef[1]);     // 抵扣系数 0.5
    const qm = /配额为原用量的\s*(\d+)\s*%/.exec(body);
    const multiplier = qm ? Number(qm[1]) : (discount ? Math.round(100 / discount) : null);
    const statusTxt = c.find((x) => /进行中|已结束|未开始/.test(x)) || '';
    rules.push({ model: modelCell.trim(), discount, multiplier, rule: body.slice(0, 160), statusText: statusTxt });
  }
  // 3) 合并：以时段为主，折扣规则按模型名回填
  const now = Date.now();
  const out = [];
  const seen = new Set();
  for (const p of periods) {
    if (seen.has(p.model)) continue;
    seen.add(p.model);
    const r = rules.find((x) => x.model.toLowerCase() === p.model.toLowerCase());
    const daysLeft = Math.floor((p.end - now) / DAY);
    const status = p.end < now ? 'expired' : p.start > now ? 'pending' : 'active';
    out.push({
      model: p.model,
      discount: r?.discount ?? null,
      multiplier: r?.multiplier ?? null,
      rule: r?.rule || '',
      start: new Date(p.start).toISOString(),
      end: new Date(p.end).toISOString(),
      daysLeft,
      status,
    });
  }
  out.sort((a, b) => (a.status === b.status ? a.daysLeft - b.daysLeft : a.status === 'active' ? -1 : 1));
  return { url: 'https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-model-discount', discounts: out };
}

// ---------- DeepSeek：官方价格页 ----------
function collectDeepseek(html) {
  const rows = [...html.matchAll(/<tr[\s\S]{0,1600}?<\/tr>/gi)].map((m) => trCells(m[0]));
  let ids = [], versions = [];
  for (const c of rows) {
    if (!c.length) continue;
    if (/^MODEL$/i.test(c[0])) ids = c.slice(1).filter(Boolean).map((s) => s.replace(/\s*\(\d+\)$/, ''));
    if (/^MODEL VERSION$/i.test(c[0])) versions = c.slice(1).filter(Boolean);
  }
  const price = {};   // { cacheHitOff, cacheHitPeak, cacheMissOff, cacheMissPeak, outputOff, outputPeak } → [flash, pro]
  let cur = null;
  let concurrency = null;
  for (const c of rows) {
    for (let i = 0; i < c.length; i++) {
      const t = c[i];
      if (/CACHE HIT/i.test(t)) cur = 'cacheHit';
      else if (/CACHE MISS/i.test(t)) cur = 'cacheMiss';
      else if (/1M OUTPUT/i.test(t)) cur = 'output';
      else if (/^OFF-?PEAK$/i.test(t) || /^PEAK$/i.test(t)) {
        const nums = c.slice(i + 1).filter((x) => /^\$/.test(x.trim())).map(toNum);
        if (cur && nums.length >= 2) price[cur + (/OFF/i.test(t) ? 'Off' : 'Peak')] = nums.slice(0, 2);
      }
    }
    if (/^Concurrency/i.test(c[0])) {
      const nums = c.slice(1).filter((x) => /^\d[\d,]*$/.test(x.trim())).map(toNum);
      if (nums.length >= 2) concurrency = { flash: nums[0], pro: nums[1] };
    }
  }
  const models = ids.map((id, j) => ({
    id,
    version: versions[j] || null,
    cacheHitOff: price.cacheHitOff?.[j] ?? null, cacheHitPeak: price.cacheHitPeak?.[j] ?? null,
    cacheMissOff: price.cacheMissOff?.[j] ?? null, cacheMissPeak: price.cacheMissPeak?.[j] ?? null,
    outputOff: price.outputOff?.[j] ?? null, outputPeak: price.outputPeak?.[j] ?? null,
  }));
  return { url: 'https://api-docs.deepseek.com/quick_start/pricing', models, concurrency };
}

// ---------- 告警 ----------
const VALUE_HINT = /flash|economy|lite|mini|air|turbo|fast|cheap/i;
const dt = (iso) => String(iso || '').slice(0, 10);
// 内部 discount 为倍率（0.5），对外显示为「5 折」
const fmtDis = (d) => (d ? `${+(d * 10).toFixed(1)} 折` : '折扣');

function buildAlerts(intel, state, ok = { qianfan: true, volc: true, deepseek: true }) {
  const seen = state.seen || {};
  const alerts = [];
  const push = (key, level, type, text) => {
    if (seen[key]) return;
    seen[key] = Date.now();
    alerts.push({ key, level, type, text });
  };
  const firstRun = !state.qianfanIds && !state.volc && !state.deepseek;

  // 千帆：新增 / 下线（源失败时整块跳过，不动 state）
  const qIds = intel.qianfan.models.map((m) => m.id);
  if (ok.qianfan && Array.isArray(state.qianfanIds)) {
    for (const id of qIds) if (!state.qianfanIds.includes(id)) {
      const hot = VALUE_HINT.test(id);
      push('qf:add:' + id, hot ? 'high' : 'info', '千帆新增模型',
        `千帆 Token Plan 模型清单新增 ${id}${hot ? '（命名属轻量/高性价比线，建议优先评估额度消耗）' : ''}`);
    }
    for (const id of state.qianfanIds) if (!qIds.includes(id)) push('qf:rm:' + id, 'warn', '千帆模型下线', `千帆模型 ${id} 已从清单移除`);
  }

  // 火山：折扣新增 / 加深 / 缩水 / 到期
  const prev = state.volc || {};
  const cur = {};
  if (ok.volc) {
    for (const d of intel.volc.discounts) {
      cur[d.model] = { discount: d.discount, start: d.start, end: d.end };
      const p = prev[d.model];
      const dis = fmtDis(d.discount);
      if (!p && !firstRun) push(`volc:new:${d.model}:${dt(d.start)}`, 'high', '火山折扣新增', `火山新增活动：${d.model} ${dis}，${dt(d.start)} → ${dt(d.end)}`);
      else if (p && d.discount && p.discount && d.discount < p.discount)
        push(`volc:deepen:${d.model}:${d.discount}`, 'high', '火山折扣加码', `${d.model} 折扣由 ${fmtDis(p.discount)} 加深到 ${fmtDis(d.discount)}`);
      else if (p && d.discount && p.discount && d.discount > p.discount)
        push(`volc:weaken:${d.model}:${d.discount}`, 'warn', '火山折扣缩水', `${d.model} 折扣由 ${fmtDis(p.discount)} 收窄到 ${fmtDis(d.discount)}`);
      if (d.status === 'active' && d.daysLeft >= 0 && d.daysLeft <= EXPIRY_WARN_DAYS)
        push(`volc:exp:${d.model}:${dt(d.end)}`, 'high', '折扣即将到期', `火山 ${d.model} ${dis}将于 ${dt(d.end)} 到期（剩 ${d.daysLeft} 天），到期后配额抵扣回到原倍率`);
    }
    for (const [model, p] of Object.entries(prev)) {
      if (!cur[model] && !firstRun) push(`volc:gone:${model}:${dt(p.end)}`, 'warn', '火山活动下线', `火山 ${model} 折扣活动已从页面移除（原至 ${dt(p.end)}）`);
    }
  }

  // DeepSeek：价格 / 版本变动
  const prevDs = state.deepseek || {};
  if (ok.deepseek) {
    for (const m of intel.deepseek.models) {
      const p = prevDs[m.id];
      if (!p) {
        if (!firstRun) push(`ds:new:${m.id}`, VALUE_HINT.test(m.id) ? 'high' : 'info', 'DeepSeek 新模型', `DeepSeek 价格页新增 ${m.id}（${m.version || '版本未知'}）`);
        continue;
      }
      for (const k of ['cacheHitOff', 'cacheHitPeak', 'cacheMissOff', 'cacheMissPeak', 'outputOff', 'outputPeak']) {
        if (p[k] != null && m[k] != null && p[k] !== m[k]) {
          push(`ds:price:${m.id}:${k}:${p[k]}->${m[k]}`, m[k] < p[k] ? 'high' : 'warn',
            m[k] < p[k] ? 'DeepSeek 降价' : 'DeepSeek 涨价', `DeepSeek ${m.id} ${k}：$${p[k]} → $${m[k]}（每百万 tokens）`);
        }
      }
      if (p.version && m.version && p.version !== m.version)
        push(`ds:ver:${m.id}:${m.version}`, 'info', 'DeepSeek 版本更新', `DeepSeek ${m.id} 版本：${p.version} → ${m.version}`);
    }
  }

  state.seen = seen;
  if (ok.qianfan) state.qianfanIds = qIds;
  if (ok.volc) state.volc = cur;
  if (ok.deepseek) state.deepseek = Object.fromEntries(intel.deepseek.models.map((m) => [m.id, m]));
  return alerts;
}

// ---------- 邮件 ----------
function sendMail(root, alerts, sentLog) {
  const pending = alerts.filter((a) => !sentLog.keys[a.key]);
  if (!pending.length) return { ok: true, skipped: '无未发送告警' };
  const today = ymd();
  if (sentLog.day !== today) { sentLog.day = today; sentLog.count = 0; }
  if (sentLog.count >= MAIL_DAILY_CAP) return { ok: false, skipped: `今日邮件已达上限 ${MAIL_DAILY_CAP} 封` };

  const hot = pending.filter((a) => a.level === 'high').length;
  const subject = `[模型情报] ${pending.length} 条告警${hot ? ` · ${hot} 条高优先` : ''} · ${today}`;
  const lines = [
    `# 模型情报告警（${new Date().toLocaleString('zh-CN', { hour12: false })}）`, '',
    `本次共 ${pending.length} 条，其中高优先 ${hot} 条。`, '',
    ...pending.map((a) => `- [${a.level === 'high' ? '高' : a.level === 'warn' ? '注意' : '信息'}] **${a.type}**：${a.text}`),
    '', '---', '来源：千帆 CLI 模型清单 · 火山个人版折扣页 · DeepSeek 官方价格页。',
    '本邮件只做提醒，未修改任何配置；需要换模型/换 Base URL 请自行操作。',
    '完整情报面板：https://jivonkiang.github.io/coding-plan-monitor/',
  ];
  const bodyPath = join(root, '_intel_mail.md');
  writeFileSync(bodyPath, lines.join('\n'), 'utf8');
  const bodyRel = '_intel_mail.md';   // CLI 只接受相对 cwd 的路径

  // 直接调 node + 入口脚本：走 .cmd 且 shell:true 时含空格的 --subject 会被拆成多个参数导致 Usage 报错
  const RUN = join(NPM_DIR, 'node_modules/@tencent-qqmail/agently-cli/scripts/run.js');
  const useNode = NPM_DIR && existsSync(RUN);
  const r = useNode
    ? spawnSync(process.execPath, [RUN, 'message', '+send', '--to', MAIL_TO, '--subject', subject,
        '--body-file', bodyRel, '--confirmed'], { cwd: root, encoding: 'utf8', shell: false, timeout: 120000, windowsHide: true })
    : spawnSync(bin('agently-cli'), ['message', '+send', '--to', MAIL_TO, '--subject', subject,
        '--body-file', bodyRel, '--confirmed'], { cwd: root, encoding: 'utf8', shell: false, timeout: 120000, windowsHide: true });
  try { unlinkSync(bodyPath); } catch {}
  let out = null;
  try { out = JSON.parse(String(r.stdout || '').replace(/^\uFEFF/, '')); } catch {}
  if (r.status === 0 && out?.ok !== false) {
    for (const a of pending) sentLog.keys[a.key] = Date.now();
    sentLog.count += 1;
    sentLog.lastSentAt = Date.now();
    return { ok: true, sent: pending.length, to: MAIL_TO };
  }
  return { ok: false, error: ((r.stderr || '') + (r.stdout || '')).slice(0, 300) };
}

// ---------- 主入口 ----------
export async function collectIntel(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const cachePath = join(root, 'intel-cache.json');
  const statePath = join(root, 'intel-state.json');
  const sentPath = join(root, 'intel-sent.json');

  const cache = readJson(cachePath, null);
  if (!opts.force && cache && Date.now() - cache.ts < REFRESH_MS) {
    return { ...cache.intel, cached: true, nextRefreshAt: cache.ts + REFRESH_MS };
  }

  const sources = [];
  const intel = {
    ts: Date.now(), refreshedAt: new Date().toISOString(),
    sources, qianfan: { count: 0, models: [] }, volc: { discounts: [] }, deepseek: { models: [] }, alerts: [],
  };

  try { const q = collectQianfan(); intel.qianfan = { count: q.models.length, models: q.models }; sources.push({ name: '千帆模型清单', ok: true, url: q.url }); }
  catch (e) { sources.push({ name: '千帆模型清单', ok: false, url: 'qianfan CLI', error: String(e.message || e).slice(0, 160) }); }

  try { const v = collectVolc(await getHtml('https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-model-discount'));
    intel.volc = { discounts: v.discounts }; sources.push({ name: '火山个人版折扣', ok: true, url: v.url }); }
  catch (e) { sources.push({ name: '火山个人版折扣', ok: false, url: 'ark.volcengine.com', error: String(e.message || e).slice(0, 160) }); }

  try { const d = collectDeepseek(await getHtml('https://api-docs.deepseek.com/quick_start/pricing'));
    intel.deepseek = { models: d.models, concurrency: d.concurrency }; sources.push({ name: 'DeepSeek 官方价格', ok: true, url: d.url }); }
  catch (e) { sources.push({ name: 'DeepSeek 官方价格', ok: false, url: 'api-docs.deepseek.com', error: String(e.message || e).slice(0, 160) }); }

  sources.push({ name: '智谱 bigmodel 价格', ok: false, unsupported: true, url: 'https://bigmodel.cn/pricing', error: 'SPA 渲染，纯抓取拿不到价目表，未覆盖（不编造）' });

  // 有源失败时不参与“变更判定”，避免把网络故障误报成模型下线/折扣结束
  const okName = Object.fromEntries(sources.map((s) => [s.name, s.ok]));
  const ok = { qianfan: !!okName['千帆模型清单'], volc: !!okName['火山个人版折扣'], deepseek: !!okName['DeepSeek 官方价格'] };
  const state = readJson(statePath, {});
  intel.alerts = buildAlerts(intel, state, ok);
  intel.sourceOk = ok;
  writeJson(statePath, state);

  const sentLog = readJson(sentPath, { day: '', count: 0, keys: {} });
  intel.mail = sendMail(root, intel.alerts, sentLog);
  writeJson(sentPath, sentLog);
  // 邮件没发出去 → 撤销 seen 标记，下一轮刷新重试（否则这条告警会被永久吞掉）
  if (intel.mail && intel.mail.ok === false && intel.alerts.length) {
    for (const a of intel.alerts) delete state.seen[a.key];
    writeJson(statePath, state);
  }

  writeJson(cachePath, { ts: intel.ts, intel });
  return { ...intel, cached: false, nextRefreshAt: intel.ts + REFRESH_MS };
}

// 允许直接运行：node intel.mjs [--force]（自查用，不写 data.json）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await collectIntel({ force: process.argv.includes('--force') });
  console.log(JSON.stringify({ sources: r.sources, qianfan: r.qianfan.count, volc: r.volc.discounts, deepseek: r.deepseek.models, alerts: r.alerts, mail: r.mail }, null, 1));
}