// dsh-quick-pick — 极简网页代码选区插件（client 端）
//
// 功能：在 DeepSeek Harness 桌面端中，无论当前是：
// 1) 右侧「浏览器」页签（Electron <webview>）
// 2) 还是「HTML 文件预览」页签（如 demo/index.html，基于 iframe 沙箱）
// 均可直接点选页面上的任意元素，精准提取其 CSS 选择器、HTML 代码、文本、关键样式、
// 以及 React Fiber 源码定位（文件名 + 行号），一键写入对话输入框，供 AI 精准修改。

(function () {
	'use strict';

	var SRC = 'dsh-quick-pick';
	var HUD = null;
	var ACTIVE = false;
	var CTX = null;
	var LAST_ERR = '';
	var pollTimer = null;

	// ── 注入到目标页面（webview / iframe）内部执行的高亮与提取探针 ────────────────
	var INJECT_SCRIPT = String.raw`(function () {
		if (window.__dshPickerActive) return;
		window.__dshPickerActive = true;

		var overlay = document.getElementById('__dsh_hl_box');
		if (!overlay) {
			overlay = document.createElement('div');
			overlay.id = '__dsh_hl_box';
			overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;' +
				'background:rgba(59,130,246,0.18);border-radius:3px;box-sizing:border-box;display:none;transition:all 0.04s ease-out;';

			var badge = document.createElement('div');
			badge.id = '__dsh_hl_badge';
			badge.style.cssText = 'position:absolute;left:0;top:-26px;background:#1e293b;color:#f8fafc;padding:2px 8px;' +
				'font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace;border-radius:4px;white-space:nowrap;' +
				'box-shadow:0 2px 8px rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.18);pointer-events:none;';
			overlay.appendChild(badge);
			(document.body || document.documentElement).appendChild(overlay);
		}

		var hoveredEl = null;

		function updateHighlighter(el) {
			if (!el || el === overlay || overlay.contains(el)) return;
			hoveredEl = el;
			var rect = el.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				overlay.style.display = 'none';
				return;
			}
			overlay.style.display = 'block';
			overlay.style.left = rect.left + 'px';
			overlay.style.top = rect.top + 'px';
			overlay.style.width = rect.width + 'px';
			overlay.style.height = rect.height + 'px';
			overlay.style.borderColor = '#3b82f6';
			overlay.style.backgroundColor = 'rgba(59,130,246,0.18)';

			var badge = document.getElementById('__dsh_hl_badge');
			if (badge) {
				var tag = el.tagName ? el.tagName.toLowerCase() : '';
				var id = el.id ? '#' + el.id : '';
				var cls = (el.classList && el.classList.length) ? ('.' + Array.prototype.slice.call(el.classList).slice(0, 2).join('.')) : '';
				var w = Math.round(rect.width);
				var h = Math.round(rect.height);
				badge.textContent = '<' + tag + '>' + id + cls + ' (' + w + '×' + h + ')';
				if (rect.top < 30) {
					badge.style.top = '2px';
				} else {
					badge.style.top = '-26px';
				}
			}
		}

		function getCssSelector(el) {
			if (!el || el.nodeType !== 1) return '';
			if (el === document.body) return 'body';
			if (el === document.documentElement) return 'html';

			if (el.id) {
				try {
					if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id;
				} catch (e) {}
			}

			var testId = el.getAttribute('data-testid');
			if (testId) {
				try {
					if (document.querySelectorAll('[data-testid="' + CSS.escape(testId) + '"]').length === 1) {
						return '[data-testid="' + testId + '"]';
					}
				} catch (e2) {}
			}

			var path = [];
			var cur = el;
			while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
				var selector = cur.tagName.toLowerCase();
				if (cur.id) {
					try {
						if (document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
							path.unshift('#' + cur.id);
							break;
						}
					} catch (e3) {}
				}

				var sib = cur, nth = 1;
				while ((sib = sib.previousElementSibling)) {
					if (sib.tagName === cur.tagName) nth++;
				}
				if (nth > 1 || cur.nextElementSibling) {
					selector += ':nth-of-type(' + nth + ')';
				}
				path.unshift(selector);
				cur = cur.parentElement;
			}
			return path.join(' > ');
		}

		function getCleanHtml(el) {
			if (!el) return '';
			var html = el.outerHTML || '';
			if (html.length > 3500) {
				var clone = el.cloneNode(false);
				var openTag = clone.outerHTML.replace(new RegExp('<\\/[^>]+>$'), '');
				var closeTag = '<' + '/' + el.tagName.toLowerCase() + '>';
				var preview = (el.innerText || el.textContent || '').trim().slice(0, 300);
				html = openTag + '\n  <!-- 子节点内容较多已截断，部分文本: ' + preview.replace(/\n+/g, ' ') + ' -->\n' + closeTag;
			}
			return html;
		}

		function getKeyStyles(el) {
			var cs = window.getComputedStyle(el);
			var keys = [
				'display', 'position', 'width', 'height', 'color', 'background-color',
				'font-size', 'font-weight', 'font-family', 'line-height',
				'margin', 'padding', 'border', 'border-radius',
				'flex-direction', 'justify-content', 'align-items', 'gap',
				'grid-template-columns', 'opacity', 'z-index'
			];
			var res = {};
			for (var i = 0; i < keys.length; i++) {
				var k = keys[i];
				var v = cs.getPropertyValue(k);
				if (v && v !== 'normal' && v !== 'none' && v !== 'auto' && v !== 'rgba(0, 0, 0, 0)' && v !== '0px' && v !== 'visible') {
					res[k] = v;
				}
			}
			return res;
		}

		function getReactDebugInfo(el) {
			var cur = el;
			while (cur) {
				var keys = Object.keys(cur);
				var fiberKey = null;
				for (var i = 0; i < keys.length; i++) {
					if (keys[i].startsWith('__reactFiber$') || keys[i].startsWith('__reactInternalInstance$')) {
						fiberKey = keys[i];
						break;
					}
				}
				if (fiberKey && cur[fiberKey]) {
					var f = cur[fiberKey];
					var compName = '';
					var source = null;
					while (f) {
						if (!source && f._debugSource) {
							source = f._debugSource;
						}
						if (!compName && typeof f.type === 'function' && f.type.name) {
							compName = f.type.name;
						} else if (!compName && typeof f.type === 'string' && f.type !== cur.tagName.toLowerCase()) {
							compName = f.type;
						}
						if (source && compName) break;
						f = f.return;
					}
					if (source || compName) {
						return {
							component: compName || '',
							fileName: source ? source.fileName : '',
							lineNumber: source ? source.lineNumber : '',
							columnNumber: source ? source.columnNumber : ''
						};
					}
				}
				cur = cur.parentElement;
			}
			var ds = el.closest ? el.closest('[data-source-file], [data-component]') : null;
			if (ds) {
				return {
					component: ds.getAttribute('data-component') || '',
					fileName: ds.getAttribute('data-source-file') || '',
					lineNumber: ds.getAttribute('data-source-line') || '',
					columnNumber: ds.getAttribute('data-source-column') || ''
				};
			}
			return null;
		}

		function extractInfo(el) {
			var rect = el.getBoundingClientRect();
			var reactInfo = getReactDebugInfo(el);
			return {
				tag: el.tagName ? el.tagName.toLowerCase() : '',
				id: el.id || '',
				classes: Array.prototype.slice.call(el.classList || []),
				selector: getCssSelector(el),
				html: getCleanHtml(el),
				text: (el.innerText || el.textContent || '').trim().slice(0, 600),
				style: getKeyStyles(el),
				rect: {
					x: Math.round(rect.x),
					y: Math.round(rect.y),
					width: Math.round(rect.width),
					height: Math.round(rect.height)
				},
				url: window.__DSH_REAL_URL__ || window.location.href,
				react: reactInfo
			};
		}

		function postToParent(msg) {
			try {
				if (window.parent && window.parent !== window) {
					window.parent.postMessage(msg, '*');
				}
			} catch (e) {}
		}

		var cursorStyle = null;

		function startPick() {
			window.__dshPickerActive = true;
			if (!cursorStyle) {
				cursorStyle = document.createElement('style');
				cursorStyle.id = '__dsh_picker_cursor';
				cursorStyle.textContent = '*, * * { cursor: crosshair !important; }';
				(document.head || document.documentElement).appendChild(cursorStyle);
			}
			document.addEventListener('mouseover', onMouseMove, true);
			document.addEventListener('mousemove', onMouseMove, true);
			document.addEventListener('click', onClick, true);
			document.addEventListener('keydown', onKeyDown, true);
			window.addEventListener('scroll', onScroll, true);
			window.addEventListener('resize', onScroll, true);
		}

		function cleanup() {
			window.__dshPickerActive = false;
			if (cursorStyle) {
				try { cursorStyle.remove(); } catch (e) {}
				cursorStyle = null;
			}
			document.removeEventListener('mouseover', onMouseMove, true);
			document.removeEventListener('mousemove', onMouseMove, true);
			document.removeEventListener('click', onClick, true);
			document.removeEventListener('keydown', onKeyDown, true);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', onScroll, true);
			if (overlay) overlay.style.display = 'none';
		}

		window.__dshCancelPick = function () {
			window.__DSH_PICK_RESULT__ = '__CANCEL__';
			postToParent({ source: 'dsh-quick-pick', type: 'cancel' });
			cleanup();
		};

		function onMouseMove(e) {
			if (!window.__dshPickerActive) return;
			updateHighlighter(e.target);
		}

		function onScroll() {
			if (hoveredEl && window.__dshPickerActive) updateHighlighter(hoveredEl);
		}

		function onClick(e) {
			if (!window.__dshPickerActive) return;
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();

			var target = e.target;
			if (!target) {
				cleanup();
				return;
			}

			if (overlay) {
				overlay.style.borderColor = '#22c55e';
				overlay.style.backgroundColor = 'rgba(34, 197, 94, 0.35)';
			}

			var info = extractInfo(target);
			window.__DSH_PICK_RESULT__ = info;

			// 1. 发送给 parent 窗口 (iframe 场景)
			postToParent({ source: 'dsh-quick-pick', type: 'picked', payload: info });

			// 2. 发送 console 消息 (webview 场景)
			try {
				console.log('__DSH_PICK__:' + JSON.stringify(info));
			} catch (err) {}

			setTimeout(cleanup, 220);
		}

		function onKeyDown(e) {
			if (e.key === 'Escape' && window.__dshPickerActive) {
				e.preventDefault();
				e.stopPropagation();
				window.__dshCancelPick();
			}
		}

		// 监听父窗口开关信号
		window.addEventListener('message', function (ev) {
			var d = ev.data || {};
			if (d.source !== 'dsh-quick-pick') return;
			if (d.type === 'activate') {
				startPick();
			} else if (d.type === 'cancel') {
				cleanup();
			}
		});

		startPick();
	})();`;

	// ── 格式化给 AI 的提示词草稿 ────────────────────────────────────
	function buildDraft(info) {
		var lines = [];
		lines.push('【选中的页面代码与元素定位】');
		if (info.url) {
			if (info.url.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(info.url)) {
				lines.push('页面文件: ' + info.url);
			} else {
				lines.push('页面地址: ' + info.url);
			}
		}
		if (info.react) {
			if (info.react.component) lines.push('组件名称: <' + info.react.component + ' />');
			if (info.react.fileName) {
				lines.push('源码文件: ' + info.react.fileName + (info.react.lineNumber ? (':' + info.react.lineNumber) : ''));
			}
		}
		if (info.selector) lines.push('CSS 选择器: ' + info.selector);
		lines.push('元素标签: <' + info.tag + '>' +
			(info.id ? '  id="' + info.id + '"' : '') +
			(info.classes && info.classes.length ? '  class="' + info.classes.join(' ') + '"' : ''));
		if (info.text) {
			lines.push('当前文本: ' + String(info.text).replace(/\s+/g, ' ').slice(0, 300));
		}
		if (info.rect) {
			lines.push('尺寸位置: ' + info.rect.width + '×' + info.rect.height + ' @ (' + info.rect.x + ',' + info.rect.y + ')');
		}

		var sks = Object.keys(info.style || {});
		if (sks.length > 0) {
			lines.push('关键样式:');
			sks.forEach(function (k) {
				lines.push('  ' + k + ': ' + info.style[k]);
			});
		}

		lines.push('');
		lines.push('当前 HTML:');
		lines.push('```html');
		lines.push(info.html);
		lines.push('```');
		lines.push('');
		lines.push('请根据以上选取的代码和定位信息，精准修改对应源码：');
		return lines.join('\n');
	}

	// ── 写入会话输入框 ──────────────────────────────────────────
	function writeDraft(ctx, text) {
		var errs = [];
		try {
			var sessions = null;
			try { sessions = ctx.get ? ctx.get('sessions') : null; } catch (e) {}
			if (!sessions) { try { sessions = ctx.sessions; } catch (e) {} }

			if (sessions && sessions.list) {
				var snap = null;
				try { snap = sessions.list.getSnapshot ? sessions.list.getSnapshot() : null; } catch (e) {}
				var cur = null;
				if (snap) {
					if (snap.current) {
						cur = snap.current;
					} else if (snap.byId) {
						var ids = snap.ids || Object.keys(snap.byId);
						for (var i = 0; i < ids.length; i++) {
							var row = snap.byId[ids[i]];
							if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
								cur = ids[i];
								break;
							}
						}
						if (cur === null && ids.length) cur = ids[ids.length - 1];
					}
				}
				if (cur) {
					var scope = sessions.scope(cur);
					if (scope) {
						var conv = null;
						try { conv = scope.get ? scope.get('conversation') : null; } catch (e) {}
						if (!conv && ctx.get) { try { conv = ctx.get('conversation'); } catch (e) {} }

						if (conv && conv.input && typeof conv.input.for === 'function') {
							var input = conv.input.for(scope);
							var oldDraft = '';
							try {
								var snapState = input.state && input.state.getSnapshot ? input.state.getSnapshot() : null;
								oldDraft = (snapState && snapState.draft) || '';
							} catch (e) {}
							var newDraft = oldDraft.trim() ? (oldDraft + '\n\n' + text) : text;
							input.setDraft(newDraft);
							LAST_ERR = '';
							return true;
						}
					}
				}
			}
		} catch (e) {
			errs.push('官方 API: ' + e);
		}

		// DOM 兜底（兼容 React 受控组件）
		try {
			var ta = document.querySelector('textarea, [contenteditable="true"]');
			if (ta) {
				ta.focus();
				if (ta.tagName === 'TEXTAREA') {
					var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
					var currentVal = ta.value || '';
					var combined = currentVal.trim() ? (currentVal + '\n\n' + text) : text;
					setter.call(ta, combined);
					ta.dispatchEvent(new Event('input', { bubbles: true }));
					ta.dispatchEvent(new Event('change', { bubbles: true }));
					LAST_ERR = '';
					return true;
				} else {
					var currentText = ta.textContent || '';
					var combinedText = currentText.trim() ? (currentText + '\n\n' + text) : text;
					ta.textContent = combinedText;
					ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
					LAST_ERR = '';
					return true;
				}
			} else {
				errs.push('未找到输入框');
			}
		} catch (e2) {
			errs.push('DOM 兜底: ' + e2);
		}

		LAST_ERR = errs.join(' | ');
		console.warn('[' + SRC + '] 写入输入框失败:', LAST_ERR);
		return false;
	}

	function toAppUrl(rawUrl) {
		if (!rawUrl) return '';
		try {
			var u = new URL(rawUrl, window.location.href);
			if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
				return window.location.origin + u.pathname + u.search;
			}
			return u.href;
		} catch (e) {
			return rawUrl;
		}
	}

	function decodeSidebarPath(src) {
		if (!src) return '';
		try {
			var u = new URL(src, window.location.href);
			var m = /^\/sidebar\/html\/[^/]+\/(.*)$/.exec(u.pathname);
			if (m) {
				var segs = m[1].split('/').filter(Boolean).map(decodeURIComponent);
				return '/' + segs.join('/');
			}
		} catch (e) {}
		return src;
	}

	// ── 查找当前活动的所有 webview 与 iframe ────────────────────────
	function getTargetFrames() {
		var list = [];
		// 1. Electron webview
		var webviews = document.querySelectorAll('webview');
		for (var i = 0; i < webviews.length; i++) {
			var wv = webviews[i];
			var wr = wv.getBoundingClientRect();
			if (wr.width > 20 && wr.height > 20) {
				list.push({ type: 'webview', element: wv });
			}
		}
		// 2. HTML 预览 iframe
		var iframes = document.querySelectorAll('iframe');
		for (var j = 0; j < iframes.length; j++) {
			var f = iframes[j];
			var fr = f.getBoundingClientRect();
			if (fr.width > 20 && fr.height > 20 && !f.closest('#__dqp_panel')) {
				list.push({ type: 'iframe', element: f });
			}
		}
		return list;
	}

	function setStatus(html, isErr) {
		if (!HUD) return;
		var label = HUD.querySelector('span.dqp-label');
		if (label) {
			label.innerHTML = html;
			label.style.color = isErr ? '#ff8b8b' : '';
		}
	}

	function syncUI() {
		if (HUD) {
			HUD.classList.toggle('on', ACTIVE);
			var dot = HUD.querySelector('.dot');
			if (dot) dot.style.background = ACTIVE ? '#4ade80' : '#555';
			if (dot) dot.style.boxShadow = ACTIVE ? '0 0 8px #4ade80' : 'none';
		}
		var btns = document.querySelectorAll('.__dqp_toolbar_btn');
		for (var i = 0; i < btns.length; i++) {
			var b = btns[i];
			if (ACTIVE) {
				b.style.background = 'rgba(34,197,94,0.22)';
				b.style.borderColor = '#22c55e';
				b.style.color = '#86efac';
				b.innerHTML = '<span style="color:#22c55e;margin-right:4px;">●</span><span>选区中...</span>';
			} else {
				b.style.background = 'rgba(59,130,246,0.12)';
				b.style.borderColor = '#3b82f6';
				b.style.color = '#93c5fd';
				b.innerHTML = '<span style="color:#60a5fa;margin-right:4px;">✦</span><span>选区代码</span>';
			}
		}
	}

	function onElementPicked(info) {
		deactivatePick();
		if (!info) return;

		var ok = writeDraft(CTX, buildDraft(info));
		if (ok) {
			var label = (info.react && info.react.component)
				? ('<' + info.react.component + ' />')
				: (info.selector ? info.selector.slice(0, 36) : info.tag);
			setStatus('✓ 已提取代码写入对话框：' + label);
			setTimeout(function () { setStatus('选 区 代 码'); }, 3500);
		} else {
			setStatus('✗ 写入输入框失败：' + (LAST_ERR || '请确认当前在会话界面'), true);
			setTimeout(function () { setStatus('选 区 代 码'); }, 4000);
		}
	}

	// ── iframe 注入函数（处理同源与跨源 / 沙箱） ─────────────────────
	async function injectIframeForPick(frame) {
		// 1. 若同源且可直接访问 DOM，优先直接注入
		try {
			var doc = frame.contentDocument;
			if (doc && (doc.body || doc.documentElement)) {
				if (!doc.querySelector('script[data-dsh-quick-pick]')) {
					var sc = doc.createElement('script');
					sc.setAttribute('data-dsh-quick-pick', '1');
					sc.textContent = INJECT_SCRIPT;
					(doc.body || doc.documentElement).appendChild(sc);
				} else {
					if (frame.contentWindow) {
						frame.contentWindow.postMessage({ source: SRC, type: 'activate' }, '*');
					}
				}
				frame.dataset.dqpActive = '1';
				return true;
			}
		} catch (e) {
			// 跨源或沙箱限制，进入代理重挂流程
		}

		// 2. 如果已经挂过 srcdoc，直接发消息唤醒，不重复重载
		if (frame.dataset.dqpActive === '1') {
			try {
				if (frame.contentWindow) {
					frame.contentWindow.postMessage({ source: SRC, type: 'activate' }, '*');
					return true;
				}
			} catch (e2) {}
		}

		// 3. 多层策略获取 HTML
		var src = frame.src || frame.getAttribute('src');
		var rawHtml = '';
		var baseHref = '';
		var realUrl = decodeSidebarPath(src);

		if (frame.srcdoc && frame.dataset.dqpActive !== '1') {
			rawHtml = frame.srcdoc;
			baseHref = window.location.href;
		} else if (src && src !== 'about:blank') {
			// Tier 1: 同源转发路径（dsh-app://app/... 自动带桌面认证并消除跨域头）
			var appUrl = toAppUrl(src);
			try {
				var resp1 = await fetch(appUrl, { credentials: 'include' });
				if (resp1.ok) {
					rawHtml = await resp1.text();
					baseHref = appUrl.replace(/[^/]*$/, '');
				}
			} catch (e1) {}

			// Tier 2: 宿主本地直读接口（直接从磁盘读取或 node fetch，100% 不受沙箱/CORS 限制）
			if (!rawHtml) {
				try {
					var hostFetchUrl = '/quick-pick/read-html?src=' + encodeURIComponent(src);
					var resp2 = await fetch(hostFetchUrl);
					if (resp2.ok) {
						rawHtml = await resp2.text();
						baseHref = toAppUrl(src).replace(/[^/]*$/, '');
					}
				} catch (e2) {}
			}

			// Tier 3: 原始地址直读
			if (!rawHtml) {
				try {
					var resp3 = await fetch(src, { credentials: 'include' });
					if (resp3.ok) {
						rawHtml = await resp3.text();
						baseHref = src.replace(/[^/]*$/, '');
					}
				} catch (e3) {}
			}
		}

		if (!rawHtml) {
			console.warn('[' + SRC + '] 未能获取 iframe HTML，无法注入选区探针 (src: ' + src + ')');
			return false;
		}

		// 补齐 <base href="..."> 以保证页面的 CSS、图片与 JS 相对资源正常加载
		var baseTag = '<base href="' + baseHref + '">';
		if (!/<base\s/i.test(rawHtml)) {
			if (/<head\b[^>]*>/i.test(rawHtml)) {
				rawHtml = rawHtml.replace(/<head\b[^>]*>/i, function (m) { return m + baseTag; });
			} else {
				rawHtml = baseTag + rawHtml;
			}
		}

		// 拼接注入脚本与真实地址标识
		var configTag = '<script data-dsh-quick-pick>window.__DSH_REAL_URL__ = ' + JSON.stringify(realUrl) + ';</' + 'script>';
		var scriptTag = configTag + '<script data-dsh-quick-pick>' + INJECT_SCRIPT + '<' + '/script>';
		if (rawHtml.includes('</body>')) {
			rawHtml = rawHtml.replace('</body>', scriptTag + '</body>');
		} else {
			rawHtml += scriptTag;
		}

		frame.dataset.dqpOriginalSrc = src;
		frame.dataset.dqpActive = '1';
		frame.srcdoc = rawHtml;
		return true;
	}

	async function activatePick() {
		var frames = getTargetFrames();
		if (frames.length === 0) {
			setStatus('未检测到打开的网页（请先在右侧打开文件或浏览器）', true);
			setTimeout(function () { setStatus('选 区 代 码'); }, 3500);
			return;
		}

		ACTIVE = true;
		syncUI();
		setStatus('正在启动选区探针...');

		var successCount = 0;
		for (var i = 0; i < frames.length; i++) {
			var frame = frames[i];
			if (frame.type === 'webview') {
				var wv = frame.element;
				if (!wv.__dshPickListenerAttached) {
					wv.__dshPickListenerAttached = true;
					wv.addEventListener('console-message', function (e) {
						if (e.message && e.message.startsWith('__DSH_PICK__:')) {
							try {
								var data = JSON.parse(e.message.slice('__DSH_PICK__:'.length));
								onElementPicked(data);
							} catch (err) {}
						}
					});
				}
				wv.executeJavaScript(INJECT_SCRIPT).catch(function (err) {
					console.warn('[' + SRC + '] executeJavaScript failed:', err);
				});
				successCount++;
			} else if (frame.type === 'iframe') {
				var ok = await injectIframeForPick(frame.element);
				if (ok) successCount++;
			}
		}

		if (successCount > 0) {
			setStatus('选区中：移动鼠标高亮，点击提取代码（Esc 取消）');
		} else {
			ACTIVE = false;
			syncUI();
			setStatus('✗ 选区启动失败：未能加载目标页面内容', true);
			setTimeout(function () { setStatus('选 区 代 码'); }, 4000);
			return;
		}

		// webview 轮询兜底
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(async function () {
			if (!ACTIVE) {
				clearInterval(pollTimer);
				return;
			}
			var curFrames = getTargetFrames();
			for (var j = 0; j < curFrames.length; j++) {
				if (curFrames[j].type === 'webview') {
					try {
						var res = await curFrames[j].element.executeJavaScript('window.__DSH_PICK_RESULT__ || null');
						if (res) {
							await curFrames[j].element.executeJavaScript('window.__DSH_PICK_RESULT__ = null');
							if (res === '__CANCEL__') {
								deactivatePick();
							} else if (typeof res === 'object') {
								onElementPicked(res);
							}
							break;
						}
					} catch (e) {}
				}
			}
		}, 100);
	}

	function deactivatePick() {
		ACTIVE = false;
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		var frames = getTargetFrames();
		for (var i = 0; i < frames.length; i++) {
			if (frames[i].type === 'webview') {
				try {
					frames[i].element.executeJavaScript('window.__dshCancelPick && window.__dshCancelPick()');
				} catch (e) {}
			} else if (frames[i].type === 'iframe') {
				try {
					if (frames[i].element.contentWindow) {
						frames[i].element.contentWindow.postMessage({ source: 'dsh-quick-pick', type: 'cancel' }, '*');
					}
				} catch (e2) {}
			}
		}
		syncUI();
		setStatus('选 区 代 码');
	}

	function togglePick() {
		if (ACTIVE) deactivatePick();
		else activatePick();
	}

	// ── 监听 iframe / 页面发出的 postMessage ────────────────────────
	window.addEventListener('message', function (ev) {
		var d = ev.data || {};
		if (d.source !== SRC) return;
		if (d.type === 'cancel') {
			deactivatePick();
			return;
		}
		if (d.type === 'picked' && d.payload) {
			onElementPicked(d.payload);
		}
	});

	// ── 浏览器与预览工具栏自动注入「✦ 选区代码」按钮 ─────────────────
	function injectToolbarButtons() {
		var inputs = document.querySelectorAll(
			'input[placeholder*="http" i], input[placeholder*="网址" i], input[placeholder*="URL" i], [class*="addressBox"] input, [class*="address"]'
		);
		for (var i = 0; i < inputs.length; i++) {
			var input = inputs[i];
			var bar = input.closest ? input.closest('form, [class*="toolbar"]') : input.parentElement;
			if (!bar || bar.querySelector('.__dqp_toolbar_btn')) continue;

			var btn = document.createElement('button');
			btn.className = '__dqp_toolbar_btn';
			btn.type = 'button';
			btn.title = '选区代码：点击当前网页元素并提取代码到对话框 (快捷键: Cmd/Ctrl+Shift+E)';
			btn.innerHTML = '<span style="color:#60a5fa;margin-right:4px;">✦</span><span>选区代码</span>';
			btn.style.cssText =
				'display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:6px;' +
				'font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer;border:1px solid #3b82f6;' +
				'background:rgba(59,130,246,0.12);color:#93c5fd;flex:none;margin-left:5px;transition:all 0.15s;';

			btn.addEventListener('mouseenter', function () {
				if (!ACTIVE) this.style.background = 'rgba(59,130,246,0.22)';
			});
			btn.addEventListener('mouseleave', function () {
				if (!ACTIVE) this.style.background = 'rgba(59,130,246,0.12)';
			});
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				togglePick();
			});

			bar.appendChild(btn);
		}
	}

	// ── 右下角 HUD 状态栏 ─────────────────────────────────────────
	function buildHud() {
		if (HUD) return;
		var d = document.createElement('div');
		d.id = '__dqp_hud';
		d.title = '网页选区代码提取 (快捷键: Cmd/Ctrl+Shift+E，Esc 取消)';
		d.innerHTML = '<span class="dot"></span><span class="dqp-label">选 区 代 码</span>';
		d.addEventListener('click', function (e) {
			e.stopPropagation();
			e.preventDefault();
			togglePick();
		});
		['mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup'].forEach(function (ev) {
			d.addEventListener(ev, function (e) { e.stopPropagation(); });
		});
		document.body.appendChild(d);
		HUD = d;
	}

	// ── 初始化样式与观察器 ────────────────────────────────────────
	function initPlugin() {
		var st = document.createElement('style');
		st.id = '__dqp_style';
		st.textContent =
			'#__dqp_hud{position:fixed;right:14px;bottom:14px;z-index:2147483646;' +
			'font:12px/1.5 -apple-system,system-ui,sans-serif;background:#1c1c1e;color:#fff;' +
			'border-radius:10px;padding:9px 13px;box-shadow:0 6px 22px rgba(0,0,0,.35);' +
			'display:flex;align-items:center;gap:9px;user-select:none;cursor:pointer;border:1px solid #333}' +
			'#__dqp_hud .dot{width:8px;height:8px;border-radius:50%;background:#555;flex:none;transition:all 0.2s}' +
			'#__dqp_hud.on .dot{background:#4ade80;box-shadow:0 0 8px #4ade80}' +
			'#__dqp_hud:hover{background:#262628;border-color:#444}';
		(document.head || document.documentElement).appendChild(st);

		// 全局快捷键
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && ACTIVE) {
				e.stopPropagation();
				deactivatePick();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
				e.preventDefault();
				e.stopPropagation();
				togglePick();
			}
		}, true);

		// DOM 观察器：监控页面变化，自动为新打开的浏览器页签或预览页签挂载「选区代码」按钮
		var observer = new MutationObserver(function () {
			injectToolbarButtons();
		});
		observer.observe(document.body, { childList: true, subtree: true });

		return {
			name: SRC,
			inject: ['sessions'],
			apply: function (ctx) {
				CTX = ctx;
				var boot = function () {
					if (!document.body) { setTimeout(boot, 200); return; }
					buildHud();
					injectToolbarButtons();
					console.info('[' + SRC + '] ready — 点击浏览器工具栏「选区代码」或右下角 HUD 即可点选元素');
				};
				boot();
			}
		};
	}

	// ── 模块加载 ────────────────────────────────────────────────
	if (typeof window.__ModuleLoader__ !== 'undefined' &&
		typeof window.__ModuleLoader__.load === 'function') {
		window.__ModuleLoader__.load({ id: SRC, factory: initPlugin });
	} else {
		var plugin = initPlugin();
		if (plugin && typeof plugin.apply === 'function') {
			try {
				plugin.apply({
					get: function () { return undefined; },
					effect: function (fn) { try { fn(); } catch (e) {} },
					on: function () {},
				});
			} catch (e) { console.warn('[' + SRC + '] fallback apply failed:', e); }
		}
		console.info('[' + SRC + '] fallback mode');
	}
})();
