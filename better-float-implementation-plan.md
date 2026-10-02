# better-float 实现计划（v2 · 依据 dsh 设计报告修正）

> 本文件已依据 **`dsh-element-scout-design.md`**（dsh 架构设计报告，含 4 轮追问修订与已核实的平台事实）对原计划做系统性修正。
> 原计划保留为 **`better-float-implementation-plan.orig.md`**，勿删，便于对照。
> 后续实现在本文件夹（`G:\Code\fork\dsh-better-float`）进行。

---

## 0. 修正摘要（先看这里）

原计划的技术底座（Portal 锚点 + postMessage 事件桥接 + `window.open`）在**通用 Web**语境下成立，但落到 **dsh / Electron** 后有若干处会导致「能跑起来但关键功能不工作」。下表按严重度排列。

| # | 原计划写法 | 问题 | 修正 | 级别 |
|---|---|---|---|---|
| **C1** | 事件：新窗口捕获 → `postMessage` → 原窗口在 Portal 锚点上重建并 `dispatch` 冒到上层 | **X 自身的 React `onClick` 永远不会触发。** React 18 委托挂在 root container，按 `event.target` 沿 fiber 树定位 handler；此时原窗口只剩一个空锚点 A，React 只能找到 A 及其祖先，**X 自己的 props 不在路径上**（props 存在 X 的 `__reactProps$*`，而 X 已在新窗口）。更糟的是：X 的真身在新窗口被 React 持续更新 → 「渲染在新窗口、事件在原窗口」两条世界线分裂 | 改为**就地反射（in-place reflection）**：在新窗口直接读取目标节点链上的 `__reactProps$*`，按 `composedPath` 走捕获+冒泡两轮直接调用，配最小合成事件 shim。**同文档浮动则完全不需要任何透传**（委托仍在同一个 root container 内） | **P0** |
| **C2** | 完全没有处理「父节点失去子节点」 | 搬迁后 React 卸载/重排/条件渲染会调 `P.removeChild(X)`，而 X 已不是 P 的子节点 → 抛 `NotFoundError`，**整棵子树崩溃** | 必须实现 `installStructuralStandIn(P, X, A)`：在 **P 的实例自有属性**上（遮蔽原型，非改原型）拦截 `removeChild` / `insertBefore` / `appendChild` / `replaceChild`，把 X 映射为 A | **P0** |
| **C3** | `window.open('', '_blank')` + `window.opener` | dsh 主窗口 `apps/desktop/src/main.ts:235-237` 的 `setWindowOpenHandler` 对**所有** URL 返回 `{action:'deny'}`（http/https 直接外部浏览器打开）→ `window.open` **拿不到 WindowProxy**。且 `window.open('')` 得到 about:blank（空来源），会直接切断同源 | 新增主进程 popout 通道创建窗口；若坚持 live 跨窗，则**仅对内部 URL 放行** `dsh-app://app/?dsh-popout=<id>`，以换取 `window.open` 的返回句柄 | **P0** |
| **C4** | 「设同一 `affinity` 即可跨窗 `adoptNode`」 | **共享 renderer 进程是必要不充分条件。** 跨窗传递 DOM 节点还必须先拿到对方的**对象引用**（WindowProxy / opener / parent）。没有引用，即便同进程也无从把节点交给对方（`postMessage` 的结构化克隆明确排除 DOM 节点） | 见 C3：`affinity` **与**「放行内部 `window.open` 拿到句柄」二者缺一不可。（此项同时修正了我方设计文档 §11 的遗漏） | **P0** |
| **C5** | 无代价地给主窗口加 `affinity` | 给主窗口设 `webPreferences.affinity` 是一次**全局行为变更**：所有 popout 与主应用共享同一 renderer 进程，**popout 崩溃会连带拖垮主应用** | v1 **默认不给主窗口加 affinity** → 跨窗默认走 **snapshot / clone 档**；live 跨窗降级为 experimental，需单独评估崩溃隔离（spike #S5） | **P1** |
| **C6** | `skeleton.id = 'parent'`（骨架复制 id） | 同文档浮动会造成**重复 id**，违反 HTML 唯一约束，影响 `getElementById` / `<label for>` / `aria-labelledby` / `:target`。跨文档（独立 window）则**无此问题** | 分类处理：跨窗 → 可安全复制 id；同文档 → **优先①原地逃逸**（保留真祖先，零骨架、零重复 id）；不得不同文档补骨架且祖先带 id 时按 D5 三选一 | **P1** |
| **C7** | 「内联计算样式」列为备选方案 | 除原计划已提到的丢失伪类/媒体查询外，更致命的是：**inline 在层叠中高于所有样式表**，会永久压死主题切换、状态类（`.is-error`）、`:hover`，并与 React 后续下发的 style prop 争抢同一批 key。**这是功能性 bug，不是视觉瑕疵** | 明确禁止作为通用手段；仅允许用于「已确认不随状态变化」的极少数属性，或作为最后的兜底 | **P1** |
| **C8** | 「构造样式表不能跨文档共享」 | 该限制不成立：同源下 constructed `CSSStyleSheet` 可赋给多个 document 的 `adoptedStyleSheets`。（待 spike 复核）dsh 实际多为 Vite 产出的 `<link>` / `<style>`，克隆即可；注意加 `<base>` 修相对路径（此点原计划正确，保留） | 修正表述；以 link/style 克隆为主路径 | **P2** |
| **C9** | 完全没有 dsh 集成上下文 | 缺 `shell.overlay` 挂载点、`ui-dockkit` FloatLayer（**已有完整浮动模型可白嫖**）、快捷键注册与保留键、构建纯度门禁、同源 popout roster、鼠标穿透死锁、「拖出窗口」的 pointermove 截断问题 | 见 §4 决策与 §5 步骤，全部落到具体包/文件 | **P1** |
| **C10** | 未使用保态搬迁原语 | 未使用 `moveBefore`（Chromium 133+ / Electron 44 可用），保不住 CSS 动画进度、`:focus`、popover 开合、`<dialog>`、iframe 不重载、自定义元素的 `connectedMoveCallback` | 同文档搬迁统一走 `moveBefore`；**跨文档会抛 `HierarchyRequestError`**，必须 `try/catch` 降级到 `adoptNode + insertBefore` 并提示 | **P1** |
| **C11** | 缺 reload / 恢复语义 | popout 重载 = 节点消失，无任何恢复策略 | 明确：快照档持久化「CSS 选择器路径 + 内容快照」→ 重载后按选择器重新定位宿主再重建；live 档不持久化，重载即降级 | **P2** |
| **C12** | 缺拾取阶段 | 计划从「已有一个待迁移节点」开始，未覆盖快捷键触发、命中测试、高亮 | 补齐 scout 引擎（`elementFromPoint` + `pointer-events:none` 浮层 + 祖先链步进） | **P1** |

**一句话：** 原计划把「渲染」搬走了却把「事件」留在原处，这在 React 委托模型下会让面板变成**只读的画**；同时它对 dsh/Electron 的三个硬约束（`window.open` 被 deny、DOM 不可跨 ECG 传递、通知 DOM 树变更的面坦可能会 NPE）毫无感知。修正是结构性的，不是补丁级的。

---

## 1. 范围与目标

插件名 **`better-float`**（对应设计阶段代号 `ui-element-scout`），宿主 **deepseek-harness（`G:\Code\fork\deepseek-harness`）**。

1. **拾取**：快捷键 → 鼠标下 DOM 元素高亮边框；`↑/↓` 在祖先链步进（DevTools 式扩大选区）。
2. **提取为浮动组件**：点击并拖动该元素 → 应用内浮动面板（拖动 / 缩放 / 置顶 / 关闭）。
3. **出独立窗口**：拖出原窗口 → 独立 OS 窗口；支持可控标题栏、鼠标穿透等窗口属性。

### 非目标（v1 明确不做）
- 多显示器/多工作区布局记忆
- 跨主机同步面板
- popout 内的完整路由导航（popout 只承载被提取的面板）

---

## 2. 已核实的平台事实（硬约束，不可绕过）

| 事实 | 依据 | 影响 |
|---|---|---|
| React **18.2**，`__reactFiber$` / `__reactProps$` 齐全 | `apps/web/package.json:56` | 就地反射可行 |
| Electron **^44** → 实测 **44.4.5 / Chromium 152 / Node 24.21** | `apps/desktop/package.json:60`；**已由 `npm run spike:versions` 实测确认** | `moveBefore` **确认可用**（Chromium 133+ 要求满足），Tier 0 可作为默认路径 |
| `moveBefore` **跨文档抛 `HierarchyRequestError`** | 规范 | 出窗必降级，iframe 重载 / 焦点丢失 / 动画重置 |
| `window.open` **全局 deny** | `apps/desktop/src/main.ts:235-237` | 拿不到 WindowProxy，除非单独放行 |
| **无** renderer→main 的开窗 IPC（26 个通道全是 shell 关注点） | `apps/desktop/src/ipc.ts` | popout 需新增 IPC 面 |
| `Event` 不可结构化克隆 | W3C Structured Clone | 事件桥只能重建（但我们改走就地反射，绕开） |
| DOM 节点不可经 `postMessage` 传递 | 同上 | 跨窗 live 必须共享 renderer 进程 + 拿到对方引用 |
| 桌面端已有窗口属性手法（`titleBarStyle`/`vibrancy`/`backgroundMaterial`/`frame:false`+`transparent`） | `main.ts:209-224`、`welcome-window.ts:29-37`、`update-overlay.ts:27` | 可控标题栏/透明/材质**不是新能力** |
| 全仓库**尚无** `setIgnoreMouseEvents` | 全量 grep | 鼠标穿透为新增，需一并在 IPC 面登记 |
| 构建纯度门禁：禁在 platform externals 之外值导入 `@deepseek-ai/*` | `packages/client/tsdown.client.ts:535-546` | 服务必须走 cordis `inject` + `ctx.*` |
| `ui-dockkit` **已有完整浮动模型**（FloatRect / `PaneHost='dock'|'float'` / float·unfloat·moveFloat·resizeFloat / FloatLayer 可 portal） | `packages/client/ui-dockkit/src/*` | 浮动层不要自己写 |
| 插槽 `shell.overlay` 覆盖全框架、在滚动容器外、层本身穿透点击 | `packages/client/ui-layout/src/client/index.ts` | 浮动层的正确挂载点 |

---

## 3. 架构

### 3.1 四引擎

```
scout    拾取：快捷键 → elementFromPoint 命中 → 高亮浮层 → 祖先链步进
capture  保真提取：Tier 0 活体 / Tier 1 语义重建 / Tier 2 克隆 / Tier 3 位图
float    应用内浮动：复用 ui-dockkit FloatLayer，portal 进 shell.overlay
detach   出独立窗口：Electron BrowserWindow（主）/ Document PiP（web 兜底）
```

### 3.2 三节点模型（Tier 0 活体搬迁）

```
X = 被提取的真身节点（在新容器里，仍是同一个 JS 对象）
A = 幽灵锚点 / 结构替身（占 X 的原位，保布局 + 接住 React 的 removeChild 等调用）
P = X 的原父节点
```

React fiber 的 `stateNode` 仍指向 X → 框架继续更新它 → **渲染自动发生在新位置**。这就是「让程序以为它还在那」的字面实现。

---

## 4. 关键决策（D1–D9）

### D1. 提取档位：Tier 0 活体为默认，克隆降级

**保留真身、不复制 DOM。** 依据：`moveBefore` / `adoptNode` 保持节点对象身份，React 继续更新同一个对象。克隆永远补不回：canvas 位图与 WebGL context、video 播放态、shadow DOM、表单值/滚动位置/选区、动画进度、`:focus` / popover 态、流式增量更新。

```
Tier 0   活体搬迁（moveBefore / adoptNode）  ← 默认
Tier 1   语义重建（data-dsh-content-kind）    ← 命中侧边已有内容时
Tier 2   克隆（cloneNode + 样式环境重建）     ← Tier 0 被禁 / 跨不同 renderer 进程
Tier 3   位图（foreignObject / capturePage）  ← 兜底
```

### D2. CSS 保真：重建「样式环境」，不复制样式

三种路径，按此优先级：

1. **① 原地逃逸（首选，CSS 工作量 0）** — 把浮动容器**挂进 X 原本的父节点 P**，再用 `position: fixed` 挪到屏幕坐标。祖先链一字未改 → 继承、选择器、`:has()`、`@container`、主题、状态类**全部原生生效**，连 `width/height` 都不用冻结。
   - 硬约束：`fixed` 会被祖先的 `transform` / `filter` / `backdrop-filter` / `perspective` / `contain:paint` / `will-change:transform` 重建包含块而逃逸失败。
   - 取舍：容器成了 P 的子节点，P 卸载时面板一起消失（MutationObserver 捕获后可重挂到上层）。
2. **② 骨架祖先链** — 反转思路：不补偿丢失的样式，而是**把丢失的祖先补回来**。在容器里按 `root → … → X 父节点` 重建空壳链（复制 tagName / class / `data-*`），骨架统一 `display: contents !important`。
   - 关键认知：**选择器匹配的是 DOM 树，不是盒树** → `display:contents` 的元素仍参与 `#app > .x`、`:nth-child`、`+`、`~`、`:has()` 匹配，继承照常传播，同时不生成盒子。
   - 必须抑制骨架的 `::before/::after`（否则会当子节点渲染出来）。
   - 真实祖先挂 MutationObserver（`attributeFilter: ['class','style','data-theme','data-state']`）同步 `className` → 状态类切换能传导。
3. **③ 差量内联补偿 — 仅兜底**（见 C7 为何禁用）。

**①②统一代码路径**：① 是 ② 的「骨架数为 0」退化形式。做法是**尽可能深地插入**容器：从 P 往上跳过会建立 fixed 包含块的祖先，在第一个安全祖先下插入，缺失的那段才补骨架。

> **口径纠正（对比 dsh 设计报告 §12）**：报告称「真正不可免除的只剩 width/height」。实际上连这两项也可免除 —— 选 `fluid` 语义即可：**末层骨架不设 `display:contents`，保留真实 `display` 并撑满面板** → X 重新成为同类型 flex/grid 项，按新尺寸自然重排。真正的决策不是「怎么复制样式」，而是**「要不要保留原布局上下文」**：保留 → `fluid`；不保留 → `frozen`（冻结 rect，视觉 1:1）。

### D3. 事件：分两态，差别巨大

- **同文档浮动 → 什么都不用做。** React 18 委托挂在 root container，浮动层在 container 内，事件照常冒泡，**交互 100% 活着**。这是搬迁相对克隆最大的红利。
- **跨文档出窗 → 就地反射（原计划的 postMessage 桥接已废弃，见 C1）。**
  - 读目标节点链上的 `__reactProps$*` → 按 `composedPath` 走捕获+冒泡两轮 → 配最小合成事件 shim。
  - `onChange` 特殊：React 的 ChangeEventPlugin 依赖 value tracker，改监听原生 `input` / `change` 再反射。
  - **IME 不要走反射**，让原生输入法直接作用于 popout 里的真 input。
  - 默认行为（链接跳转、表单提交、原生输入）在新窗口**天然发生**，不需要桥接 —— 这是原计划「新窗口 `preventDefault` 再通知原窗口」所多绕的一步，可以删掉。

### D4. 结构替身（必须有，否则 P0 崩溃）

```ts
installStructuralStandIn(parent: Node, x: Node, a: Node): () => void
```
在 **P 实例的自有属性**上（遮蔽原型）拦截 `removeChild` / `insertBefore` / `appendChild` / `replaceChild`，把 X 映射为 A。配 MutationObserver：A 消失 → 收摊面板。返回 restore 函数 —— **X 回归原位时必须卸载拦截**。

> 常见坑：忘记 detach → `P._moveGuard` 永久驻留，且 React 后续合法操作被永久劫持。

### D5. 骨架是否复制 id（原计划直接 `skeleton.id='parent'`）

- **跨文档（独立窗口）**：新 document 里没有别的同名 id → **可安全复制**，而且为了 `#app > .x` 能匹配，这是**必需的**。
- **同文档浮动**：复制会造成重复 id。**优先走 D2-① 原地逃逸**（真祖先，零重复）。若确实必须补骨架且祖先带 `#id`，三选一：
  - (a) 复制 id 并确保骨架在**树序上晚于**真身（浮动层是 overlay，天然靠后）→ `getElementById` / `querySelector` 仍返回真身；残留风险是 aria-labelledby / `<label for>` 等语义关联，需 spike 实测；
  - (b) 不复制 id → 接受 `#id` 锚定的规则失效，该子树局部回退到 computed 补偿；
  - (c) 拒绝提取，提示用户换选更外层元素。
  - **建议 v1 取 (a) + 兜底 (c)**，并登记 spike。

### D6. 出窗：Electron `BrowserWindow` 为主后端

需求（多窗口 + 可控标题栏 + 鼠标穿透）直接否掉 Document PiP：PiP 每 document 仅一个窗口、标题栏不可控、无法 `setIgnoreMouseEvents`、位置由浏览器决定。PiP 降级为 `dsh web` 纯浏览器兜底；`window.open` 兜底（桌面端当前被 deny）。

**同源方案（关键）**：统一 **`dsh-app://app/?dsh-popout=<id>`**，**不要**开 `dsh-app://popout/`。自定义协议的 origin = `scheme://host`，换 host 即换源，会瞬时切断 `BroadcastChannel` / `localStorage` / 跨窗 DnD / `adoptNode`。顺带 `assertDesktopSender` 的 host 白名单也不用扩展。

**多窗口协调**：注册表放**主进程**（权威），主窗口与各 popout 通过 IPC + `BroadcastChannel` 同步。轻量启动：新增 `packages/bundle/popout-app` 的 cordis patch（参照既有 `web-app/cordis.patch.yml`），只装配 modules / connection / theme / locale / shortcuts / renderer / better-float；配**预热隐藏窗口**消除首屏延迟。

**跨窗 bool DOM**：
- 首选（且唯一零拷贝路径）：给主窗口与所有 popout 设同一 `webPreferences.affinity` 共享 renderer 进程 **且** 放行内部 URL 的 `window.open` 以取得 WindowProxy → 直接 `otherWin.document.adoptNode(X)`。
- **v1 默认不做**（见 D7），跨窗走 Tier 2 克隆；克隆搬运用 `DOMParser.parseFromString` + `importNode`，**绝不用 `innerHTML`**（会执行 `<img onerror>`）。

### D7. v1 默认不给主窗口加 affinity（与 dsh 设计报告的分歧)

设计报告 §10 建议「给主窗口与所有 popout 设同一 affinity」。本计划**建议 v1 不这样做**，理由：

- 给主窗口加 `affinity` 是**全局行为变更**：所有 popout 与主应用共享一个 renderer 进程，**popout 崩溃会连带拖垮主应用**。对一个「提取任意 UI 片段」的功能来说，崩溃面不可控。
- 而跨窗 live 的质量本来就要打折（`moveBefore` 跨文档抛异常 → iframe 重载 / 焦点丢失 / 动画重置 / popover 关闭），**相对高质量克隆的边际收益没有想象中大**。
- 因此：live 档用于**同文档浮动**（零代价、完整保真）；跨窗 v1 走 **克隆档**；live 跨窗作为 experimental flag，待 spike #S5（崩溃隔离）通过后再开启。

### D8. 鼠标穿透：必须一并解决死锁

开了穿透用户就点不到开关。三重保险：
1. `setIgnoreMouseEvents(true, { forward: true })` → 保留 mousemove，鼠标移到顶边才浮出控制条；
2. **主进程注册 `globalShortcut`** —— 这是整个方案里**唯一真正需要 OS 全局热键**的地方；
3. 失焦自动退出穿透。

### D9. 快捷键 `primary + shift + KeyS`

`primary + KeyC/V/X/Z/Y/Q/H/A` 即使加 shift 仍判 reserved（`packages/client/shortcuts/src/configuration.ts:106`）。web 端另需过 `isWebBindingAllowed` 白名单（`binding.ts:96-112`），spike 实测，不过则退 `primary+alt+KeyS`。

---

## 5. 实现步骤

### 阶段 0 — Spike（阻塞项，先做）

| ID | 验证内容 | 不通过则 |
|---|---|---|
| **S0** | Electron 里按住鼠标**拖出窗口**，`pointermove` 是否继续触发、`clientX/Y` 是否越界（决定能否精确落窗） | 改距边 ≤24px 的边缘投放区 + HTML5 原生 DnD 补「跨窗 dragover/drop」 |
| **S1** | 仅对内部 URL 放行 `setWindowOpenHandler` 后能否拿到可用 WindowProxy，以及 `overrideBrowserWindowOptions` 能否设 `affinity` | 跨窗克隆彻底走 IPC + `DOMParser`，不做 live |
| ~~S2~~ | ~~`moveBefore` 在 Electron 44 的保态效果~~ | **前提已由 §13 实测确认（Chromium 152 支持）**；单项保态仍可用 `npm run spike` 的 S2 面板复核 |
| **S3** | 结构替身扛 React 高频卸载/重排/条件渲染 | 简化替身语义，只覆盖 removeChild |
| **S4** | 骨架链选择器复现率（`#app > .x` / `:nth-child` / `:has()`）+ `fluid` 重排正确性 | 复现率低则回退 D2-① |
| **S5** | 主窗口加 `affinity` 后的**崩溃隔离**评估（`render-process-gone` 能否安全重启） | 永久关闭 live 跨窗，走 D7 默认路径 |
| **S6** | 跨 Shadow DOM 边界的降级路径 | 遇边界降级 Tier 1 / Tier 3 并提示 |
| **S7** | scoped style（CSS Modules / Vue scoped）在骨架链下命中率；`data-v-*` / `.cls_hash` 随壳迁移是否成立 | 见 D5(b) 局部回退 |

### 阶段 1 — 最小可玩闭环（同文档）

1. 脚手架 + `shell.overlay` 挂载 + 快捷键注册。
2. scout：浮层 `pointer-events:none` + `elementFromPoint` 命中 + `box-shadow:0 0 0 9999px` 压暗其余 + 祖先链步进。**不要改目标元素的 `outline`**（会污染即将被搬迁/克隆的快照）。
3. Tier 0 搬迁：`moveBefore` + 幽灵锚点 A + D4 结构替身。
4. CSS：优先 D2-① 原地逃逸，失败回退 ② 骨架链。
5. 浮动容器挂 `ui-dockkit` 的 FloatLayer（拖动/缩放/置顶/z 序/关闭全部白嫖）。
6. 事件：**什么都不做**（D3），验证交互确实活着。

### 阶段 2 — 出独立窗口

1. 新增主进程 popout IPC（`popout:open` / `popout:close` / `popout:update`）+ 主进程注册表。
2. popout roster（`packages/bundle/popout-app` cordis patch）+ 预热隐藏窗口。
3. 同源加载 `dsh-app://app/?dsh-popout=<id>` + 样式表克隆（+ `<base>` 修相对路径）。
4. 跨窗搬运：默认 Tier 2 克隆；S1/S5 通过后可开 live experimental。
5. 窗口属性面板：标题栏样式 / 置顶 / **鼠标穿透** + D8 三保险。
6. 跨窗拖回停靠（dock-back）的对称路径。

### 阶段 3 — 打磨

- 档位选择 UI（让用户手动改 Tier）
- 重载后恢复面板（C11 的持久化路径）
- 特殊场景的用户可见提示（Shadow DOM / 虚拟列表 / iframe / `position:fixed` 依赖祖先 transform / IntersectionObserver 懒加载）

---

## 6. 目录结构建议

本文件夹作为插件源码仓库，最终以 npm 包形式装入 dsh monorepo（`packages/` 下），保持边界清晰：

```
G:\Code\fork\dsh-better-float\
├── package.json                 # 必须声明 dsh.client.platform: 'web'
├── README.md
├── src\
│   ├── client\
│   │   └── index.ts             # 客户端半部入口 → 编译成 lib/client.js
│   │                            # 加载闭包 window.__ModuleLoader__.load({id, factory})
│   ├── scout\
│   │   ├── index.ts             # 快捷键 → 拾取模式
│   │   ├── hit.ts               # elementFromPoint 命中 + 祖先链步进
│   │   └── overlay.tsx          # 高亮浮层（pointer-events:none）
│   ├── capture\
│   │   ├── tier0-live.ts        # moveBefore / adoptNode + 幽灵锚点
│   │   ├── stand-in.ts          # ★ D4 结构替身
│   │   ├── css-inplace.ts       # ★ D2-① 原地逃逸
│   │   ├── css-skeleton.ts      # ★ D2-② 骨架祖先链
│   │   ├── events-reflect.ts    # ★ D3 跨文档就地反射
│   │   ├── tier2-clone.ts       # 克隆 + DOMParser 搬运
│   │   └── tier3-bitmap.ts      # foreignObject / capturePage
│   ├── float\
│   │   └── surface.tsx          # 复用 ui-dockkit FloatLayer → portal 进 shell.overlay
│   ├── detach\
│   │   ├── dropzone.ts          # 边缘投放区 / HTML5 DnD
│   │   └── transport.ts         # BroadcastChannel / IPC / 同 affinity 直连
│   └── shared\
│       ├── events.ts            # 事件序列化的最小契约
│       └── protocol.ts          # popout 握手与注册表消息
├── desktop\                     # 主进程侧补丁（最终合入 apps/desktop/src）
│   ├── popout-manager.ts        # 注册表 + BrowserWindow 生命周期
│   └── popout-ipc.ts            # popout:open / close / update + setIgnoreMouseEvents
└── tests\
```

> **构建红线**：插件内禁止直接 `import '@deepseek-ai/*'`（platform externals 除外）。可共享 react / cordis / ui-slots / ui-primitives / ui-dockkit / store；其余一律走 cordis `inject` + `ctx.*`。违反会在 `tsdown.client.ts:535-546` 的纯度门禁被拦。

---

## 7. 不该搬的场景（命中则降级）

提取前做静态检查，命中即降级到 Tier 1 / Tier 3 并提示用户：

- **虚拟列表的行** —— 破坏测量与回收语义
- **含 `<iframe>` 且目标为出窗** —— 必然重载
- 强依赖 `@container` / `:has()` / 兄弟选择器且祖先被跳过
- **IntersectionObserver 驱动的懒加载内容** —— 出窗后 root 变了
- **跨 Shadow DOM 边界** —— 骨架链无法跨越（C6/S6）
- **正在播放的音视频、进行中的过渡动画** —— 目标为出窗时 `moveBefore` 会退化为 `adoptNode`，播放态与动画进度会重置，属已知质量落差，需向用户明示

---

## 8. 原计划保留 / 废弃清单

**保留**
- `display: contents` 骨架的选择器思路（上升为 D2-② 并系统化）
- 样式表迁移 + 骨架组合（补充：跨文档才需要迁移样式表）
- `<base>` 修相对路径
- 高频事件 `requestAnimationFrame` 合并（仅在启用 D3 反射且遇到 `mousemove`/`scroll` 时使用）
- 边界表格里关于「默认行为不可桥接/需在本地处理」的意识（结论反转为：本地处理是**天然发生**的，不需要桥）

**废弃**
- `postMessage` 事件桥接 + 原窗口重建 `Event` + `dispatch`（C1）
- `Object.defineProperty(evt,'target',...)` 的 target 伪装 hack（C1 的副产物）
- `window.open('', '_blank')` / `window.opener` 作为主路径（C3）
- 「内联计算样式」作为常规备选（C7）
- 「构造样式表不能跨文档共享」的表述（C8）

---

## 10. 事件与样式影响矩阵（三种场景）

### 10.0 决定事件命运的关键：React 走 fiber 树，浏览器走 DOM 树

React 17+ 把所有事件委托挂在 **root container**；收到原生事件后，用 `getClosestInstanceFromNode(target)` 找到 fiber，再沿 **`instance.return`（fiber 链）**向上收集 handler —— **走的是 fiber 树，不是 DOM 树**。

因此我们搬迁 X 时**根本没有动过 fiber 链**，结论是反直觉的：

- **React handler（X 自身的 + 所有 fiber 祖先的）在①②两种同文档场景下全部照常触发**，哪怕 ② 已经让 X 在 DOM 上不再是 P 的后代。
- **真正会断的是「跟随 DOM」的那些东西**：祖先元素上的原生 `addEventListener`、`container.contains(target)` 形式的外部点击判定、祖先的 `:hover` 联动。

这修正了设计报告 §11.5 里"因为委托在 root container 内所以照常冒泡"的说法 —— 因果对了一半：**委托在 container 内是必要条件，但真正让 handler 全部存活的是 fiber 链未动**。

推论：**① 原地逃逸严格优于 ② 骨架**，因为 ① 连 DOM 链都保住了（X 仍是 P 的后代），两条路径都完好；② 只保住 fiber 路径。

### 10.1 事件影响

| 维度 | A · 同文档 ① 原地逃逸 | A′ · 同文档 ② 骨架 | B · 跨窗克隆（v1 默认） | C · 跨窗活体（experimental） |
|---|---|---|---|---|
| X 自身 React handler | ✅ 原样 | ✅ 原样 | ❌ 克隆体无 fiber → 需反射回原节点 | ✅ 就地反射（`__reactProps$*`） |
| 祖先 React handler | ✅ fiber 链未动 | ✅ fiber 链未动 | 同左（反射到原 X） | ✅ 反射 |
| 祖先**原生** `addEventListener` | ✅ DOM 后代关系仍在 | ❌ X 已不是 P 的 DOM 后代 | ❌ | ❌ |
| `contains()` / 外部点击判定 | ✅ | ⚠️ 语义改变 | ❌ | ❌ |
| 焦点 / `:focus` | ✅ `moveBefore` 保留 | ✅ 保留 | ❌ 克隆不可聚焦 | ⚠️ `adoptNode` 丢焦点 |
| 输入 / IME | ✅ 原生 | ✅ 原生 | ❌ 需回传，IME 不可用 | ✅ 让原生 IME 直接作用于真 input |
| hover / 拖拽 / 滚动 | ✅ | ✅ | ❌ 静态 | ✅ |
| `stopPropagation` | ✅ 按 fiber 链 | ✅ 按 fiber 链 | 需手工复现 | 反射时手工复现 |
| 交互延迟 | 0 | 0 | **每次交互一趟跨窗往返** | 0 |

### 10.2 样式影响

| 维度 | A · ① 原地逃逸 | A′ · ② 骨架 | B · 跨窗克隆 | C · 跨窗活体 |
|---|---|---|---|---|
| 继承（font/color/`--*`） | ✅ 真祖先原生传播 | ✅ 骨架原生传播 | 需先迁样式表 | 需先迁样式表 |
| 后代选择器 `#app .x` | ✅ | ✅ | ✅（跨窗 id 可安全复制） | ✅ |
| 子/兄弟选择器 `#app > .x` `+` `~` `:has()` | ✅ | ✅ DOM 树匹配成立 | ✅ | ✅ |
| `:nth-child` / `:first-child` | ✅ | ⚠️ **需补占位兄弟**（`display:none` 也计入序号） | ⚠️ 同 | ⚠️ 同 |
| 主题切换 / 状态类 | ✅ 原生 | ⚠️ 靠 MutationObserver 同步 `className` | ⚠️ **需跨窗镜像 className，有延迟** | ⚠️ 同 |
| `:hover` / 伪类 | ✅（副作用：hover 面板会连带点亮祖先 `:hover`） | ⚠️ 祖先联动丢失 | ⚠️ 克隆体自身可 hover，祖先联动丢失 | ⚠️ 同 |
| `@container` | ✅ 原生（真祖先有 `container-type`） | 需把 `container-type` 复制到骨架 | ⚠️ 按 popout 尺寸重算 | ⚠️ 同 |
| 媒体查询 / `vw` `vh` | 同主窗口 | 同主窗口 | ⚠️ **按 popout 视口重算 → 布局可能变化** | ⚠️ 同 |
| `width`/`height` | ✅ 无需冻结 | `fluid` 语义下无需冻结 | `frozen` 冻结 rect | `fluid` / `frozen` 二选一 |
| 伪元素 `::before/::after` | ✅ | ⚠️ 骨架上的必须抑制 | ✅（克隆自带） | ✅ |
| Shadow DOM | ❌ 骨架无法跨边界 → 降级 | ❌ 同 | ❌ 同 | ❌ 同 |
| scoped style（CSS Modules / Vue scoped） | ✅ 真祖先 | ✅ class / `data-v-*` 随壳迁移 | ✅ | ✅ |

### 10.3 活体度影响（真身 vs 克隆）

| 状态 | A / A′ 真身 | B 克隆 | C 活体跨窗 |
|---|---|---|---|
| canvas 位图 / WebGL context | ✅ | ❌ **空白** | ⚠️ 待 spike |
| video 播放态 | ✅ | ❌ 重置 | ⚠️ 可能继续 |
| `<iframe>` | ✅ 不重载 | ❌ 空白或重载 | ❌ **必重载** |
| 表单值 / 滚动位置 / 选区 | ✅ | ❌ 需手工复制 | ⚠️ 可能丢失 |
| CSS 动画进度 / 过渡 | ✅ `moveBefore` 保留 | ❌ 重置 | ❌ 重置 |
| popover / `<dialog>` 开合 | ✅ 保留 | ❌ 关闭 | ❌ 关闭 |
| 流式增量更新 | ✅ 持续 | ❌ 冻结在克隆那一刻 | ✅ 持续（React 更新真身） |

### 10.4 由此暴露的一个 v1 取舍问题

**D7（v1 跨窗走克隆档）的代价是：跨窗面板默认不可交互，且 canvas/video/iframe/滚动/表单全部降级。** 若这不可接受，三条出路：

1. **跨窗优先 Tier 1 语义重建**（推荐）—— popout 加载的是同一份 app bundle（同源 roster），可以直接**重新渲染同一个 React 组件**绑定同一数据源。交互 100%、无往返延迟、主题/状态自管理（**连 className 跨窗镜像都省了**）。代价是渲染的是"同类新实例"而非"那个确切的节点"。
2. **启用 C 活体跨窗** —— 需 `affinity` + WindowProxy（C3/C4），并接受 S5 的崩溃隔离风险与 10.3 的重置项。
3. 接受 B 的"远程视图"模型 —— 交互一回合一往返，视觉延迟明显，hover/拖拽/IME 基本不可用。

**建议把跨窗档位优先级从「B 克隆」调整为「Tier 1 语义重建 > B 克隆 > C 活体」**，并把 Tier 1 的覆盖率（`data-dsh-content-kind` 标注或试探性识别的命中率）列为新的 spike。

### 10.5 一张表总结

| | 保真度 | 交互性 | 崩溃隔离 | 实现成本 |
|---|---|---|---|---|
| A 同文档 ① 原地逃逸 | 最高 | 100% | 同一进程（无额外风险） | 低 |
| A′ 同文档 ② 骨架 | 高（nth-child / 祖先原生监听有缺口） | ~95% | 同一进程 | 中 |
| B 跨窗克隆 | 低（canvas/video/iframe 降级） | 低（远程视图） | ✅ 独立进程 | 中 |
| C 跨窗活体 | 中（iframe/动画/焦点重置） | 高（就地反射） | ❌ 共享进程 | 高 |
| Tier 1 跨窗语义重建 | 取决于识别 | 100% | ✅ 独立进程 | 中（依赖标注覆盖） |

## 11. 追加：能否「以不可见方式重建整棵 React 父控件树」替代骨架？

> **Q**：与其用 `display:contents` 的 DOM 空壳拼骨架，不如**把整条祖先链上的 React 组件真的重新渲染一遍（不可见）**，把目标挂在叶子位置。这样能否完全正确渲染？负载如何？

### 11.1 结论：CSS 层面几乎完全正确，但「完全正确」整体不成立

**CSS 层面，这确实比骨架强**，而且是严格更强：

| 项 | 骨架（DOM 空壳） | 重渲染真组件树 |
|---|---|---|
| 真实 `id` / `data-*` / `data-v-*` scoped 属性 | 需手工复制，同文档还会重复 id | ✅ 组件自己渲染，天然真实 |
| 真实的 `container-type` / `@container` | ❌ 见 11.3 | ✅ 原生（若保留盒子） |
| Shadow DOM（web component 祖先） | ❌ 空壳无法承载 shadow root | ✅ 组件会真的 attach |
| `:nth-child` / 兄弟选择器 | 需补占位兄弟 | ✅ 兄弟真的渲染出来了 |
| 组件自身下发的 inline style、`className` 状态类 | 需 MutationObserver 同步 | ✅ 原生 |
| React context / store | 不适用（真身搬迁时 fiber 未动，context 本就正常） | ✅ 若挂在同一 provider 树内 |

**但整体「完全正确」不成立**，三个硬伤：

**硬伤 1 — 它是新实例，不是原来那个节点。**
重渲染得到的是全新 DOM 节点。所有**实例局部状态**归零：非受控 input 的值、滚动位置、`:focus`、进行中的动画、canvas 位图、`<iframe>`、video 播放态。这直接把方案从 Tier 0（保真）降级为 Tier 1（重建）。

**硬伤 2 — 副作用会重跑一遍，而且是真的重跑。**
祖先组件重新挂载 ⇒ 它们的 `useEffect` 全部执行：数据请求、订阅、定时器、`ResizeObserver`、`IntersectionObserver`、埋点、甚至 `document.title` 与全局键盘监听。在聊天类应用里这意味着**重复拉取会话、重复建立订阅**，且与真实树互相打架。这是骨架方案完全没有的成本。

**硬伤 3 — 若再把「真身 X」搬进这棵新树，React 会和你打架。**
新渲染的祖先 fiber 认为自己的子节点是它自己渲染出来的那个节点；你把真身 X 物理插进去后，下一次 React 重渲染该祖先时会按自己的 fiber 做 reconcile，**可能插入自己的子节点或删掉 X**。
若真要把 X 渲染到别处同时保留 fiber 父级，正解是 **`createPortal`**（DOM 位置变了、fiber 父级不变）—— 但 portal 渲染出来的仍是新节点，且 portal 容器的 DOM 祖先就是容器本身，**CSS 上下文依然要靠骨架补**。所以 portal 与骨架是互补关系，不是替代关系。

### 11.2 负载：O(整棵子树)，不是 O(深度)

关键约束：**React 无法只渲染通往目标的「一支」。** 你让 `<ChatView>` 渲染，它就会把它所有的子项都渲染出来 —— 兄弟子树必须一并渲染，再想办法隐藏。于是：

| 方案 | 节点量级 | 挂载成本 | 稳态成本 |
|---|---|---|---|
| 骨架链 | O(深度) ≈ 3–10 个空壳 | 微秒级 | 仅 MutationObserver 同步 `className` |
| 重渲染真组件树 | O(整棵子树) ≈ **数千–数万** | 全量组件 mount + hook + effect，**数十至数百 ms** | 每次 store 更新都要重渲这棵隐形树 + 样式重算 |

- **挂载成本**：对一个真实聊天界面，重建根 → 会话 → 消息列表这条路径意味着**整份消息列表都要 mount**，几十到几百毫秒，直接破坏「抓取即浮动」该有的即时感。
- **稳态成本**：祖先组件订阅 store ⇒ 每次全局状态变更都触发隐形树重渲染；即便 `display:none`/`contents`，**样式重算仍会遍历这些节点**。
- **内存**：重复的实例、重复的订阅、重复的 DOM。

**唯一的降本手段是「脊柱渲染」** —— 让祖先组件只渲染通往目标的那一个子分支。但 React 没有原生的子分支裁剪能力，**必须组件配合**（例如提供一个 `spineOnly` context 让列表组件只渲染指定 id）。这要么侵入业务组件，要么走「渲染完再把兄弟删掉 + MutationObserver 反复删」的脆弱路子（且 React 下次渲染会把它们加回来）。

### 11.3 隐藏技术本身的坑：`display:contents` 会废掉 `container-type`

已查证：`container-type` 作用在**不生成布局盒**的元素上会被**静默忽略** —— 包括 `display: contents`、`display: none`、以及未设尺寸的 `position:absolute`。

因此：
- 骨架方案里，若某祖先原本是 `@container` 容器，**`display:contents` 的骨架无法充当查询容器** → `@container` 规则全部失效。修复只能给该层骨架**生成真实盒子并写死原容器的测量尺寸**（牺牲「不干扰布局」这一条）。
- 这也反向说明：重渲染真组件树在 `@container` 上确实更真，但前提是**别给祖先设 `display:contents`** —— 于是又回到「生成盒子 = 干扰布局」的矛盾。

隐藏手法建议（若仍要走这条路）：
- 祖先：`display: contents !important`（或为了 `@container` 保留盒子并写死尺寸）
- 兄弟：`display: none`（不生成盒子，但**仍计入 `:nth-child` 序号**，正好顺带解决骨架方案的序号问题）
- 整体：`inert` + `aria-hidden="true"` —— 避免污染 tab 顺序与读屏
- X 自身：`visibility: visible`，恢复原本 `display`

### 11.4 结论与建议

| 场景 | 是否该用「重建整棵父树」 |
|---|---|
| 同文档浮动（Tier 0 真身搬迁） | **不该。** 真身搬迁 + ①原地逃逸已经保住一切，且 fiber 未动 ⇒ context/事件/状态全对，成本 O(1) |
| 跨窗（Tier 1 语义重建） | **不该重建整棵树。** 只重建**目标组件**，祖先的 CSS 上下文交给骨架 —— 即 `createPortal` + 骨架链。避免重复副作用与 O(子树) 成本 |
| 极端情况：目标强依赖 `@container` / Shadow DOM 祖先，且骨架无法覆盖 | **可以局部使用**，但仅限「显式 opt-in 的少数已知组件」，并必须处理副作用重跑 |
| 想要「脊柱渲染」降本 | 需要业务组件配合，属长期改造，不进 v1 |

**一句话**：重建整棵父树是「CSS 正确性的上限」，但代价是**放弃真身 + 副作用重跑 + O(子树) 负载**。它解决的是「骨架补不出来的那几种 CSS 上下文」（`@container`、Shadow DOM、真实 id），而这三者的正确解法其实是**针对性修补骨架**，而不是把整棵树重跑一遍。

## 12. 一句话给实现者

先把 **S0（拖出窗口的 pointermove 是否越界）** 打掉 —— 它决定「精确落窗」是否可能。在此之前不要动 stage 2 的任何代码；stage 1（同文档浮动）与它无关，可以立刻并行开工，且它是整个功能保真度最高的部分。

> **S1（能否拿到 WindowProxy）已改判**：`window.open` 被全局 deny 不是终局 —— 只要为内部 URL 单独放行即可。但 v1 按 D7 默认不给主窗口加 `affinity`，因此跨窗仍走克隆档。

---

## 13. 实测结果（2026-09-29，`npm run spike:versions`）

平台事实不再依赖推断，已实测确认：

| 能力 | 实测值 | 对设计的影响 |
|---|---|---|
| Electron / Chromium | **44.4.5 / 152** | 比 §2 假设的 142 更新；`moveBefore` 可用 |
| `moveBefore` | **可用** | **Tier 0 活体搬迁确立为默认路径**，iframe / 焦点 / 动画 / popover 态可保 |
| `adoptNode` | 可用 | 跨文档搬运营运成立 |
| `BroadcastChannel` | 可用 | 跨窗状态同步成立 |
| `container-type` | 支持 | 骨架的 `@container` 缺口仍存在（§11.3），但可用真实盒子修补 |
| `:has()` | 支持 | 骨架方案的选择器复现可按 §10.2 预期 |
| 可构造样式表 + `adoptedStyleSheets` | 支持 | C8 的修正成立：同源可共享 |
| `popover` | 支持 | S2 的 popover 保态可测 |
| `documentPictureInPicture` | **可用** | 原有结论不变：因多窗口/标题栏/穿透需求，仍只作 web 兜底 |
| CSS Custom Highlight API | **不可用** | 无影响 —— 高亮走 ring + `box-shadow` 截断，未依赖该 API |

### 实测结果（spike，无头可自动跑的部分）

| Spike | 结果 | 结论 |
|---|---|---|
| **S2** `moveBefore` 保态 | ✅ **4/4** | 焦点、文本选区、进行中的 CSS transition、**iframe 未重载**全部保住 → **Tier 0 活体搬迁确立为默认路径**，这是整个设计最强的前提 |
| **S3** 结构替身 | ✅ **7/7** | `removeChild`/`appendChild`/`insertBefore`/`replaceChild` 四个方法 + restore 后的两个原生操作全部干净，无 `NotFoundError` → D4 的拦截方案成立 |
| **S4** 骨架选择器复现 | ✅ **5/5** | 子选择器 `>`、后代、`:nth-child(2)`、相邻兄弟 `+`、`:has()` **全部在 `display:contents` 骨架树上复现了真实树的结果** → 骨架方案的核心假设成立 |
| **S6** Shadow 边界 | info | 轻 DOM 骨架确实无法触达 shadow root 内（`boundaryBlocksSkeleton: true`）→ 命中即降级 Tier 1/3，属平台限制而非实现缺陷 |
| **S7** scoped 属性 | ✅ confirmed | 有控制组佐证：带 `data-v-*` 才匹配，不带则不匹配 → **骨架必须复制 class 与 `data-*`**（`buildSkeleton` 已如此实现） |
| **S0** 拖出窗口 pointermove | ⏳ 待人工 | 需真实鼠标拖出窗口，无法自动化；bench 窗口内已内置采集面板 |

### §11.3 的 container 缺口 —— 实测修正（比原表述更精确）

用**行为测试**（在壳内放 `@container` 规则，看它是否匹配）而非读取属性值，得到：

| 测量项 | 真实祖先 | `display:contents` 骨架 |
|---|---|---|
| `getComputedStyle(...).containerType` | `inline-size` | **`inline-size`（值仍在！）** |
| `@container` 规则是否匹配 | ✅ 匹配 | ❌ **不匹配** |
| `display` | `block` | `contents` |

**关键更正**：`container-type` 在 `display:contents` 元素上**并非"计算值被忽略"** —— Chromium 保留了声明值，
但**不建立查询容器，查询不会对它解析**。所以判断"这个祖先能否充当查询容器"**不能读属性值**，
必须做行为测试。原 §11.3 的表述（"被静默忽略"）会误导实现者写出基于属性值的错误判定。
修复手段不变：给该层生成真实盒子并写死原容器测量尺寸。

### spike 探针自身踩过的三个坑（供后续维护 bench 参考）

1. **`getComputedStyle().getPropertyValue()` 只接受 kebab-case**。传 `borderTopWidth` 返回空串，
   与"规则没生效"无法区分 —— 曾导致 4/5 探针误报失败，而真实树其实也没匹配上。现已统一转换。
2. **插入 `<style>` 后同任务内测量不可靠**，会读到样式表生效前的层叠（空值）。
   现改为先读一次布局属性强制重算，再等两帧。
3. **骨架探针必须构造真实的骨架结构**（每层都是 `display:contents` + 复制类名），
   否则测的是实现从不产生的形态。第一版把骨架挂到了选择器够不到的 id 下，导致全量误报。

### 结论汇总

`npm run spike:versions` + `npm run spike` 已实测确认：
**Tier 0 活体搬迁是可行且应作为默认路径；骨架方案的选择器复现成立；结构替身方案成立。**
唯一确认的 CSS 缺口是 `@container` 容器，且已有明确修复路径。
剩下的阻塞项只有 **S0**（需人工拖拽）与 **S1/S5**（需桌面壳）。

### 环境陷阱（已内置处理，勿再踩）

- 本机环境变量设有 **`ELECTRON_RUN_AS_NODE=1`**。Electron 检出后**退化为纯 Node 进程**，
  `require('electron')` 返回空对象，`electron --version` 输出的是 Node 版本（v24.21.0）而非 Electron 版本。
  症状是一个正确的脚本报 `Cannot read properties of undefined (reading 'whenReady')`。
  → 已由 `scripts/run-electron.mjs` 在子进程中剥离该变量并显式提示。
- 受限环境下 **GPU 进程会立即退出**，导致 `loadURL('data:...')` 报 `ERR_FAILED`，
  看起来像脚本 bug。→ 启动器已加 `--disable-gpu` 等软件渲染开关，并把探针页面改为本地文件。
- Electron 的 ESM 互操作不可靠：**`import { app } from 'electron'` 与默认导入都失败**，
  主进程脚本必须用 **CommonJS**（与 `apps/desktop` 的写法一致）。
- **`dist/version` 与二进制可能不一致**：`electron.exe --version` 曾在 binary 确为 44.4.5 时报 v24.21.0。
  判断真实版本应读二进制内的 `Electron/x.y.z` 与 `Chrome/x.y.z` 字符串，或直接问引擎（`spike:versions` 即如此）。
