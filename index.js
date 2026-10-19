// dsh-quick-pick — 极简网页代码选区插件（host 端）
// 
// 本插件利用 DeepSeek Harness 桌面端的 Electron 环境，直接对内置浏览器（webview）
// 进行元素代码选区与提取，无需启动外部无头浏览器或 CDP 服务。

export const name = 'dsh-quick-pick';
export const inject = ['webServer'];

// ── 预览文档常驻探针 ─────────────────────────────────────────────────────
// 把选区探针注入 /sidebar/html 的 HTML 响应里。这样预览文档加载时探针就
// 已经在页面里了：之后点「选区 (XPath)」只是 postMessage 叫醒它，
// 原预览帧不重载、不刷新、不跳回顶部，也不需要选区副本覆盖层。
//
// 探针完全静默（只监听 message），不激活时不影响页面任何行为。
const PROBE_SCRIPT = [
	'<script data-dsh-quick-pick>(function(){',
	'if(window.__dqpInjected)return;window.__dqpInjected=1;',
	'var A=false,H=null,HL=null,TIP=null,ST=null;',
	"function send(m){try{window.parent.postMessage(m,'*')}catch(e){}}",
	"function xp(el){if(!el||el.nodeType!==1)return'';var t=el.tagName.toLowerCase();if(t==='html')return'/html';if(t==='body')return'/html/body';",
	"var s=[],c=el;while(c&&c.nodeType===1){var n=c.tagName.toLowerCase();if(n==='html')break;if(n==='body'){s.unshift('body');break}",
	"var i=1,p=c.parentElement;if(p){var k=p.children;for(var j=0;j<k.length;j++){if(k[j]===c)break;if(k[j].tagName&&k[j].tagName.toLowerCase()===n)i++}}",
	"s.unshift(n+'['+i+']');c=p}return'/html/'+s.join('/')}",
	"function hl(){if(HL)return HL;HL=document.createElement('div');HL.id='__dqp_hl';",
	"HL.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,.18);border-radius:3px;box-sizing:border-box;display:none;';",
	"(document.body||document.documentElement).appendChild(HL);return HL}",
	"function tip(){if(TIP)return TIP;TIP=document.createElement('div');TIP.id='__dqp_tip';",
	"TIP.style.cssText='position:fixed;left:0;right:0;top:0;z-index:2147483646;pointer-events:none;font:500 12px/22px -apple-system,system-ui,sans-serif;text-align:center;background:rgba(15,23,42,.86);color:#e2e8f0;';",
	"TIP.textContent='选区模式 · 点元素取 XPath · Esc 退出';(document.body||document.documentElement).appendChild(TIP);return TIP}",
	"function onOver(e){var el=e.target;if(!el||el.nodeType!==1)return;H=el;var b=hl(),r=el.getBoundingClientRect();",
	"b.style.display=(r.width||r.height)?'block':'none';b.style.left=r.left+'px';b.style.top=r.top+'px';b.style.width=r.width+'px';b.style.height=r.height+'px'}",
	"function onClick(e){if(!A)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();var el=H||e.target;var x=xp(el);off();",
	"send({source:'dsh-quick-pick',type:'picked',payload:{xpath:x,tag:el&&el.tagName?el.tagName.toLowerCase():''}})}",
	"function onKey(e){if(e.key==='Escape'&&A){e.preventDefault();e.stopPropagation();off();send({source:'dsh-quick-pick',type:'cancel'})}}",
	"function on(){if(A)return;A=true;if(!ST){ST=document.createElement('style');ST.id='__dqp_cur';ST.textContent='*,* *{cursor:crosshair !important;}';document.head&&document.head.appendChild(ST)}",
	"tip().style.display='block';document.addEventListener('mouseover',onOver,true);document.addEventListener('click',onClick,true);document.addEventListener('keydown',onKey,true)}",
	"function off(){A=false;H=null;document.removeEventListener('mouseover',onOver,true);document.removeEventListener('click',onClick,true);document.removeEventListener('keydown',onKey,true);",
	"if(HL)HL.style.display='none';if(ST){ST.remove();ST=null}if(TIP){TIP.remove();TIP=null}}",
	"window.addEventListener('message',function(ev){var d=ev.data;if(!d||d.source!=='dsh-quick-pick')return;",
	"if(d.type==='probe-ping'){send({source:'dsh-quick-pick',type:'probe-pong'})}",
	"else if(d.type==='activate'){on();send({source:'dsh-quick-pick',type:'probe-active'})}",
	"else if(d.type==='cancel'||d.type==='exit'||d.type==='deactivate'){off()}});",
	"window.addEventListener('pagehide',function(){send({source:'dsh-quick-pick',type:'probe-gone'})});",
	'})();<', '/script>'
].join('');

function injectProbe(html) {
	if (typeof html !== 'string' || html.indexOf('data-dsh-quick-pick') >= 0) return html;
	const m = /<\/body\s*>/i.exec(html);
	if (m) return html.slice(0, m.index) + PROBE_SCRIPT + html.slice(m.index);
	const m2 = /<\/html\s*>/i.exec(html);
	if (m2) return html.slice(0, m2.index) + PROBE_SCRIPT + html.slice(m2.index);
	return html + PROBE_SCRIPT;
}

// 包装 better-sidebar 的 /sidebar/html 路由：只改 text/html 响应体。
// better-sidebar 可能晚于本插件加载，所以调用方要轮询重试。
function installPreviewProbe(webServer) {
	const table = webServer && webServer.prefixes;
	if (!table || typeof table.get !== 'function') return false;
	const route = table.get('/sidebar/html');
	if (!route || route.__dqpProbeWrapped || typeof route.handler !== 'function') return false;
	route.__dqpProbeWrapped = true;
	const original = route.handler;

	route.handler = async function (req, res) {
		if (req.method !== 'GET') return original(req, res);

		const chunks = [];
		let head = null;
		const origWriteHead = res.writeHead;
		const origWrite = res.write;
		const origEnd = res.end;

		res.writeHead = function (status, headers) {
			head = { status: status, headers: headers || {} };
			return res;
		};
		res.write = function (chunk) {
			if (chunk !== undefined && chunk !== null) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return true;
		};
		res.end = function (chunk) {
			if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return res;
		};

		let failure = null;
		try {
			await original(req, res);
		} catch (err) {
			failure = err;
		} finally {
			res.writeHead = origWriteHead;
			res.write = origWrite;
			res.end = origEnd;
		}
		if (failure) {
			try { res.destroy(); } catch (e) {}
			return;
		}
		let body = Buffer.concat(chunks);
		if (head === null) {
			res.end(body);
			return;
		}
		let headers = head.headers;
		if (Array.isArray(headers)) {
			headers = Object.fromEntries(headers);
		}
		headers = { ...headers };
		const ctype = String(headers['content-type'] || headers['Content-Type'] || '');
		if (/text\/html/i.test(ctype) && body.length > 0) {
			const text = body.toString('utf8');
			if (text.indexOf('data-dsh-quick-pick') < 0) {
				body = Buffer.from(injectProbe(text), 'utf8');
			}
		}
		delete headers['content-length'];
		delete headers['Content-Length'];
		res.writeHead(head.status, headers);
		res.end(body);
	};
	return true;
}

export function apply(ctx) {
	const webServer = ctx.webServer;

	// 预览探针路由：better-sidebar 后加载 → 轮询装钩子（幂等）
	const hookProbe = () => {
		try { installPreviewProbe(webServer); } catch (e) {}
	};
	hookProbe();
	const probeTimer = setInterval(hookProbe, 1000);
	if (probeTimer.unref) probeTimer.unref();
	ctx.on('dispose', () => clearInterval(probeTimer));

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
				res.end(JSON.stringify({ ok: true, plugin: 'dsh-quick-pick', version: '2.2.0' }));
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
