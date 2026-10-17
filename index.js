// dsh-quick-pick — 极简网页代码选区插件（host 端）
// 
// 本插件利用 DeepSeek Harness 桌面端的 Electron 环境，直接对内置浏览器（webview）
// 进行元素代码选区与提取，无需启动外部无头浏览器或 CDP 服务。

export const name = 'dsh-quick-pick';
export const inject = ['webServer'];

export function apply(ctx) {
	const webServer = ctx.webServer;

	const MIME_MAP = {
		'.html': 'text/html; charset=utf-8',
		'.htm': 'text/html; charset=utf-8',
		'.css': 'text/css; charset=utf-8',
		'.js': 'application/javascript; charset=utf-8',
		'.mjs': 'application/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.gif': 'image/gif',
		'.svg': 'image/svg+xml',
		'.webp': 'image/webp',
		'.woff': 'font/woff',
		'.woff2': 'font/woff2',
		'.ttf': 'font/ttf',
		'.otf': 'font/otf'
	};

	try {
		ctx.effect(() => webServer.register({
			kind: 'exact',
			path: '/quick-pick/ping',
			handler: async (req, res) => {
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store'
				});
				res.end(JSON.stringify({ ok: true, plugin: 'dsh-quick-pick', version: '2.1.0' }));
			}
		}), 'dsh-quick-pick: ping');

		// 路由：读取目标网页 HTML（支持从本地文件系统直接读 /sidebar/html，或 node 本地 fetch 跨域页面）
		ctx.effect(() => webServer.register({
			kind: 'prefix',
			path: '/quick-pick/read-html',
			handler: async (req, res) => {
				const origin = req.headers.origin || '*';
				res.setHeader('access-control-allow-origin', origin);
				res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
				res.setHeader('access-control-allow-headers', '*');
				if (req.method === 'OPTIONS') {
					res.writeHead(204);
					res.end();
					return;
				}
				try {
					const u = new URL(req.url, 'http://dsh.internal');
					const target = u.searchParams.get('src') || u.searchParams.get('url');
					if (!target) {
						res.writeHead(400, { 'content-type': 'application/json' });
						res.end(JSON.stringify({ ok: false, error: 'missing src parameter' }));
						return;
					}
					let content = '';
					let filePath = '';
					// 1. 如果是 /sidebar/html/ 路由，直接从本地磁盘读
					//    注意：这里的目标路径可能是「整段 URL 编码的绝对路径」
					//    （例如 %2FVolumes%2F...%2Findex.html），解码后本身自带前导斜杠，
					//    不能再补一个，否则会拼成 //Volumes/... 而读不到文件。
					const m = /\/sidebar\/html\/[^/]+\/(.*)$/.exec(target);
					if (m) {
						const segs = m[1].split('/').filter(Boolean).map(decodeURIComponent);
						const joined = segs.join('/');
						filePath = /^[a-zA-Z]:\//.test(joined) || joined.startsWith('/') ? joined : '/' + joined;
						const fs = await import('node:fs/promises');
						content = await fs.readFile(filePath, 'utf-8');
					} else {
						// 2. 否则通过 node fetch 读取
						const resp = await fetch(target, { redirect: 'follow' });
						content = await resp.text();
					}
					res.writeHead(200, {
						'content-type': 'text/plain; charset=utf-8',
						'cache-control': 'no-store'
					});
					res.end(content);
				} catch (err) {
					res.writeHead(500, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
				}
			}
		}), 'dsh-quick-pick: read-html');

		// 路由：静态资源透传服务，用于 iframe 预览时的相对路径静态资源（CSS, JS, 字体, 图片）
		ctx.effect(() => webServer.register({
			kind: 'prefix',
			path: '/quick-pick/asset',
			handler: async (req, res) => {
				const origin = req.headers.origin || '*';
				res.setHeader('access-control-allow-origin', origin);
				res.setHeader('access-control-allow-methods', 'GET,OPTIONS');
				if (req.method === 'OPTIONS') {
					res.writeHead(204);
					res.end();
					return;
				}
				try {
					const u = new URL(req.url, 'http://dsh.internal');
					const relPath = u.pathname.replace(/^\/quick-pick\/asset\/?/, '');
					const segs = relPath.split('/').filter(Boolean).map(decodeURIComponent);
					const absPath = '/' + segs.join('/');
					const { extname } = await import('node:path');
					const fs = await import('node:fs/promises');
					const ext = extname(absPath).toLowerCase();
					const mime = MIME_MAP[ext] || 'application/octet-stream';
					const data = await fs.readFile(absPath);
					res.writeHead(200, {
						'content-type': mime,
						'cache-control': 'no-cache'
					});
					res.end(data);
				} catch (err) {
					res.writeHead(404, { 'content-type': 'text/plain' });
					res.end('Asset not found: ' + String(err && err.message || err));
				}
			}
		}), 'dsh-quick-pick: asset');

		// 路由：诊断上报（client 端把关键事件 POST 过来，追加写入 ~/.dsh/logs/quick-pick.log）
		// 桌面 GUI 无法直接观察，这里留一条落盘通道便于事后定位问题。
		ctx.effect(() => webServer.register({
			kind: 'exact',
			path: '/quick-pick/log',
			handler: async (req, res) => {
				res.setHeader('access-control-allow-origin', req.headers.origin || '*');
				res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
				res.setHeader('access-control-allow-headers', '*');
				if (req.method === 'OPTIONS') {
					res.writeHead(204);
					res.end();
					return;
				}
				if (req.method !== 'POST' && req.method !== 'GET') {
					res.writeHead(405);
					res.end();
					return;
				}
				try {
					const fs = await import('node:fs');
					const os = await import('node:os');
					const path = await import('node:path');
					const dir = path.join(os.homedir(), '.dsh', 'logs');
					fs.mkdirSync(dir, { recursive: true });

					let line = '';
					if (req.method === 'GET') {
						// <img> 兜底通道：数据放在 query 里（桌面端某些沙箱下 POST 会被挡）
						const u = new URL(req.url ?? '/', 'http://dsh.internal');
						line = u.searchParams.get('event') + ' ' + (u.searchParams.get('payload') || '');
					} else {
						let body = '';
						for await (const chunk of req) {
							body += chunk;
							if (body.length > 20000) break;
						}
						line = body || '(empty)';
					}

					fs.appendFileSync(
						path.join(dir, 'quick-pick.log'),
						new Date().toISOString() + ' ' + line.slice(0, 20000) + '\n',
						'utf-8'
					);
					res.writeHead(204);
					res.end();
				} catch (err) {
					res.writeHead(500, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
				}
			}
		}), 'dsh-quick-pick: log');
	} catch (e) {
		console.warn('[dsh-quick-pick] register routes failed:', e);
	}

	ctx.on('dispose', () => {});
}
