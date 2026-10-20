// 本地面板服务：静态托管 plan-monitor 目录，数据过期时自动重采集
// 用法：node serve.mjs   （监听 127.0.0.1:8791，由 tailscale serve 暴露给 tailnet）
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 8791;
const STALE_MS = 90 * 1000; // data.json 超过 90 秒视为过期

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

let updating = null; // 防并发重采集

// data.json 过期 → 后台运行 update.mjs（--no-push：推送统一由计划任务负责，避免 git 竞争）
function maybeUpdate() {
  if (updating) return updating;
  updating = (async () => {
    try {
      const st = await stat(join(ROOT, 'data.json'));
      if (Date.now() - st.mtimeMs < STALE_MS) return;
      console.log('[serve] data.json 已过期，重新采集…');
      await new Promise((resolve) => {
        const p = spawn('node', ['update.mjs', '--no-push'], { cwd: ROOT, shell: true });
        p.on('close', (c) => { console.log('[serve] 采集完成，退出码 ' + c); resolve(); });
        p.on('error', (e) => { console.error('[serve] 采集失败: ' + e.message); resolve(); });
      });
    } catch { /* data.json 不存在等，忽略 */ }
    finally { setTimeout(() => { updating = null; }, 1000); }
  })();
  return updating;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let path = decodeURIComponent(url.pathname);
    if (path.startsWith('/plan')) path = path.slice(5) || '/'; // 兼容 tailnet 的 /plan 挂载前缀
    if (path === '/' || path === '/plan' || path === '/plan/') path = '/index.html';

    // 数据文件：先确保新鲜再返回
    if (path === '/data.json') {
      await maybeUpdate();
      const body = await readFile(join(ROOT, 'data.json'));
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    // 其他静态文件（禁止路径穿越）
    const file = join(ROOT, path.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[serve] 面板服务已启动 → http://127.0.0.1:${PORT}`));
