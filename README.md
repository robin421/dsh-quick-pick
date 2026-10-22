# dsh-quick-pick

DeepSeek Harness（DSH）的**网页选区插件**：在右侧预览区里点选网页元素，把它的 **Full XPath** 直接写进当前会话输入框——不用手抄选择器，也不用截图跟模型解释"就是那个按钮"。

> 作者：**Robin** · 博客：<https://blog.wattflow.net>

## 它能做什么

- 在**文件预览 / 内置浏览器**的工具栏上提供唯一入口：`✦ 选区 (XPath)`
- 开启选区后：鼠标移动即高亮元素，**点一下**就把该元素的 `Full XPath` 写入输入框（优先走会话输入接口，失败回落 DOM）
- **点选区不会刷新页面**：`/sidebar/html` 预览文档里由 host 端预先注入常驻探针，点选区只是叫醒探针——原页面不重载、不跳回顶部、不产生副本
- **再点一次入口或按 `Esc` 退出**选区模式（会撤掉页面里的十字光标与高亮框）
- 快捷键：`Cmd/Ctrl + Shift + E`
- 找不到选区通道时，会把现场信息（帧类型、`src`、`sandbox`、是否可读）写进输入框，便于排查

## 为什么是这样实现的

DSH 右侧的预览帧是**独立沙箱文档**（`dsh-app://` 协议或独立 origin），插件脚本按浏览器安全规则**读不到它的 DOM，也无法注入函数**——这也是"纯前端选区"在这类预览上必然失效的原因。

插件按帧的实际形态分三条通道处理，全部**不新开窗口**：

| 帧形态 | 处理方式 |
| --- | --- |
| `/sidebar/html` HTML 预览（首选） | host 端在 HTML 响应里注入**常驻探针**（静默，只等消息）；点选区只 `postMessage` 激活它，选中后回传 XPath。**原页面不刷新、不产生副本、滚动位置不动** |
| 同源可读的 `iframe` | 宿主直接挂选区监听（不动页面） |
| Electron `<webview>` | `executeJavaScript` 注入探针；webview 内没有可用的 `parent`，结果写进页面变量 `__dqpWvResult`，由宿主用 `executeJavaScript` 轮询取回（旧版用 `postMessage` 回传，消息永远到不了宿主，表现为"点了没反应、不回写 XPath"） |
| 本地老预览文档 / 其它沙箱帧 | 退回**选区副本覆盖层**：host 端代理取回原文＋内联探针，叠在原帧位置。原帧仍不改写，不会刷新 |
| 跨源普通网页（http/https 外站，如飞书） | **不再叠副本**（副本是重新加载、从顶部开始的复印件，界面会显得很怪）：提示改用内置浏览器打开该网址，再点 ✦ 选区 |

## 用法

- 入口固定在会话页右上角图标行（✦）；工具栏不可用时会自动挂到预览工具栏，实在没有就固定在右下角；
- 点 ✦（或 `Cmd/Ctrl+Shift+E`）进入选区模式，页面上点哪个元素就取哪个元素的 Full XPath；
- **Shift + 点击**取的是它所点击元素的**父级**（点到了内部小图标/文字时用这个升一层）；
- `Esc` 退出选区模式。

## 安装

1. 把本目录放到 `~/.dsh/plugins/dsh-quick-pick`
2. 在 profile（例如 `~/.dsh/profiles/desktop`）的 `package.json` 里：

   ```json
   {
     "dependencies": {
       "dsh-quick-pick": "link:/Users/<you>/.dsh/plugins/dsh-quick-pick"
     },
     "dsh": {
       "profile": {
         "bundles": ["...", "dsh-quick-pick"]
       }
     }
   }
   ```

3. 重启 DSH

## 已知限制

- 探针注入发生在**预览文档加载时**：装好插件后**重新打开一次预览**（或重启 DSH 后再打开），该预览才是"零刷新原地选区"；之前已经打开的旧预览没有探针，会退回下面的覆盖层
- 页面自己设了严格 CSP（`script-src` 不允许内联）时探针跑不起来，同样退回覆盖层
- 覆盖层只用于本地预览文档：原帧全程不动（不重载、不跳回页面顶部），副本从页面顶部开始滚动，且不执行页面脚本
- 跨源网页（飞书等）请用内置浏览器打开后选区：那里走 webview 探针，原地选区、不产生副本
- `blob:` 预览（Web 端 HTML 文件预览）由宿主直接 fetch 原文，同样走覆盖层，不刷新原帧
- 选区只作用于预览帧，不读写磁盘上的源文件

## 调试

日志：`~/.dsh/logs/quick-pick.log`

会记录 `ready` / `address-inputs` / `preview-pick` / `page-frame-pick` / `probe-pick` / `probe-miss` / `overlay-open` / `picked` 等事件；host 端另有 `GET/POST /quick-pick/log` 接收上报。

## License

MIT © Robin — <https://blog.wattflow.net>
