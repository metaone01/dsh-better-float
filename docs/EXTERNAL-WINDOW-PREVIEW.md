# 外部窗口提取（预览） / External window extraction (Preview)

**状态：预览功能，需手动配置；不承诺任意元素完整交互或跨平台兼容。** 普通应用内浮动面板不依赖此配置。Current status: preview, with manual setup and limited adapters. In-app panels do not require a companion.

## 支持范围与限制

外部窗口由本机 Electron companion 创建，Host 经带配对认证的本机管道连接。只传递受限的展示内容、控件值和已支持的操作，原控件仍在 Desktop 中。

- 原生按钮、文本 input/textarea 有受限交互适配；单个选区最多 6 个原生控件，文本草稿最多 512 字符，协议帧最多 8 KB。
- 已识别的工作区适配支持有限浏览和搜索；已识别的 DSH 编辑器支持手动纯文本草稿同步，结构化草稿只读。
- 聊天菜单、附件和发送仍在 Desktop 中操作。其他编辑器、select、Canvas/WebGL、iframe、媒体、Shadow DOM 和复杂资源没有通用完整适配保证。
- 源区域被替换或断开时连接会失效，需要重新选择并确认。部分继承样式、隐藏区域的动画、虚拟列表内容可能不完整。
- 当前主要在 Windows 上开发。macOS/Linux 的外部窗口流程未在本次交付中验证。

The companion runs locally and forwards only supported adapter actions. It is not an arbitrary DOM migration mechanism. Native controls and recognized workspace/composer adapters have limits; unsupported areas may be display-only or rejected. Cross-platform support and arbitrary page fidelity are not promised.

## 配置前准备

1. 安装插件并先确认应用内浮动面板可用。
2. 准备**可信的 Electron 可执行文件**。本包携带 companion 脚本，但不下载或捆绑 Electron 运行时。选择维护者测试环境所用的 Electron 44 系列时，也仍需验证本机兼容性。不要假定普通 Node 或任意 DSH 可执行文件可以代替 Electron。
3. 找到当前 Desktop profile、安装后的插件目录和该 profile 的 `cordis.patch.yml`。不要把开发仓库路径或别的 profile 路径直接复制过来。
4. 备份配置；以下操作仅修改 `name: "@metaone01/dsh-better-float"` 对应条目，保留其他插件、已有配置及注册项。此步骤涉及本机配置，应由使用者确认后执行。

## 手动配置示例（Windows）

这是路径模板，必须替换成本机绝对路径，**不要原样粘贴占位路径**：

```yaml
- insert:
    - id: better-float
      name: "@metaone01/dsh-better-float"
      config:
        companionPairingFile: 'C:/Users/YOUR_NAME/.dsh/companions/better-float/credentials/pairing.json'
        companionExecutable: 'C:/PATH/TO/electron.exe'
        companionEntry: 'C:/Users/YOUR_NAME/.dsh/profiles/desktop/node_modules/@metaone01/dsh-better-float/lib/companion/main.cjs'
```

如果已有此插件条目，只合并这三个配置字段，不要再添加第二个注册条目。Electron 路径和 companion 入口必须是现有普通文件的绝对路径。`pairing.json` 由 companion 在启动时创建；不要手写、公开或随包分发其中的凭证。

配置完成后，完整重启 Desktop。选取受支持区域，点击“外部窗口提取（预览）”，阅读将连接的控件并确认。Host 配置包含可执行文件和入口时，会尝试按需启动 companion；没有 companion 窗口时不应将此流程当作已验证成功。

The YAML above is a Windows template, not a ready-to-use configuration. Use the active profile's installed paths, merge only this plugin's fields, and restart Desktop. Credentials are created by the companion; never share the pairing file. Host launch paths come from local operator configuration, not from selected page content.

## 隐私与退出

- 确认前检查选区；文字、输入框值和草稿可能包含私密内容。只连接自己愿意交给本机 companion 的内容。
- 关闭源浮动面板会结束连接；源页面变化后可能需要重新连接。
- Host 按需启动的 companion 有受管退出流程；若自行手动启动过进程，应自行关闭该实例。
- 停用预览时，先关闭外部窗口并停止手动 companion，再从该插件条目删除上述三个字段，保留插件本身的注册，然后完整重启 Desktop。
- 不要把 `pairing.json`、用户数据目录或包含私人内容的调试报告上传到 Issues。

Review selected values before consenting. Close the source panel to end a connection. Remove only the preview configuration fields to disable the feature, stop manually launched instances, and restart the host. Do not upload pairing credentials or private user data.
