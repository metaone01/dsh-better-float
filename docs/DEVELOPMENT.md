# 开发与打包 / Development and packaging

普通用户从 npm 或预构建 `.tgz` 安装即可，见 [README](../README.md)。下列步骤面向维护者。

## 目录

```text
src/                 Host、浏览器插件、选择器、浮动面板、适配器和共享协议
companion/           可选外部窗口预览的 Electron 源码和静态资源
scripts/             构建、检查、本地诊断及 npm 打包工具
docs/                用户指南、截图和开发记录
  history/           历史交接与设计文档，非当前安装步骤
lib/                 生成的发布运行文件，Git 忽略
artifacts/           生成的 npm 安装包和验证结果，Git 忽略
LICENSE              MIT 许可
```

## 环境与检查

Node.js 至少 20；开发依赖可能有更高要求，当前 Electron 开发工具链要求 Node.js 22.12+。安装开发依赖前请检查 Electron 的平台及 Node 要求。

```bash
npm ci
npm run check
npm run check:i18n:browser
```

`npm run build` 生成 Host、浏览器插件及 companion 的全部运行文件。`npm run check` 包括类型、构建、bundle/inject、静态、配置编辑、双语、传输和 companion 边界检查。默认配置编辑检查读取仓库内的 YAML 样本，并且只修改临时副本，不依赖或改写个人 Desktop profile。可向 `node scripts/check-patch-edit.mjs <path>` 传入其他只读样本。Electron 浏览器检查需要本机可用的 Electron 二进制文件。依赖实际 DSH 的专项检查还需要准备隔离宿主及本机安装路径，默认检查通过不等于真实账号或所有宿主版本已验证。

The current development tools need Node.js 22.12+ for their Electron dependencies, while the plugin manifest declares Node.js 20+ for its Node code. Host services and a compatible Desktop are still required. Browser tests exercise Electron fixtures; they do not certify all host versions or platforms.

## 生成供用户安装和发布的 npm 包

```bash
npm run pack:npm
npm run check:package
```

`pack:npm` 先构建，再在临时目录组装白名单文件，将安装无关的脚本和开发依赖从发布 manifest 中移除，最后生成 `artifacts/metaone01-dsh-better-float-<version>.tgz`。输出包包含：

- `lib/index.js`、`lib/client.js` 和预览 companion 的运行文件；
- `cordis.patch.yml`、npm manifest、MIT 许可证；
- 中英文 README、更新记录、用户指南及 README 引用的截图。

开发源码、调试报告、配对凭证、用户数据、Electron 二进制文件和 React 不进入发布包。不要用 Git 源码安装代替发布包验收，也不要使用全局放开构建权限来掩盖遗漏的产物。

`check:package` 解包后验证文件清单、入口、许可、文档链接和无安装脚本要求，加载 Host/browser 入口，并用 pnpm v11 在临时 profile 中安装且保持构建脚本默认禁用。该检查不会修改真实 Desktop profile。测试期间 React 由宿主提供，因此标为可选 peer，避免安装器额外下载副本。

直接执行 `npm pack` 也会通过 `prepack` 构建，但发布交付优先使用 `pack:npm` 的精简安装包。

## 发布

由维护者自行确认 npm 名称、账号和版本权限，再发布已验证的包：

```bash
npm publish ./artifacts/metaone01-dsh-better-float-0.1.1.tgz --access public --registry=https://registry.npmjs.org/
```

此命令会公开发布；打包工具本身不登录 npm、不上传、不创建 tag，也不推送 Git。版本名称可用性及发布权限需在发布时确认，不能仅从本地产物推断。

## 许可与依赖边界

项目源码使用根目录的 MIT 许可。浏览器构建将 React 和 DSH 服务保留为宿主模块，Host 使用 Node 内置模块；companion 将 `electron` 保留为外部运行时模块。构建工具属于开发依赖，不作为完整运行时进入发布包。源码许可搜索未发现额外内嵌版权声明，但这不是对未知来源代码的权属证明；未来引入第三方代码或资源时，应保留对应许可并重新审查。

历史交接和机器相关记录见 `docs/history/`，其状态、路径及断言可能过时。
