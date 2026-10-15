export const LOCALE_NAMESPACE = 'betterFloat'

export const en = {
  pickCommand: 'Pull an element out as a floating panel',
  overviewCommand: 'Show floating windows',
  pickClick: 'Extract element',
  pickPull: 'Pull out panel',
  pickAdjust: 'Adjust selection level',
  pickCancel: 'Cancel',
  inputClick: 'Left click',
  inputDrag: 'Drag',
  inputWheel: 'Mouse wheel',
  pickDrag: 'Release to pull the element out',
  pickDetach: 'Release to open an external window (Preview)',
  detach: 'Open external window (Preview)',
  detachUnavailable: 'This host cannot open a separate window. The live panel stays here.',
  detachNotReady: 'The window backend is present, but popout rendering is not ready. The live panel stays here.',
  detachChecking: 'Checking the window backend. The live panel stays here.',
  detachBackendError: 'The window backend is unavailable or did not respond. The live panel stays here.',
  companionUnsupported: 'This selection has no supported visible content. Originals remain here; choose a smaller region.',
  companionUnsupportedEditor: 'This editable region needs a dedicated adapter. Native text inputs and textareas are supported; recognized DSH composer drafts have limited support. Other contenteditable/select controls are not forwarded.',
  companionEditorUnavailable: 'The DSH composer was recognized, but its resident editor interface is unavailable. No editor DOM or draft was modified.',
  companionControlLimit: 'This selection has more than six native controls. Choose a smaller region; the original remains here.',
  companionContentLimit: 'Text, graphics or traversal exceeds the adapter limit. Text drafts are limited to 512 characters; the original remains here.',
  companionSourceChanged: 'The selected source changed, was replaced or is no longer connected. Select it again; no replacement control is targeted.',
  companionSensitive: 'The selection contains a sensitive or unsupported input type. Its value will not be exported.',
  companionUnrepresented: 'The selection includes unsupported graphics, resources, generated content or unnamed controls. Choose a smaller region; originals remain here.',
  companionNotConfigured: 'Companion pairing is not configured in the plugin Host. The live panel stays here.',
  companionUnavailable: 'Companion is unavailable or pairing failed. Start the paired companion and retry; the live panel stays here.',
  companionConfirmTitle: 'External window (Preview): connect these controls?',
  companionConfirmBody: 'Send bounded presentation and values for {count} controls to the paired local companion. Native buttons/text inputs/textareas forward actions. The recognized workspace adapter supports browsing and search. The recognized DSH composer supports manual plain-text draft synchronization; structured drafts are read-only. Composer menus, attachments and sending remain in Desktop. Other regions are display-only.',
  companionConfirmPrivacy: 'Review your selection before connecting. Values may contain private information. The original controls stay here. Closing this panel ends the connection.',
  companionAllow: 'Connect controls',
  companionCancel: 'Keep in Desktop',
  companionCancelled: 'Connection cancelled. The live panel stays here.',
  companionConnecting: 'Connecting approved controls to companion. The live panel stays here.',
  companionReview: 'Review the connection request below. Control values are not sent until you approve.',
  companionConnected: 'Presentation connected. Only supported native controls or explicitly recognized adapter actions are forwarded; other areas are display-only. Originals remain here; closing this panel ends the connection.',
  companionClosed: 'The companion window was closed. Controls remain here; click detach to connect again.',
  companionDisconnected: 'Connection lost or source controls changed. Originals remain here. Reconnect explicitly to start a new session.',
  companionTooLarge: 'Selected controls exceed the 8 KB transfer limit. Originals remain here. Reduce the selection and reconnect.',
  close: 'Close',
  overviewTitle: 'Floating windows',
  overviewEmpty: 'No floating windows',
  recall: 'Recall {title}',
  place: 'Place {title}',
  previewUnavailable: 'Preview unavailable',
  canvasWarning: 'Canvas/WebGL cannot be reproduced reliably in a separate window.',
  iframeWarning: 'Contains an iframe, which reloads in a separate window.',
  mediaWarning: 'Media playback is retained only for a state-preserving live move; a separate window may reset it.',
  shadowWarning: 'Shadow DOM styles and events may not survive extraction.',
  skeletonWarning: 'The ancestor chain was rebuilt; styles and delegated events may differ.',
  liveMoveWarning: 'This move cannot preserve all runtime state; focus, animation or iframe state may reset.',
  virtualWarning: 'A virtualized row may be recycled or repositioned by the host.',
  restoreError: 'Could not restore the page: {error}',
  extractError: 'Could not extract that element: {error}',
} as const

export type MessageKey = keyof typeof en
type Dictionary = Readonly<Record<MessageKey, string>>
type Parameters = Readonly<Record<string, string | number>>

export const zh: Dictionary = {
  pickCommand: '将元素提取为悬浮面板',
  overviewCommand: '显示悬浮窗口总览',
  pickClick: '提取元素',
  pickPull: '拖出面板',
  pickAdjust: '调整选择层级',
  pickCancel: '取消',
  inputClick: '鼠标左键',
  inputDrag: '拖动',
  inputWheel: '鼠标滚轮',
  pickDrag: '松开以提取元素',
  pickDetach: '松开以提取到外部窗口（预览）',
  detach: '外部窗口提取（预览）',
  detachUnavailable: '当前宿主无法打开独立窗口，真实控件仍保留在此面板中。',
  detachNotReady: '已检测到窗口后端，但弹窗渲染尚未就绪，真实控件仍保留在此面板中。',
  detachChecking: '正在检查窗口后端，真实控件仍保留在此面板中。',
  detachBackendError: '窗口后端不可用或未及时响应，真实控件仍保留在此面板中。',
  companionUnsupported: '选区没有可提取的受支持可见内容。原内容仍保留在这里，请缩小选择范围。',
  companionUnsupportedEditor: '此编辑区域需要专用适配。支持原生文本 input、textarea，以及已识别的 DSH 聊天草稿有限适配；其他 contenteditable/select 不回传操作。',
  companionEditorUnavailable: '已识别 DSH 聊天区域，但无法取得现有编辑器接口。没有修改编辑器 DOM 或原草稿。',
  companionControlLimit: '选区包含超过 6 个原生控件，请缩小选择范围。原内容仍保留在这里。',
  companionContentLimit: '文字、图形或遍历范围超过适配上限；文本草稿最多支持 512 字符。原内容仍保留在这里。',
  companionSourceChanged: '选中的源控件已变化、被替换或断开连接。请重新选择，不会把操作发送给替代控件。',
  companionSensitive: '选区包含敏感或不支持类型的输入框，不会导出其值。',
  companionUnrepresented: '选区含不支持的图形、资源、伪元素内容或无名称控件，请缩小选择范围。原内容仍保留在这里。',
  companionNotConfigured: '插件 Host 尚未配置 companion 配对，真实控件仍保留在此面板中。',
  companionUnavailable: 'Companion 不可用或配对认证失败，请启动已配对的 companion 后重试；真实控件仍保留在此面板中。',
  companionConfirmTitle: '外部窗口提取（预览）：允许连接这些控件吗？',
  companionConfirmBody: '将有限展示内容及 {count} 个控件的值发送到已配对的本机 companion。原生按钮、文本 input/textarea 回传操作；已识别的工作区适配支持浏览和搜索。已识别的 DSH 聊天编辑器仅手动同步纯文本草稿，结构化草稿只读；聊天菜单、附件和发送仍在 Desktop。其他区域仅展示。',
  companionConfirmPrivacy: '连接前请检查选择范围，输入值可能含私密信息。原控件会留在这里，关闭此面板将结束连接。',
  companionAllow: '连接控件',
  companionCancel: '保留在 Desktop',
  companionCancelled: '已取消连接，真实控件仍保留在此面板中。',
  companionConnecting: '正在连接已确认的控件，真实控件仍保留在此面板中。',
  companionReview: '请检查下方连接请求，确认之前不会发送控件值。',
  companionConnected: '展示已连接到 companion；仅已支持的原生控件或明确识别的专用适配操作回传，其他区域仅展示。原内容仍在这里，关闭此面板将结束连接。',
  companionClosed: 'Companion 窗口已关闭，控件仍在这里；可再次点击脱离按钮连接。',
  companionDisconnected: '连接中断或原控件结构变化。原控件仍在这里，需要重新确认后建立新会话。',
  companionTooLarge: '所选控件超过 8 KB 传输上限。原控件仍保留在这里，请缩小选择范围后重新连接。',
  close: '关闭',
  overviewTitle: '悬浮窗口',
  overviewEmpty: '暂无悬浮窗口',
  recall: '召回 {title}',
  place: '放置 {title}',
  previewUnavailable: '预览不可用',
  canvasWarning: 'Canvas/WebGL 无法在独立窗口中可靠复现。',
  iframeWarning: '包含 iframe，在独立窗口中会重新加载。',
  mediaWarning: '媒体状态仅在保留状态的真实节点移动中保留，独立窗口可能使其重置。',
  shadowWarning: 'Shadow DOM 的样式与事件可能无法随提取保留。',
  skeletonWarning: '已重建祖先链，样式与委托事件可能与原位置不同。',
  liveMoveWarning: '此次移动无法完整保留运行态，焦点、动画或 iframe 状态可能重置。',
  virtualWarning: '虚拟列表行可能被宿主回收或重新定位。',
  restoreError: '无法还原页面：{error}',
  extractError: '无法提取该元素：{error}',
}

export interface Messages {
  readonly t: (key: MessageKey, params?: Parameters) => string
  readonly subscribe: (listener: () => void) => () => void
}

export interface LocaleService {
  register(namespace: string, dictionaries: Readonly<Record<string, Dictionary>>): () => void
  bind(namespace: string): Messages['t']
  subscribe(listener: () => void): () => void
}

export function messagesFor(locale: LocaleService): Messages {
  return { t: locale.bind(LOCALE_NAMESPACE), subscribe: (listener) => locale.subscribe(listener) }
}

export const englishMessages: Messages = {
  t: (key, params) => en[key].replace(/\{([^}]+)\}/gu, (placeholder, name: string) => String(params?.[name] ?? placeholder)),
  subscribe: () => () => {},
}
