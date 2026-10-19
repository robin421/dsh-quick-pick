// dsh-quick-pick — 网页选区插件（client 端）
//
// 设计（2026-10-17 修复版）：
//
//   DSH 现有「网页预览」帧是跨源沙箱文档（web-review 用 <sessionId>.localhost:<port>
//   独立 origin，dsh-browser 也带 sandbox），外层插件脚本读不到它的 DOM —— 所以
//   「往现有预览帧注入探针」的写法必然失效：点了按钮只有提示、页面上没有任何反应。
//   这正是此前「点击没生效」的根因（旧版 .bak-panel-* 里已写明这个结论）。
//
//   本插件改为自带选区浮层，全程走宿主同源通道：
//     1) 浮层内 iframe 通过 /quick-pick/read-html 取回目标页面 HTML，经 srcdoc 装载；
//        srcdoc 文档与宿主同源，DOM 可直接读写，选区稳定可用；
//     2) 点选元素 → 提取 Full XPath → 写入当前会话输入框（会话 API 优先，DOM 兜底）；
//     3) <base> 指回原站目录，页面相对资源（css/js/图片）照常从原站加载；
//     4) iframe 用 sandbox="allow-same-origin"：宿主能读 DOM，但页面脚本不执行，
//        避免 demo 页脚本碰触宿主 GUI。
//
//   2026-10-19 更新（用户反馈「点选区不要刷新页面」）：
//     沙箱/跨源预览帧不再改写原帧（旧做法 setAttribute + frame.srcdoc 会导致
//     预览重载、页面跳回顶部）。改为在原帧位置叠加一层「选区副本」覆盖层：
//     原预览帧自始至终不动，关闭选区后覆盖层直接移除，零刷新、零闪动。
//     同源可读的帧仍直接挂监听，同样不碰页面。
//
//   入口：网页预览地址栏旁的「✦ 选区 (XPath)」按钮（唯一注入点），
//         快捷键 Cmd/Ctrl+Shift+E 也可直接开关浮层。
//
//   注：本文件刻意只往「网页预览地址栏」所在工具栏挂按钮。历史上的
//   [class*="toolbar"] 全局扫描会把按钮挂到侧边栏/会话等各处，即「几个错误的入口」。

(function () {
	'use strict';

	var SRC = 'dsh-quick-pick';
	var CTX = null;
	var LAST_ERR = '';

	var BTN_CLASS = '__dqp_toolbar_btn';
	var PANEL_ID = '__dqp_panel';
	var TOAST_ID = '__dqp_toast';
	var URL_ID = '__dqp_url';
	var FRAME_ID = '__dqp_frame';
	var PICK_BTN_ID = '__dqp_pickbtn';
	var CLOSE_BTN_ID = '__dqp_close';
	var OPEN_BTN_ID = '__dqp_open';
	var STATUS_ID = '__dqp_status';
	var HILITE_ID = '__dqp_hilite';
	var CURSOR_ID = '__dqp_cursor';
	var URL_KEY = 'dsh-quick-pick:url';

	var PANEL = null;
	var FRAME = null;
	var FRAME_DOC = null;
	var PICKING = false;
	var HOVERED = null;
	var AUTOPICK = false;
	var PREVIEW_PICKING = false;

	// 选区副本覆盖层：盖在原预览帧上，原帧始终不改写 → 点选区不会刷新页面
	var OVERLAY_ID = '__dqp_overlay';
	var OVERLAY_FRAME_ID = '__dqp_overlay_frame';
	var OVERLAY = null;            // 覆盖层容器
	var OVERLAY_FRAME = null;      // 覆盖层里的副本 iframe
	var OVERLAY_TARGET = null;     // 被覆盖的原预览帧
	var OVERLAY_TICK = 0;          // 跟随原帧位置的定时器
	var OVERLAY_PENDING = false;   // 正在取页（Esc 退出时作废）
	var LAST_PREVIEW_BAR_REPORT = 0;
	var LAST_INPUT_COUNT = -1;
	// 同一窗口多次热重载保持同一标识，便于从日志区分不同客户端
	var CLIENT_TAG = (function () {
		try {
			var t = sessionStorage.getItem('dsh-quick-pick:tag');
			if (!t) {
				t = Math.random().toString(36).slice(2, 8);
				sessionStorage.setItem('dsh-quick-pick:tag', t);
			}
			return t;
		} catch (e) {
			return Math.random().toString(36).slice(2, 8);
		}
	})();

	function envInfo(extra) {
		var base = {
			tag: CLIENT_TAG,
			vp: window.innerWidth + 'x' + window.innerHeight,
			toolbarBtn: document.querySelectorAll('.' + BTN_CLASS).length
		};
		if (!extra) return base;
		for (var k in extra) {
			if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
		}
		return base;
	}

	function $(id) {
		return document.getElementById(id);
	}

	// ── 诊断上报：落到 ~/.dsh/logs/quick-pick.log，便于事后排查 ──────────
	// 桌面端某些协议/沙箱下 sendBeacon 与 fetch 都可能被挡（实测用户窗口的
	// 上报一度全丢），所以主通道改成 <img> GET —— 请求几乎不会被拦，
	// 数据编码进 query，host 端同样落盘。
	function report(event, data) {
		var payload;
		try {
			payload = JSON.stringify(data || null);
		} catch (e) {
			payload = 'null';
		}
		console.info('[' + SRC + '] ' + event, data || '');

		// 上报地址候选：相对路径（web 端）+ 本机常见端口（桌面端协议下相对请求不通）
		var payloadQs = 'event=' + encodeURIComponent(event) + '&payload=' + encodeURIComponent(payload.slice(0, 1800));
		var bases = [''];
		try {
			if (location.origin && location.origin.indexOf('http') === 0) bases.push(location.origin);
			bases.push('http://127.0.0.1:19387');
		} catch (e) {}

		for (var i = 0; i < bases.length; i++) {
			try {
				var probe = new Image();
				probe.src = bases[i] + '/quick-pick/log?' + payloadQs + '&_=' + Date.now();
			} catch (e2) {}
		}

		// 兜底：正常环境下的 POST 通道
		try {
			fetch('/quick-pick/log', {
				method: 'POST',
				keepalive: true,
				credentials: 'omit',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ event: event, data: data || null })
			}).catch(function () {});
		} catch (e2) {}
	}

	// ── CSS 选择器 / DOM 路径 → Full XPath ─────────────────────────────
	// web-review 的 bridge 给出的是 CSS 形式路径，例如
	//   "html > body > div#app > div:nth-of-type(2) > button"
	// 这里把它翻成对 AI 更通用的 Full XPath。
	function convertSelectorToXPath(sel, defaultTag) {
		var raw = String(sel || '').trim();
		if (!raw) return defaultTag ? '//' + String(defaultTag).toLowerCase() : '';

		var parts = raw.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
		if (!parts.length) return defaultTag ? '//' + String(defaultTag).toLowerCase() : '';

		var segs = [];
		for (var i = 0; i < parts.length; i++) {
			var seg = parts[i];
			var tag = /^([a-zA-Z][a-zA-Z0-9_-]*)/.exec(seg);
			var tagName = tag ? tag[1].toLowerCase() : '*';
			var idMatch = /#([A-Za-z_][\w-]*)/.exec(seg);
			var nth = /:nth-of-type\((\d+)\)/.exec(seg);

			if (tagName === 'html' || tagName === 'body') {
				segs.push(tagName);
			} else if (idMatch) {
				segs.push((tag ? tagName : '*') + '[@id="' + idMatch[1] + '"]');
			} else if (nth) {
				segs.push(tagName + '[' + nth[1] + ']');
			} else {
				// web-review 只在同标签兄弟竞争时才写 nth-of-type，没有它即为该标签的第 1 个
				segs.push(tagName + '[1]');
			}
		}

		var joined = segs.join('/');
		return (segs[0] === 'html' || segs[0] === 'body') ? '/' + joined : '//' + joined;
	}

	// ── 驱动「当前网页预览」的选区（不新开任何窗口） ─────────────────────
	// 预览帧是独立 origin 的沙箱文档，插件无法往里注入探针；但 web-review 已经
	// 在帧里放了 bridge，它的选区开关能驱动选区，选中事件会 postMessage 回宿主。
	// 所以 quick-pick 的做法是：点它的按钮 → 截获选中事件 → 写 Full XPath。
	//
	// 全页查找该开关（实测它不一定位于 [data-webview-ui] 容器内），并排除两类干扰：
	//   1) 侧边栏那个「选区批注：打开网页预览」—— 是导航按钮，点了会开新页签
	//      （这正是此前"点选区却打开新页面"的根因）；
	//   2) quick-pick 自己的入口按钮。
	function findPreviewPickButton() {
		var btns = document.querySelectorAll('button, [role="button"]');
		for (var i = 0; i < btns.length; i++) {
			var b = btns[i];
			if (!b.offsetWidth && !b.offsetHeight) continue;
			if (b.id && b.id.indexOf('__dqp') === 0) continue;
			if (b.classList && b.classList.contains(BTN_CLASS)) continue;
			var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
			if (/XPath 选区/.test(label)) continue;
			if (/打开/.test(label)) continue;
			// web-review 的选区开关：aria-label「添加页面注释」/「Add page comments」；
			// 中文 title 另写作「选区批注…」。
			if (/添加页面注释|add page comments|选区批注|点击添加评论|页面批注/i.test(label)) return b;
		}
		return null;
	}

	// 找不到通道时的现场取证：把候选按钮、iframe 详情一起上报，便于一次改准
	function probePickCandidates() {
		var out = { webviewUi: document.querySelectorAll('[data-webview-ui]').length, frames: [], buttons: [] };

		var fl = document.querySelectorAll('iframe, webview, embed, object');
		for (var i = 0; i < fl.length && out.frames.length < 8; i++) {
			var f = fl[i];
			var readable = false;
			try { readable = !!f.contentDocument; } catch (e) { readable = false; }
			out.frames.push({
				tag: f.tagName.toLowerCase(),
				src: String(f.getAttribute('src') || '').slice(0, 80),
				sb: f.getAttribute('sandbox'),
				size: f.offsetWidth + 'x' + f.offsetHeight,
				vis: !!(f.offsetWidth || f.offsetHeight),
				readable: readable
			});
		}

		var btns = document.querySelectorAll('button, [role="button"]');
		for (var j = 0; j < btns.length && out.buttons.length < 24; j++) {
			var b = btns[j];
			if (!b.offsetWidth && !b.offsetHeight) continue;
			var al = b.getAttribute('aria-label') || '';
			var ti = b.title || '';
			var tx = (b.textContent || '').replace(/\s+/g, ' ').trim();
			// 只留"像功能入口"的按钮，避免被侧边栏会话列表淹没
			if (!al && !ti && !/预览|浏览器|选区|注释|批注|打开|检查|元素|刷新/.test(tx)) continue;
			if (/会话|工作区|账号|子智能体/.test(al + tx)) continue;
			out.buttons.push({
				al: al.slice(0, 24),
				ti: ti.slice(0, 30),
				tx: tx.slice(0, 20),
				cls: String(b.className || '').slice(0, 24)
			});
		}
		return out;
	}

	// 诊断出口（网络通道不可用时用）：把现场信息写进对话输入框，用户直接可复制
	function reportToDraft(title, obj) {
		try {
			var text = '【dsh-quick-pick 诊断】' + title + ' ' + JSON.stringify(obj).slice(0, 2400);
			var ok = writeDraft(CTX, text);
			if (!ok) console.warn('[' + SRC + '] 诊断写入失败:', LAST_ERR);
		} catch (e) {}
	}

	function startPreviewPick() {
		// 已经在选区中：再点一次入口就是「退出选区模式」
		if (PREVIEW_PICKING || PICKING) {
			exitPickMode();
			return true;
		}

		// 1) 优先在本插件自己的通道里选区：同源帧原地挂监听、沙箱帧叠副本，
		//    两条路都不碰原预览（不刷新）。web-review 的开关放到后面兜底，
		//    因为它可能让预览重新加载一次。
		if (pickInPageFrame()) {
			// 同源原地挂监听时 pickInPageFrame 不弹提示，这里补一条；
			// 沙箱副本分支自己已提示过（或正在取页），避免叠加
			if (!PREVIEW_PICKING && !OVERLAY && !OVERLAY_PENDING) {
				showToast('选区已开启：在当前网页上点元素，点一下即写入 Full XPath（Esc 取消）', false);
			}
			report('preview-pick', { ok: true, how: 'page-frame' });
			return true;
		}

		// 2) 兜底：有 web-review 的选区开关就用它（它自带页面桥，能给出元素快照）
		var btn = findPreviewPickButton();
		if (btn) {
			if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
				showToast('预览还没就绪：等页面加载完，或先在地址栏打开一个能访问的网址', true);
				report('preview-pick', { ok: false, reason: 'disabled' });
				return false;
			}
			try { btn.click(); } catch (e) {}
			setEntryPicking(true);
			showToast('选区已开启：在当前网页上点元素，Full XPath 会写进输入框', false);
			report('preview-pick', { ok: true, how: 'web-review' });
			return true;
		}

		// 3) 都不可用：把现场信息写进输入框（网络日志通道不通时的唯一定位手段）
		var probe = probePickCandidates();
		showToast('当前网页读不到 DOM（跨源沙箱），现场信息已写入输入框', true);
		report('preview-pick', { ok: false, reason: 'no-channel', probe: probe });
		reportToDraft('无法在当前网页选区', probe);
		return false;
	}

	// 入口按钮的「选区中」状态（选中/取消后自动复位）
	function setEntryPicking(on) {
		PREVIEW_PICKING = !!on;
		renderToolbarButtons();
	}

	// ── Full XPath 计算 ────────────────────────────────────────────────
	function fullXPath(el) {
		if (!el || el.nodeType !== 1) return '';
		var tag = el.tagName.toLowerCase();
		if (tag === 'html') return '/html';
		if (tag === 'body') return '/html/body';

		var segs = [];
		var cur = el;
		while (cur && cur.nodeType === 1) {
			var t = cur.tagName.toLowerCase();
			if (t === 'html') break;
			if (t === 'body') { segs.unshift('body'); break; }

			var idx = 1;
			var parent = cur.parentElement;
			if (parent) {
				var kids = parent.children;
				for (var i = 0; i < kids.length; i++) {
					var k = kids[i];
					if (k === cur) break;
					if (k.tagName && k.tagName.toLowerCase() === t) idx++;
				}
			}
			segs.unshift(t + '[' + idx + ']');
			cur = parent;
		}
		return '/html/' + segs.join('/');
	}

	// ── 写入会话输入框 ─────────────────────────────────────────────────
	function writeDraft(ctx, text) {
		var errs = [];

		try {
			var sessions = null;
			try { sessions = ctx && ctx.get ? ctx.get('sessions') : null; } catch (e) {}
			if (!sessions) { try { sessions = ctx ? ctx.sessions : null; } catch (e) {} }

			if (sessions && sessions.list) {
				var cur = null;
				try {
					var snap = sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
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
				} catch (e) {}

				if (cur) {
					var scope = sessions.scope(cur);
					var conv = null;
					try { conv = scope && scope.get ? scope.get('conversation') : null; } catch (e) {}
					if (!conv && ctx && ctx.get) { try { conv = ctx.get('conversation'); } catch (e) {} }

					if (conv && conv.input && typeof conv.input.for === 'function') {
						var input = conv.input.for(scope);
						var oldDraft = '';
						try {
							var st = input.state && input.state.getSnapshot ? input.state.getSnapshot() : null;
							oldDraft = (st && st.draft) || '';
						} catch (e) {}
						var next = oldDraft.trim() ? (oldDraft.trimEnd() + ' ' + text) : text;
						input.setDraft(next);
						LAST_ERR = '';
						return true;
					}
					errs.push('会话输入接口不可用');
				} else {
					errs.push('未找到当前会话');
				}
			} else {
				errs.push('sessions 服务不可用');
			}
		} catch (e) {
			errs.push('API: ' + e);
		}

		// DOM 兜底：只在会话输入框候选里找，避免命中页面上无关的可编辑区
		try {
			var cands = document.querySelectorAll('textarea, [contenteditable="true"]');
			var ta = null;
			for (var j = 0; j < cands.length; j++) {
				var node = cands[j];
				if (node.closest && node.closest('#' + PANEL_ID)) continue;
				ta = node;
				break;
			}
			if (ta) {
				ta.focus();
				if (ta.tagName === 'TEXTAREA') {
					var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
					var curVal = ta.value || '';
					var combined = curVal.trim() ? (curVal.trimEnd() + ' ' + text) : text;
					setter.call(ta, combined);
					ta.dispatchEvent(new Event('input', { bubbles: true }));
					ta.dispatchEvent(new Event('change', { bubbles: true }));
				} else {
					var curText = ta.textContent || '';
					ta.textContent = curText.trim() ? (curText.trimEnd() + ' ' + text) : text;
					ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
				}
				LAST_ERR = '';
				return true;
			}
			errs.push('未找到输入框');
		} catch (e2) {
			errs.push('DOM: ' + e2);
		}

		LAST_ERR = errs.join(' | ');
		console.warn('[' + SRC + '] 写入失败:', LAST_ERR);
		return false;
	}

	// ── Toast ──────────────────────────────────────────────────────────
	function showToast(msg, isErr) {
		var toast = $(TOAST_ID);
		if (!toast) {
			toast = document.createElement('div');
			toast.id = TOAST_ID;
			toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%) translateY(-10px);z-index:2147483647;' +
				'padding:8px 18px;border-radius:8px;font:500 13px/1.4 -apple-system,system-ui,sans-serif;' +
				'box-shadow:0 8px 24px rgba(0,0,0,0.45);pointer-events:none;transition:all 0.22s cubic-bezier(0.16,1,0.3,1);opacity:0;max-width:80vw;word-break:break-all;text-align:center;';
			document.body.appendChild(toast);
		}
		toast.style.background = isErr ? '#7f1d1d' : '#0f172a';
		toast.style.color = isErr ? '#fecaca' : '#f8fafc';
		toast.style.border = isErr ? '1px solid #ef4444' : '1px solid #3b82f6';
		toast.textContent = msg;
		toast.style.opacity = '1';
		toast.style.transform = 'translateX(-50%) translateY(0)';
		clearTimeout(toast.__timer);
		toast.__timer = setTimeout(function () {
			toast.style.opacity = '0';
			toast.style.transform = 'translateX(-50%) translateY(-10px)';
		}, 3200);
	}

	function setStatus(msg, isErr) {
		var el = $(STATUS_ID);
		if (!el) return;
		el.textContent = msg || '';
		el.style.color = isErr ? '#fca5a5' : '#94a3b8';
	}

	// ── 高亮框（活在 iframe 文档里） ────────────────────────────────────
	function clearHilite() {
		HOVERED = null;
		if (!FRAME_DOC) return;
		var box = FRAME_DOC.getElementById(HILITE_ID);
		if (box) box.style.display = 'none';
	}

	function showHilite(el) {
		if (!FRAME_DOC || !el || el.nodeType !== 1) return;
		if (el.id === HILITE_ID) return;
		HOVERED = el;

		var box = FRAME_DOC.getElementById(HILITE_ID);
		if (!box) {
			box = FRAME_DOC.createElement('div');
			box.id = HILITE_ID;
			box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;' +
				'background:rgba(59,130,246,0.18);border-radius:3px;box-sizing:border-box;display:none;transition:all 0.04s ease-out;';
			(FRAME_DOC.body || FRAME_DOC.documentElement).appendChild(box);
		}
		var r = el.getBoundingClientRect();
		if (!r.width && !r.height) { box.style.display = 'none'; return; }
		box.style.display = 'block';
		box.style.left = r.left + 'px';
		box.style.top = r.top + 'px';
		box.style.width = r.width + 'px';
		box.style.height = r.height + 'px';
	}

	// ── iframe 内事件（宿主脚本直接监听同源文档） ────────────────────────
	function onFrameOver(e) {
		if (!PICKING) return;
		showHilite(e.target);
	}

	function onFrameOut(e) {
		if (!PICKING) return;
		if (e.target === HOVERED) clearHilite();
	}

	function onFrameClick(e) {
		if (!PICKING) return;
		e.preventDefault();
		e.stopPropagation();
		var el = (e.target && e.target.nodeType === 1) ? e.target : HOVERED;
		if (!el) return;
		var box = FRAME_DOC && FRAME_DOC.getElementById(HILITE_ID);
		if (box) { box.style.borderColor = '#22c55e'; box.style.background = 'rgba(34,197,94,0.35)'; }
		onPicked(el);
	}

	function onFrameKey(e) {
		if (e.key === 'Escape' && PICKING) {
			e.preventDefault();
			stopPick();
		}
	}

	function detachFrame() {
		if (!FRAME_DOC) return;
		try {
			FRAME_DOC.removeEventListener('mouseover', onFrameOver, true);
			FRAME_DOC.removeEventListener('pointermove', onFrameOver, true);
			FRAME_DOC.removeEventListener('mouseout', onFrameOut, true);
			FRAME_DOC.removeEventListener('click', onFrameClick, true);
			FRAME_DOC.removeEventListener('keydown', onFrameKey, true);
		} catch (e) {}
		FRAME_DOC = null;
	}

	function onFrameLoad() {
		attachFrame();
	}

	function attachFrame() {
		if (!FRAME) return;
		var doc = null;
		try { doc = FRAME.contentDocument; } catch (e) { doc = null; }
		attachToDoc(doc, 'panel-frame');
	}

	// 把某个文档设为「选区目标」并挂上监听。浮层预览帧与当前网页预览帧共用这条通路。
	function attachToDoc(doc, label) {
		detachFrame();
		if (!doc || !doc.body) {
			report('frame-unreadable', { label: label });
			return false;
		}
		FRAME_DOC = doc;
		doc.addEventListener('mouseover', onFrameOver, true);
		doc.addEventListener('pointermove', onFrameOver, true);
		doc.addEventListener('mouseout', onFrameOut, true);
		doc.addEventListener('click', onFrameClick, true);
		doc.addEventListener('keydown', onFrameKey, true);
		report('frame-ready', { label: label, title: String(doc.title || '').slice(0, 80) });
		if (AUTOPICK) {
			AUTOPICK = false;
			startPick();
		}
		return true;
	}

	// ── 注入到沙箱预览帧里的内联探针 ────────────────────────────────────
	// 沙箱帧（opaque origin）宿主读不到 DOM，也注入不了函数；但把页面换成
	// 「srcdoc 副本 + 内联脚本」后，脚本能在帧内运行并把选中的 XPath
	// postMessage 回宿主（宿主已有 source=dsh-quick-pick / type=picked 的监听）。
	var SANDBOX_PROBE_HTML = '<script data-dsh-quick-pick>(function(){' +
		'if(window.__dqpProbe)return;window.__dqpProbe=1;' +
		'var ov=null,hov=null,on_=false;' +
		'function box(){if(ov)return ov;ov=document.createElement("div");ov.id="__dqp_probe_hl";' +
		'ov.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,.18);border-radius:3px;box-sizing:border-box;display:none;";' +
		'(document.body||document.documentElement).appendChild(ov);return ov;}' +
		'function xp(el){if(!el||el.nodeType!==1)return"";var t=el.tagName.toLowerCase();if(t==="html")return"/html";if(t==="body")return"/html/body";' +
		'var s=[],c=el;while(c&&c.nodeType===1){var n=c.tagName.toLowerCase();if(n==="html")break;if(n==="body"){s.unshift("body");break;}' +
		'var i=1,p=c.parentElement;if(p){var k=p.children;for(var j=0;j<k.length;j++){if(k[j]===c)break;if(k[j].tagName&&k[j].tagName.toLowerCase()===n)i++;}}' +
		's.unshift(n+"["+i+"]");c=p;}return"/html/"+s.join("/");}' +
		'function onOver(e){var el=e.target;if(!el||el.nodeType!==1)return;hov=el;var b=box(),r=el.getBoundingClientRect();' +
		'b.style.display=(r.width||r.height)?"block":"none";b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px";}' +
		'function onClick(e){if(!hov)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();' +
		'var x=xp(hov);try{window.parent.postMessage({source:"dsh-quick-pick",type:"picked",payload:{xpath:x}},"*");}catch(err){}off();}' +
		'function onKey(e){if(e.key==="Escape"){e.preventDefault();e.stopPropagation();off();try{window.parent.postMessage({source:"dsh-quick-pick",type:"cancel"},"*");}catch(err){}}}' +
		'function off(){on_=false;hov=null;document.removeEventListener("mouseover",onOver,true);document.removeEventListener("click",onClick,true);document.removeEventListener("keydown",onKey,true);' +
		'if(ov)ov.style.display="none";var s=document.getElementById("__dqp_probe_cursor");if(s)s.remove();' +
		'var tp=document.getElementById("__dqp_probe_tip");if(tp)tp.remove();}' +
		'function on(){if(on_)return;on_=true;var s=document.getElementById("__dqp_probe_cursor");' +
		'if(!s){s=document.createElement("style");s.id="__dqp_probe_cursor";s.textContent="*,* *{cursor:crosshair !important;}";(document.head||document.documentElement).appendChild(s);}' +
		'var tip=document.getElementById("__dqp_probe_tip");if(!tip){tip=document.createElement("div");tip.id="__dqp_probe_tip";' +
		'tip.style.cssText="position:fixed;top:0;left:0;right:0;z-index:2147483646;pointer-events:none;font:500 12px/22px -apple-system,system-ui,sans-serif;text-align:center;background:rgba(15,23,42,.86);color:#e2e8f0;";' +
		'tip.textContent="选区副本 · 原页面未刷新 · Esc 退出";(document.body||document.documentElement).appendChild(tip);}' +
		'document.addEventListener("mouseover",onOver,true);document.addEventListener("click",onClick,true);document.addEventListener("keydown",onKey,true);}' +
		'window.addEventListener("message",function(ev){var d=ev.data;if(!d||d.source!=="dsh-quick-pick")return;' +
		'if(d.type==="cancel"||d.type==="exit")off();else if(d.type==="activate")on();});' +
		'if(document.body||document.documentElement)on();else document.addEventListener("DOMContentLoaded",on);' +
		'})();<\/script>';

	// 退出选区：宿主侧状态 + 目标帧样式 + 沙箱探针 + web-review 开关，全部复位
	function exitPickMode() {
		var wasPreview = PREVIEW_PICKING;
		stopPick(true);                 // 清宿主侧的浮层/同源帧选区
		setEntryPicking(false);
		removeProbeOverlay();           // 撤掉选区副本（原预览帧本来就没动过）

		if (FRAME_DOC) {
			try {
				var st = FRAME_DOC.getElementById(CURSOR_ID);
				if (st) st.remove();
				var hl = FRAME_DOC.getElementById(HILITE_ID);
				if (hl) hl.style.display = 'none';
			} catch (e) {}
		}
		detachFrame();

		// 通知页面内的探针退出（含跨源/沙箱帧）
		var frames = document.querySelectorAll('iframe');
		for (var i = 0; i < frames.length; i++) {
			try {
				frames[i].contentWindow.postMessage({ source: SRC, type: 'cancel' }, '*');
			} catch (e) {}
		}

		// web-review 的选区开关是 toggle，再点一次即退出
		if (wasPreview) {
			var rbtn = findPreviewPickButton();
			if (rbtn && !rbtn.disabled) {
				try { rbtn.click(); } catch (e) {}
			}
		}

		report('pick-exit', { wasPreview: wasPreview });
		showToast('已退出选区模式', false);
	}

	// 沙箱/跨源帧：取回原文，供「选区副本覆盖层」使用（原帧不改写）
	//
	// 取原文必须走 host 端代理：预览帧的 src 是 dsh-app:// 协议（或跨源），
	// 在页面里 fetch(src) 拿不到内容；host 端的 /quick-pick/read-html 能直接
	// 读磁盘（/sidebar/html/... 预览路由）或回源取页。
	//
	// 桌面端窗口本身是 dsh-app:// 协议，相对路径到不了 host，
	// 所以逐通道尝试（相对 → 当前 origin → 本机端口）。
	function fetchPageHtml(src, cb) {
		var qs = '/quick-pick/read-html?src=' + encodeURIComponent(src);
		var bases = [''];
		try {
			if (location.origin && location.origin.indexOf('http') === 0) bases.push(location.origin);
		} catch (e) {}
		bases.push('http://127.0.0.1:19387');

		var i = 0;
		var tryNext = function () {
			if (i >= bases.length) {
				cb(new Error('所有取页通道都失败'));
				return;
			}
			var url = bases[i++] + qs;
			fetch(url, { credentials: 'omit' })
				.then(function (r) {
					if (!r.ok) throw new Error('HTTP ' + r.status + ' @' + url.slice(0, 40));
					return r.text();
				})
				.then(function (t) {
					if (!t || !t.trim()) throw new Error('取回内容为空');
					cb(null, t);
				})
				.catch(function () { tryNext(); });
		};
		tryNext();
	}

	// 取目标页原文：blob: 由宿主页自己创建，直接 fetch 就能拿到；
	// 其余（dsh-app://、跨源 http）走 host 端代理。
	function fetchTargetHtml(src, cb) {
		if (/^blob:/i.test(src)) {
			fetch(src, { credentials: 'omit' })
				.then(function (r) { return r.text(); })
				.then(function (t) {
					if (!t || !t.trim()) throw new Error('blob 内容为空');
					cb(null, t);
				})
				.catch(function (e) { cb(new Error('blob 读取失败：' + String((e && e.message) || e))); });
			return;
		}
		fetchPageHtml(src, cb);
	}

	// ── 选区副本覆盖层 ─────────────────────────────────────────────────
	// 原预览帧（blob / 沙箱 / 跨源）宿主读不到 DOM，但可以在它上面叠一层
	// 「同内容副本」来选区。关键：**原帧一律不动**（不 setAttribute、不写
	// srcdoc），所以点选区不会触发预览重载，也不会跳回页面顶部。
	function syncOverlayRect() {
		if (!OVERLAY || !OVERLAY_TARGET) return;
		// 预览被替换/关闭：副本跟着消失，避免盖在空处
		if (!OVERLAY_TARGET.isConnected) {
			removeProbeOverlay();
			setEntryPicking(false);
			return;
		}
		var r = null;
		try { r = OVERLAY_TARGET.getBoundingClientRect(); } catch (e) { r = null; }
		if (!r || !r.width || !r.height) {
			OVERLAY.style.display = 'none';
			return;
		}
		OVERLAY.style.display = 'block';
		OVERLAY.style.left = r.left + 'px';
		OVERLAY.style.top = r.top + 'px';
		OVERLAY.style.width = r.width + 'px';
		OVERLAY.style.height = r.height + 'px';
	}

	function removeProbeOverlay() {
		OVERLAY_PENDING = false;
		if (OVERLAY_TICK) {
			clearInterval(OVERLAY_TICK);
			OVERLAY_TICK = 0;
		}
		if (OVERLAY && OVERLAY.parentNode) {
			try { OVERLAY.parentNode.removeChild(OVERLAY); } catch (e) {}
		}
		OVERLAY = null;
		OVERLAY_FRAME = null;
		OVERLAY_TARGET = null;
	}

	function showProbeOverlay(target, html) {
		removeProbeOverlay();
		OVERLAY_TARGET = target;

		var box = document.createElement('div');
		box.id = OVERLAY_ID;
		box.style.cssText = 'position:fixed;z-index:2147483000;overflow:hidden;display:none;' +
			'border:1px solid #3b82f6;border-radius:4px;background:#fff;' +
			'box-shadow:0 0 0 2px rgba(59,130,246,.28), 0 16px 48px rgba(0,0,0,.4);';

		var f = document.createElement('iframe');
		f.id = OVERLAY_FRAME_ID;
		f.setAttribute('sandbox', 'allow-scripts');   // 副本里只跑探针，不碰宿主 GUI
		f.setAttribute('title', '选区副本');
		f.style.cssText = 'display:block;width:100%;height:100%;border:0;background:#fff;';
		f.srcdoc = html;

		box.appendChild(f);
		document.body.appendChild(box);

		OVERLAY = box;
		OVERLAY_FRAME = f;
		syncOverlayRect();
		// 预览区会随窗口/侧栏变化，低频跟随即可（不用常驻 rAF 空转）
		OVERLAY_TICK = setInterval(syncOverlayRect, 150);
		return f;
	}

	// 沙箱/跨源帧：取原文 → 复制到覆盖层 → 在副本里选区（原帧保持原样）
	function injectSandboxFrame(frame) {
		if (!frame || !document.body.contains(frame)) return false;
		var src = frame.getAttribute('src') || '';
		if (!src) return false;

		// 覆盖层已开着同一帧 → 只把探针叫醒，不重新取页
		if (OVERLAY && OVERLAY_TARGET === frame && OVERLAY_FRAME) {
			try { OVERLAY_FRAME.contentWindow.postMessage({ source: SRC, type: 'activate' }, '*'); } catch (e) {}
			setEntryPicking(true);
			report('overlay-activate', { src: src.slice(0, 80) });
			return true;
		}
		removeProbeOverlay();

		// 取页期间再点一次：直接忽略（不重复请求，也不叠加副本）
		if (OVERLAY_PENDING) {
			report('overlay-debounce', { src: src.slice(0, 80) });
			return true;
		}
		OVERLAY_PENDING = true;

		fetchTargetHtml(src, function (err, html) {
			if (!OVERLAY_PENDING) return;   // 取页期间用户已按 Esc 退出
			OVERLAY_PENDING = false;
			if (err) {
				var msg = String((err && err.message) || err);
				report('overlay-open', { ok: false, error: msg });
				showToast('取不回预览页原文，无法选区：' + msg.slice(0, 60), true);
				return;
			}
			if (!document.body.contains(frame)) {
				report('overlay-open', { ok: false, error: 'frame detached' });
				return;
			}
			try {
				// 原文自带 <base> 时不再插第二个（只认第一个，插了也没用）；
				// blob: 没有可用的目录，不插（副本里的相对资源本就取不到）
				var baseTag = '';
				if (!/^blob:/i.test(src) && !/<base\b/i.test(html)) {
					baseTag = '<base href="' + src.replace(/[^/]*$/, '').replace(/"/g, '&quot;') + '">';
				}
				var inject = baseTag + SANDBOX_PROBE_HTML;
				var out = /<head\b[^>]*>/i.test(html)
					? html.replace(/<head\b[^>]*>/i, function (m) { return m + inject; })
					: inject + html;
				showProbeOverlay(frame, out);
				setEntryPicking(true);
				showToast('选区已开启：在预览副本上点元素，原页面不会刷新（Esc 退出）', false);
				report('overlay-open', { ok: true, src: src.slice(0, 90) });
			} catch (e) {
				report('overlay-open', { ok: false, error: 'overlay: ' + e });
			}
		});
		return true;
	}

	// ── 直接在当前网页预览帧里选区 ─────────────────────────────────────
	// 依次尝试三条通道，全部不新开任何窗口：
	//   1) 同源可读的 iframe → 宿主直接挂监听（不动页面）
	//   2) Electron <webview> → executeJavaScript 注入探针
	//   3) 沙箱 iframe → 覆盖层副本 + 内联探针（原帧不改写）
	function pickInPageFrame() {
		// 优先真正的网页预览帧（HTML 预览 / 内置浏览器），避免先命中别的插件帧
		var list = Array.prototype.slice.call(document.querySelectorAll('iframe'));
		var rank = function (f) {
			if (f.hasAttribute && f.hasAttribute('data-html-preview')) return 0;
			try { if (f.closest && f.closest('[data-webview-ui]')) return 1; } catch (e) {}
			return 2;
		};
		list.sort(function (a, b) { return rank(a) - rank(b); });

		var sandboxCandidates = [];
		for (var i = 0; i < list.length; i++) {
			var f = list[i];
			if (!f.offsetWidth || !f.offsetHeight) continue;
			if (f.offsetWidth < 120 || f.offsetHeight < 120) continue;
			if (PANEL && PANEL.contains(f)) continue;
			if (OVERLAY && OVERLAY.contains(f)) continue;

			var doc = null;
			try { doc = f.contentDocument; } catch (e) { doc = null; }
			if (doc && doc.body) {
				if (attachToDoc(doc, 'page-frame')) {
					report('page-frame-pick', { ok: true, how: 'same-origin', src: String(f.getAttribute('src') || '').slice(0, 100) });
					startPick();
					return true;
				}
			}
			sandboxCandidates.push(f);
		}

		var wvs = document.querySelectorAll('webview');
		for (var k = 0; k < wvs.length; k++) {
			var wv = wvs[k];
			if (!wv.offsetWidth || wv.offsetHeight < 120) continue;
			if (typeof wv.executeJavaScript !== 'function') continue;
			try {
				wv.executeJavaScript(SANDBOX_PROBE_HTML.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
				setEntryPicking(true);
				showToast('选区已开启：在当前网页上点元素，点一下即写入 Full XPath', false);
				report('page-frame-pick', { ok: true, how: 'webview' });
				return true;
			} catch (e) {}
		}

		for (var m = 0; m < sandboxCandidates.length; m++) {
			var cand = sandboxCandidates[m];
			// 沙箱帧读不到 DOM：在原帧上叠一层选区副本，原帧保持不动、不重载
			if (injectSandboxFrame(cand)) {
				report('page-frame-pick', { ok: true, how: 'sandbox-overlay', src: String(cand.getAttribute('src') || '').slice(0, 100) });
				return true;
			}
		}

		report('page-frame-pick', { ok: false, candidates: sandboxCandidates.length });
		return false;
	}

	// ── 选区开关 ───────────────────────────────────────────────────────
	function setCrosshair(on) {
		if (!FRAME_DOC) return;
		var st = FRAME_DOC.getElementById(CURSOR_ID);
		if (on) {
			if (!st) {
				st = FRAME_DOC.createElement('style');
				st.id = CURSOR_ID;
				st.textContent = '*, * *{cursor:crosshair !important;}';
				(FRAME_DOC.head || FRAME_DOC.documentElement).appendChild(st);
			}
		} else if (st) {
			try { st.remove(); } catch (e) {}
		}
	}

	function startPick() {
		if (!FRAME_DOC) {
			showToast('页面还没就绪：请先打开网页预览，等页面加载出来再点', true);
			return;
		}
		PICKING = true;
		setCrosshair(true);
		updatePickButton();
		setStatus('选区已开启：鼠标移到元素上高亮，点击即提取 Full XPath（Esc 取消）');
		report('pick-start', { url: currentUrl() });
	}

	function stopPick(silent) {
		PICKING = false;
		clearHilite();
		setCrosshair(false);
		updatePickButton();
		if (!silent) setStatus('选区已关闭');
	}

	function togglePick() {
		if (PICKING) stopPick();
		else startPick();
	}

	// ── 选中回调 ───────────────────────────────────────────────────────
	function onPicked(el) {
		var xpath = fullXPath(el);
		stopPick(true);
		if (!xpath) {
			showToast('✗ 未能提取 XPath', true);
			return;
		}
		var ok = writeDraft(CTX, xpath);
		if (ok) {
			showToast('✓ 已填入 Full XPath：' + xpath, false);
			setStatus('已填入输入框：' + xpath);
		} else {
			showToast('✗ 填入输入框失败：' + (LAST_ERR || '未知原因'), true);
			setStatus('填入输入框失败：' + (LAST_ERR || ''), true);
		}
		report('picked', { xpath: xpath, tag: el.tagName ? el.tagName.toLowerCase() : '', ok: ok });
	}

	// ── 面板 ───────────────────────────────────────────────────────────
	function lastUrl() {
		try { return sessionStorage.getItem(URL_KEY) || ''; } catch (e) { return ''; }
	}

	// 尽力从当前预览地址栏读目标网址；读不到则用上次的
	function currentUrl() {
		var inputs = findAddressInputs();
		for (var i = 0; i < inputs.length; i++) {
			var v = (inputs[i].value || '').trim();
			if (v && /^https?:\/\//i.test(v)) return v;
		}
		return lastUrl();
	}

	function withBase(html, url) {
		var base;
		try {
			var u = new URL(url, location.href);
			base = u.origin + u.pathname.replace(/[^/]*$/, '');
		} catch (e) {
			return html;
		}
		if (/<base\s/i.test(html)) return html;
		var tag = '<base href="' + base.replace(/"/g, '&quot;') + '">';
		if (/<head\b[^>]*>/i.test(html)) {
			return html.replace(/<head\b[^>]*>/i, function (m) { return m + tag; });
		}
		return tag + html;
	}

	function loadUrl(url) {
		if (!url) {
			setStatus('请先填网址，例如 http://127.0.0.1:8765/index.html', true);
			return;
		}
		// 打开浮层就是为了选区：加载完成后自动进入选区
		AUTOPICK = true;
		setStatus('加载中…');
		try { sessionStorage.setItem(URL_KEY, url); } catch (e) {}

		fetch('/quick-pick/read-html?src=' + encodeURIComponent(url), { credentials: 'omit' })
			.then(function (r) {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				return r.text();
			})
			.then(function (html) {
				if (!html || !html.trim()) throw new Error('返回内容为空');
				stopPick(true);
				detachFrame();
				FRAME.srcdoc = withBase(html, url);
			})
			.catch(function (err) {
				setStatus('加载失败：' + (err && err.message ? err.message : err), true);
				report('load-failed', { url: url, error: String(err && err.message || err) });
			});
	}

	function createPanel() {
		if (PANEL) return PANEL;

		PANEL = document.createElement('div');
		PANEL.id = PANEL_ID;
		PANEL.style.cssText =
			'position:fixed;right:18px;top:64px;bottom:64px;width:min(62vw,880px);z-index:2147483645;' +
			'display:flex;flex-direction:column;background:#0b1220;border:1px solid #1e293b;border-radius:12px;' +
			'box-shadow:0 18px 48px rgba(0,0,0,.55);overflow:hidden;' +
			'font:13px/1.45 -apple-system,system-ui,sans-serif;color:#e2e8f0;';
		PANEL.innerHTML = [
			'<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111a2e;border-bottom:1px solid #1e293b;flex:none;">',
			'  <span style="color:#60a5fa;font-weight:700;flex:none;">✦ XPath 选区</span>',
			'  <input id="' + URL_ID + '" type="text" spellcheck="false" placeholder="输入网址，如 http://127.0.0.1:8765/index.html"',
			'    style="flex:1;min-width:0;height:28px;padding:0 10px;border-radius:6px;border:1px solid #334155;background:#0b1220;color:#e2e8f0;font:12px/1 -apple-system,system-ui,sans-serif;outline:none;">',
			'  <button id="' + OPEN_BTN_ID + '" type="button" style="flex:none;height:28px;padding:0 12px;border-radius:6px;border:1px solid #3b82f6;background:rgba(59,130,246,0.18);color:#93c5fd;font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer;">打开</button>',
			'  <button id="' + PICK_BTN_ID + '" type="button" style="flex:none;height:28px;padding:0 12px;border-radius:6px;border:1px solid #3b82f6;background:rgba(59,130,246,0.12);color:#93c5fd;font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer;">选区 (XPath)</button>',
			'  <button id="' + CLOSE_BTN_ID + '" type="button" title="关闭面板" style="flex:none;width:28px;height:28px;border-radius:6px;border:1px solid #334155;background:transparent;color:#94a3b8;font:600 13px/1 -apple-system,system-ui,sans-serif;cursor:pointer;">✕</button>',
			'</div>',
			'<div id="' + STATUS_ID + '" style="flex:none;padding:6px 10px;background:#0f172a;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">正在准备…</div>',
			'<iframe id="' + FRAME_ID + '" sandbox="allow-same-origin" title="选区页面"',
			'  style="flex:1;width:100%;border:0;background:#fff;"></iframe>'
		].join('');

		document.body.appendChild(PANEL);

		FRAME = $(FRAME_ID);
		FRAME.addEventListener('load', onFrameLoad);

		$(OPEN_BTN_ID).addEventListener('click', function () { loadUrl(($(URL_ID).value || '').trim()); });
		$(URL_ID).addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				e.preventDefault();
				loadUrl(($(URL_ID).value || '').trim());
			}
		});
		$(PICK_BTN_ID).addEventListener('click', function () { togglePick(); });
		$(CLOSE_BTN_ID).addEventListener('click', function () { closePanel(); });

		return PANEL;
	}

	function updatePickButton() {
		renderToolbarButtons();
		var btn = $(PICK_BTN_ID);
		if (btn) {
			btn.textContent = PICKING ? '选区中… (Esc)' : '选区 (XPath)';
			btn.style.background = PICKING ? 'rgba(34,197,94,0.22)' : 'rgba(59,130,246,0.12)';
			btn.style.borderColor = PICKING ? '#22c55e' : '#3b82f6';
			btn.style.color = PICKING ? '#86efac' : '#93c5fd';
		}
	}

	function openPanel(url) {
		createPanel();
		var input = $(URL_ID);
		if (input && url && !input.value) input.value = url;
		var target = (url || (input && input.value) || lastUrl() || '').trim();
		if (target) loadUrl(target);
		else setStatus('填入 demo 网址后点「打开」，再点「选区」即可点选元素');

		report('panel-open', { url: target });
		probeDom();
	}

	function closePanel() {
		stopPick(true);
		detachFrame();
		removeProbeOverlay();
		if (FRAME) {
			try { FRAME.removeEventListener('load', onFrameLoad); } catch (e) {}
			try { FRAME.srcdoc = ''; } catch (e) {}
		}
		if (PANEL && PANEL.parentNode) PANEL.parentNode.removeChild(PANEL);
		PANEL = null;
		FRAME = null;
		report('panel-close');
	}

	// ── DOM 诊断：搞不清宿主结构时，把候选地址栏与关键标记上报到日志 ──────
	function probeDom() {
		try {
			var rows = [];
			var nodes = document.querySelectorAll('input, textarea');
			for (var i = 0; i < nodes.length && i < 40; i++) {
				var el = nodes[i];
				rows.push({
					tag: el.tagName.toLowerCase(),
					type: el.getAttribute('type') || '',
					ph: String(el.getAttribute('placeholder') || '').slice(0, 40),
					cls: String(el.className || '').slice(0, 60),
					inWV: !!(el.closest && el.closest('[data-webview-ui]')),
					vis: !!(el.offsetWidth || el.offsetHeight)
				});
			}
			var btnList = [];
			try { btnList = probePickCandidates().buttons || []; } catch (e) {}
			report('dom-probe', {
				inputs: rows,
				marks: {
					webviewUi: document.querySelectorAll('[data-webview-ui]').length,
					sidebarRightToggle: document.querySelectorAll('[data-sidebar-right-toggle]').length,
					iframes: document.querySelectorAll('iframe').length,
					webviews: document.querySelectorAll('webview').length
				},
				buttons: btnList
			});
		} catch (e) {}
	}

	// 首次加载时提示一次入口位置
	function announceOnce() {
		try {
			if (sessionStorage.getItem('dsh-quick-pick:announced') === '1') return;
			sessionStorage.setItem('dsh-quick-pick:announced', '1');
		} catch (e) {}
		setTimeout(function () {
			showToast('XPath 选区已就绪：在「网页预览」工具栏上点「选区 (XPath)」，再点网页元素即可', false);
		}, 1800);
	}

	// ── 文件预览（HTML 预览）工具栏入口 ────────────────────────────────
	// 就是截图里显示「Sandbox mode: on … Temporarily disable (unsafe)」的那一行，
	// 属于右侧预览区自己的工具栏（不是对话区的卡片工具栏）。
	function findFilePreviewToolbar() {
		var btns = document.querySelectorAll('button, [role="button"]');
		for (var i = 0; i < btns.length; i++) {
			var b = btns[i];
			var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
			if (!/temporarily disable|sandbox|沙箱|临时关闭|临时禁用/i.test(label)) continue;
			var bar = b.parentElement;
			if (bar) return bar;
		}
		// 退而求其次：含「预览 / 编辑」切换的那一行
		var pv = document.querySelectorAll('button, [role="button"]');
		for (var j = 0; j < pv.length; j++) {
			var p = pv[j];
			var l2 = (p.getAttribute('aria-label') || '') + ' ' + (p.title || '') + ' ' + (p.textContent || '');
			if (!/^(预览|编辑|preview|edit)$/i.test(l2.trim())) continue;
			if (p.parentElement && p.parentElement.parentElement) return p.parentElement.parentElement;
		}
		return null;
	}

	// 工具栏按钮的统一外观（选区中 / 空闲）
	function renderToolbarButtons() {
		var on = PICKING || PREVIEW_PICKING;
		var btns = document.querySelectorAll('.' + BTN_CLASS);
		for (var i = 0; i < btns.length; i++) {
			btns[i].innerHTML = on
				? '<span style="color:#22c55e;margin-right:4px;">●</span><span>选区中…</span>'
				: '<span style="color:#60a5fa;margin-right:4px;">✦</span><span>选区 (XPath)</span>';
			btns[i].style.borderColor = on ? '#22c55e' : '#3b82f6';
			btns[i].style.background = on ? 'rgba(34,197,94,0.22)' : 'rgba(59,130,246,0.12)';
			btns[i].style.color = on ? '#86efac' : '#93c5fd';
		}
	}

	// ── 工具栏按钮：只挂「右侧内置浏览器 / 网页预览」的地址栏所在工具栏 ────
	// 内置浏览器（dsh-client-ui-sidebar-browser）的地址栏占位符是「输入 HTTP(S) 地址」，
	// 类名形如 xxx_address / xxx_addressBox；web-review 的预览地址栏是「输入网址…」。
	// 两者都要认，但绝不往常规对话区的任何工具栏里挂。
	function findAddressInputs() {
		var all = document.querySelectorAll(
			'input[placeholder*="HTTP"], input[placeholder*="网址"], input[placeholder*="URL" i], input[placeholder*="url"], ' +
			'input[placeholder*="address" i], input[class*="address" i], [class*="addressBox"] input, ' +
			'[class*="iGvAsW_address"] input, [class*="iGvAsW_addressBox"] input, ' +
			'[data-webview-ui] input, [data-webview-ui] textarea'
		);
		var out = [];
		for (var i = 0; i < all.length; i++) {
			// 浮层自己的地址栏不算挂载点，否则会再长出一个「错误入口」
			if (PANEL && PANEL.contains(all[i])) continue;
			out.push(all[i]);
		}
		return out;
	}

	// 内置浏览器的工具栏本体（兜底锚点）：即使地址栏换了元素形态也能挂上
	function findBrowserToolbar() {
		var bars = document.querySelectorAll('[class*="iGvAsW_toolbar"]');
		for (var i = 0; i < bars.length; i++) {
			if (PANEL && PANEL.contains(bars[i])) continue;
			if (!bars[i].offsetWidth && !bars[i].offsetHeight) continue;
			return bars[i];
		}
		return null;
	}

	function createToolbarButton() {
		var btn = document.createElement('button');
		btn.className = BTN_CLASS;
		btn.type = 'button';
		btn.title = 'XPath 选区：在当前网页上点选元素，把 Full XPath 填进输入框 (Cmd/Ctrl+Shift+E)';
		btn.style.cssText =
			'display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:6px;' +
			'font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer;border:1px solid #3b82f6;' +
			'background:rgba(59,130,246,0.12);color:#93c5fd;flex:none;margin-left:6px;margin-right:4px;' +
			'transition:all 0.15s;user-select:none;';
		btn.innerHTML = '<span style="color:#60a5fa;margin-right:4px;">✦</span><span>选区 (XPath)</span>';

		btn.addEventListener('mouseenter', function () {
			if (!PICKING) this.style.background = 'rgba(59,130,246,0.24)';
		});
		btn.addEventListener('mouseleave', function () {
			if (!PICKING) this.style.background = 'rgba(59,130,246,0.12)';
		});
		btn.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			startPreviewPick();
		});
		return btn;
	}

	function injectToolbarButtons() {
		// 右侧预览区两种形态，各自挂各自那一行（互不冲突）：
		//   1) HTML 文件预览 → 沙箱提示条那一行
		//   2) 内置浏览器 → 地址栏那一行
		var previewBar = findFilePreviewToolbar();
		if (previewBar && !previewBar.querySelector('.' + BTN_CLASS)) {
			previewBar.appendChild(createToolbarButton());
			// 上报节流：预览工具栏会被 React 反复重建，不加节流会把日志刷爆
			var nowTs = Date.now();
			if (nowTs - LAST_PREVIEW_BAR_REPORT > 10000) {
				LAST_PREVIEW_BAR_REPORT = nowTs;
				report('file-preview-entry', { cls: String(previewBar.className || '').slice(0, 40) });
			}
		}

		var inputs = findAddressInputs();
		var browserBar = findBrowserToolbar();
		if (browserBar && inputs.length === 0 && !browserBar.querySelector('.' + BTN_CLASS)) {
			browserBar.appendChild(createToolbarButton());
			var bbTs = Date.now();
			if (bbTs - LAST_PREVIEW_BAR_REPORT > 10000) {
				LAST_PREVIEW_BAR_REPORT = bbTs;
				report('browser-bar-entry', { cls: String(browserBar.className || '').slice(0, 40) });
			}
		}
		if (inputs.length !== LAST_INPUT_COUNT) {
			LAST_INPUT_COUNT = inputs.length;
			var samples = [];
			for (var s = 0; s < inputs.length && s < 6; s++) {
				samples.push({
					ph: String(inputs[s].getAttribute('placeholder') || '').slice(0, 40),
					cls: String(inputs[s].className || '').slice(0, 60),
					inWV: !!(inputs[s].closest && inputs[s].closest('[data-webview-ui]'))
				});
			}
			report('address-inputs', { count: inputs.length, samples: samples });
		}
		for (var i = 0; i < inputs.length; i++) {
			var input = inputs[i];
			var bar = input.parentElement;
			if (!bar) continue;
			if (bar.querySelector('.' + BTN_CLASS)) continue;
			if (input.nextSibling) bar.insertBefore(createToolbarButton(), input.nextSibling);
			else bar.appendChild(createToolbarButton());
		}
		pruneStrayButtons();
	}

	// 清掉历史上挂到别处的按钮（"错误的入口"）
	// 判断口径与注入完全一致：只保留挂在候选地址栏容器里的按钮。
	function pruneStrayButtons() {
		var bars = [];
		var inputs = findAddressInputs();
		for (var i = 0; i < inputs.length; i++) {
			var parent = inputs[i].parentElement;
			if (parent && bars.indexOf(parent) < 0) bars.push(parent);
		}
		var fpb = findFilePreviewToolbar();
		if (fpb && bars.indexOf(fpb) < 0) bars.push(fpb);
		var bb = findBrowserToolbar();
		if (bb && bars.indexOf(bb) < 0) bars.push(bb);

		var btns = document.querySelectorAll('.' + BTN_CLASS);
		for (var j = 0; j < btns.length; j++) {
			var btn = btns[j];
			if (bars.indexOf(btn.parentElement) >= 0) continue;
			report('prune-stray-button', { cls: btn.parentElement ? String(btn.parentElement.className).slice(0, 60) : '' });
			try { btn.remove(); } catch (e) {}
		}
	}

	// ── 兼容：其它预览体系（dsh-browser 等）的选区消息 ──────────────────
	window.addEventListener('message', function (ev) {
		var d = ev.data;
		if (!d || typeof d !== 'object') return;

		// 1) web-review 的预览桥：用户在「当前网页」上点选后回传选中元素
		if (d.protocol === 'dsh-web-review/bridge' && d.direction === 'frame-to-host' && d.event) {
			if (d.event.name === 'cancel-pick') {
				setEntryPicking(false);
				return;
			}
			if (d.event.name !== 'pick') return;

			setEntryPicking(false);
			var snap = (d.event.payload && d.event.payload.target && d.event.payload.target.snapshot) || {};
			// fullPath / cssPath 都是 CSS 形式，需要翻成 XPath
			var css = snap.fullPath || snap.cssPath || '';
			var xp = convertSelectorToXPath(css, snap.tagName);
			if (xp) {
				var wok = writeDraft(CTX, xp);
				showToast(wok ? ('✓ 已填入 Full XPath：' + xp) : ('✗ 填入输入框失败：' + LAST_ERR), !wok);
				report('picked', { source: 'web-review', xpath: xp, css: css, ok: wok });
			}
			return;
		}

		// 2) dsh-browser 的 review 桥
		if (d.source === 'dsh-browser' && d.kind === 'review-pick') {
			var xp2 = d.xpath || (d.target && d.target.xpath) || '';
			if (!xp2 && d.target && d.target.selector) xp2 = convertSelectorToXPath(d.target.selector, d.target.tagName);
			if (xp2) {
				var ok2 = writeDraft(CTX, xp2);
				showToast(ok2 ? ('✓ 已填入 Full XPath：' + xp2) : ('✗ 填入失败：' + LAST_ERR), !ok2);
			}
			return;
		}

		// 3) 浮层探针 / 选区副本探针
		if (d.source === SRC && d.type === 'cancel') {
			setEntryPicking(false);
			removeProbeOverlay();
			return;
		}
		if (d.source === SRC && d.type === 'picked' && d.payload && d.payload.xpath) {
			setEntryPicking(false);
			removeProbeOverlay();
			var ok3 = writeDraft(CTX, d.payload.xpath);
			showToast(ok3 ? ('✓ 已填入 Full XPath：' + d.payload.xpath) : ('✗ 填入失败：' + LAST_ERR), !ok3);
		}
	});

	// ── 初始化 ─────────────────────────────────────────────────────────
	function initPlugin() {
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && (PICKING || PREVIEW_PICKING)) {
				e.stopPropagation();
				exitPickMode();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
				e.preventDefault();
				e.stopPropagation();
				// 优先在当前网页上直接选区；只有在没有可用预览时才退回浮层
				if (!startPreviewPick()) {
					if (PANEL) closePanel();
					else openPanel(currentUrl());
				}
			}
		}, true);

		var pending = false;
		var observer = new MutationObserver(function () {
			if (pending) return;
			pending = true;
			setTimeout(function () {
				pending = false;
				injectToolbarButtons();
			}, 800);
		});

		return {
			name: SRC,
			apply: function (ctx) {
				CTX = ctx;
				var boot = function () {
					if (!document.body) { setTimeout(boot, 200); return; }
					injectToolbarButtons();
					observer.observe(document.body, { childList: true, subtree: true });
					report('ready', envInfo({ inputs: findAddressInputs().length }));
					setTimeout(probeDom, 3000);
					announceOnce();
				};
				boot();
			}
		};
	}

	// ── 模块加载 ───────────────────────────────────────────────────────
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
					on: function () {}
				});
			} catch (e) { console.warn('[' + SRC + '] fallback apply failed:', e); }
		}
		console.info('[' + SRC + '] fallback mode');
	}
})();
