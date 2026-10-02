# Desktop 脱离窗口宿主能力评估

日期：2026-10-01  
范围：`dsh-better-float` 插件与当前已安装的 DSH Desktop 之间的窗口、通信和渲染边界。

## 结论摘要

当前宿主明确开放的是 Web Renderer 插件系统，而不是 Electron 窗口管理接口。
插件可以使用 React、Cordis、slot、shortcut、dockkit 和 DOM，但没有已确认的
`BrowserWindow`、preload、IPC 或窗口生命周期服务。

因此，在不修改 Desktop 主进程的前提下，最高可行路线是：

```text
window.open（若宿主允许）
  -> 同源弹窗
  -> BroadcastChannel 握手
  -> 主窗口保留真实控件
  -> 弹窗显示 clone/镜像
  -> 事件和状态双向同步
```

这可以实现系统级子窗口和一部分可交互控件，但不能保证任意 DSH 控件的 React
状态、iframe、媒体、动画、焦点和复杂拖拽全部保持。

## 已确认的宿主边界

### 插件加载边界

- `dsh.client.platform` 为 `web`。
- 客户端通过 `window.__ModuleLoader__.load({ id, factory })` 加载。
- 插件可直接使用的 platform seed 是 React、Cordis、client store、UI slots、UI
  primitives 和 dockkit 等浏览器侧模块。
- 当前插件实际声明的宿主服务是 `slots` 和 `shortcuts`。
- 插件不能直接导入 Electron；`desktop/` 中的代码是宿主主进程补丁，不属于插件包。

证据：`src/client/index.ts`、`package.json`、`docs/host-client-module-system.txt`。

### 当前脱离实现

- `src/client/index.ts` 的 `onDetachRequest` 目前只打印警告。
- `src/detach/transport.ts` 只在检测到 `globalThis.dshDesktop.invoke` 时启用窗口后端。
- `desktop/popout-manager.ts` 已实现 `BrowserWindow` 注册、bounds、always-on-top、
  click-through、关闭回收和 IPC channel，但没有接入当前 Desktop 主进程。
- 弹窗 Renderer 接收 `open` 消息后如何重建内容，目前也没有实现。

证据：`src/client/index.ts`、`src/detach/transport.ts`、`desktop/INTEGRATION.md`。

### 拖拽边界

Renderer 通常不能可靠接收鼠标离开窗口后的连续 `pointermove`。当前代码采用边缘
区域提前武装，释放仍发生在窗口内，再估算系统坐标。这是插件-only 方案可接受的
拖拽模型；精确全局拖拽需要宿主或操作系统级鼠标捕获。

证据：`src/detach/dropzone.ts`。

### P0 前的运行态证据

在 P0 启动前 Desktop 未运行，`127.0.0.1:9222` 没有监听，旧的
`docs/live-renderer-state.txt` 只是历史调试快照。因此，宿主是否允许
`window.open`、是否配置了 `setWindowOpenHandler`、以及弹窗是否保持同源，不能从
静态资料推断，必须看下面的运行态结果。

## P0 实测结果（2026-10-01）

探测方式：使用 `scripts/launch-dsh-debug-local.mjs`，以独立的
`.dsh-debug-userdata` 启动 Desktop，并通过 `scripts/p0-probe.mjs` 连接
`127.0.0.1:9222`。没有使用正常用户 profile。

| 探测项 | 结果 | 结论 |
|---|---|---|
| `window.open()` 直接调用 | 返回 `null` | 当前宿主拒绝 Renderer 创建新窗口 |
| 真实 CDP 输入事件触发 `window.open()` | 返回 `null` | 不是缺少用户手势，宿主侧仍拒绝 |
| 当前页面 origin | `dsh-app://app` | 主页面使用自定义同源 scheme |
| `BroadcastChannel` 同页双实例回环 | 成功 | API 可用，但没有跨窗口目标可验证 |
| `globalThis.dshPlatform` | 存在 `open/setBounds/close` | 是受限的平台内嵌视图接口，不是通用窗口 API |
| `globalThis.dshDesktop.browser` | 存在 `acquire/release/onOpenRequested` | 是 lease-scoped 浏览器视图接口，不是通用 OS 窗口 API |
| `globalThis.dshDesktop.invoke` | 不存在 | 当前插件不能通过通用 IPC bridge 调用主进程 |

对已安装 `resources/app.asar` 的只读源码检查进一步确认：

- preload 将 `dshPlatform.open(page, bounds)` 转发到 `PLATFORM_IPC.open`；
- 主进程只接受 `page === "usage"` 或 `page === "top-up"`；
- 这些页面由 `WebContentsView` 挂到当前窗口的 `contentView`，随后用
  `view.setBounds()` 控制区域；
- `dshDesktop.browser.acquire(workspace)` 也走现有的嵌入式浏览器视图生命周期。

所以，P0 的关键结论是：**当前 Desktop 不允许插件通过 `window.open` 创建新的
系统窗口，已有公开 bridge 也只提供当前窗口内的嵌入视图。插件-only 的原生窗口
路线在当前宿主上被阻断。**

P0 尚未测试跨窗口的 origin、`window.opener`、BroadcastChannel 握手和关闭回收，
因为宿主没有创建出子窗口；这些项目在当前条件下没有继续测试的目标。

## 能力分级与最好情况

### 只使用插件 Renderer 能力

前提是 `window.open()` 被宿主允许：

- 系统级子窗口：可行，但窗口属性受限；
- BroadcastChannel 状态同步：可行，前提是同源且自建版本/确认协议；
- 普通 DOM 和简单表单：可以做到较好的 clone + 事件代理；
- 复杂 React 控件：只能按控件建立适配器，不能通用保证；
- always-on-top、click-through、无边框、原生 bounds 管理：不能可靠控制；
- iframe、Canvas、WebGL、视频、焦点、动画和 Shadow DOM：需要明确降级。

如果 `window.open()` 被拦截，则插件-only 方案无法创建真正的系统窗口，只能保留
应用内伪窗口。

### 运行时 hook、patch、织入

可以改进插件-only 方案，但不能突破宿主权限边界：

- hook `window.open`，统一创建同源弹窗；
- 用 `MutationObserver`、`ResizeObserver` 和事件代理同步镜像；
- 读取版本化的 React props 私有字段，反射常见事件；
- 注入普通样式表、CSS 变量和主题属性；
- 为聊天消息、任务卡片、工具卡片等高频控件建立语义适配器。

这些手段不能稳定取得任意 React Fiber 内部 state，也不能在宿主禁止
`window.open` 时创建 `BrowserWindow`。

### 修改宿主主进程

这是完整窗口生命周期的可靠路径：主进程创建 `BrowserWindow`，preload 暴露受限
IPC，Renderer 通过 IPC 请求窗口并用 BroadcastChannel 或 IPC 同步内容。即使完成
这条路径，任意 DOM 仍然只能保证 clone/镜像；接近完整功能仍需要组件级语义适配器。

## 推荐实施计划

### P0：宿主能力探测（已完成）

只做运行态验证，不改宿主代码。实际探测脚本为 `scripts/p0-probe.mjs`，结果见上节。

1. 以独立 user-data 目录启动 Desktop，并开启仅监听 loopback 的调试端口。
2. 在真实用户手势中调用 `window.open()`。
3. 检查是否出现新的系统窗口。
4. 检查弹窗 URL、origin、`window.opener` 和跨窗口 DOM 访问。
5. 建立 BroadcastChannel，验证 hello/ack 和关闭通知。
6. 记录弹窗是否被宿主拦截、重定向或关闭。

P0 的关键结论只有两个：

- `window.open` 可用：继续插件-only 镜像方案；
- `window.open` 不可用：已确认当前宿主阻断插件-only 系统窗口路线，必须获得宿主
  主进程能力或另一个已经存在的外部窗口后端。

### P1：插件-only MVP

- `window.open` 创建同源弹窗；
- source/popup 身份和 `hello/snapshot/patch/command/ack` 消息协议；
- clone + stylesheet mirror；
- button/input/select/scroll 的事件代理；
- 关闭回收、断线重同步和明确的降级提示。

### P2：运行时织入增强

- 稳定节点路径和控件身份；
- React props 事件反射；
- 输入值、滚动位置、主题变量和尺寸同步；
- 为高频 DSH 组件建立 semantic adapter。

### P3：宿主集成候选

如果 P0 失败，或 P1/P2 无法满足交互要求，再接入现有
`desktop/popout-manager.ts`：主进程窗口管理、preload bridge、弹窗 Renderer
引导和真实窗口验收。

## 验收标准

- P0：弹窗能打开、保持同源、完成 BroadcastChannel 握手并检测关闭。
- P1：简单按钮和输入框可以操作，状态能回到主窗口，样式和主题基本一致。
- P2：支持控件在弹窗中可持续交互，主窗口和弹窗重载后可重新同步。
- 所有不支持的 iframe、媒体、Canvas、WebGL、Shadow DOM 和复杂 React 状态都必须
  显式降级，不能宣称为完整迁移。

## 当前判断的可信度

静态宿主边界：高可信。  
`window.open` 是否被当前 Desktop 允许：已实测为拒绝。  
插件-only 能否实现完整任意控件迁移：低可信且不应承诺。  
主进程 `BrowserWindow` + preload IPC 的可行性：高可信，但当前安装包尚未接入
better-float 的专用 channel。
