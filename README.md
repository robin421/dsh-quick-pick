# dsh-quick-pick

DeepSeek Harness（DSH）的**网页选区插件**：在右侧预览区里点选网页元素，把它的 **Full XPath** 直接写进当前会话输入框——不用手抄选择器，也不用截图跟模型解释"就是那个按钮"。

> 作者：**Robin** · 博客：<https://blog.wattflow.net>

## 它能做什么

- 在**文件预览 / 内置浏览器**的工具栏上提供唯一入口：`✦ 选区 (XPath)`
- 开启选区后：鼠标移动即高亮元素，**点一下**就把该元素的 `Full XPath` 写入输入框（优先走会话输入接口，失败回落 DOM）
- **点选区不会刷新页面**：能同源直接读的帧就原地监听，读不到的帧只在原位置叠一层选区副本，原预览始终不动
- **再点一次入口或按 `Esc` 退出**选区模式（会撤掉页面里的十字光标与高亮框）
- 快捷键：`Cmd/Ctrl + Shift + E`
- 找不到选区通道时，会把现场信息（帧类型、`src`、`sandbox`、是否可读）写进输入框，便于排查

## 为什么是这样实现的

DSH 右侧的预览帧是**独立沙箱文档**（`dsh-app://` 协议或独立 origin），插件脚本按浏览器安全规则**读不到它的 DOM，也无法注入函数**——这也是"纯前端选区"在这类预览上必然失效的原因。

插件按帧的实际形态分三条通道处理，全部**不新开窗口**：

| 帧形态 | 处理方式 |
| --- | --- |
| 同源可读的 `iframe` | 宿主直接挂选区监听（不动页面） |
| Electron `<webview>` | `executeJavaScript` 注入探针 |
| 沙箱 / `dsh-app://` 帧 | host 端代理取回原文（`/quick-pick/read-html` 可直接读磁盘上的预览文件）＋内联探针，叠一层**选区副本覆盖层**；探针在副本内运行，选中后 `postMessage` 回宿主。**原预览帧全程不改写，所以点选区不会刷新页面** |

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

- 读不到 DOM 的沙箱/跨源预览会改用**覆盖层副本**选区：原预览帧全程不动（不重载、不跳回页面顶部），但副本从页面顶部开始滚动，且副本不执行页面脚本（靠 JS 动态渲染的内容可能缺失）
- 选区只作用于预览帧，不读写磁盘上的源文件

## 调试

日志：`~/.dsh/logs/quick-pick.log`

会记录 `ready` / `address-inputs` / `preview-pick` / `page-frame-pick` / `sandbox-inject` / `picked` 等事件；host 端另有 `GET/POST /quick-pick/log` 接收上报。

## License

MIT © Robin — <https://blog.wattflow.net>
