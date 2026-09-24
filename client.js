/**
 * dsh-notify-relay — browser face (no build step, no dependencies).
 *
 * Served as a dynamic client bundle through window.__ModuleLoader__. Only the
 * baseline seeds (react / react-dom) are required; every icon, style and copy
 * string is inlined so the plugin stays a single lightweight file.
 *
 * What it does:
 *   1. reads the host's rule config and delivery log over same-origin routes,
 *   2. renders the official settings section — the whole rule center
 *      (events, dedup, quiet hours, digest, channels) in one editor,
 *   3. renders a sidebar footer status pill that opens a delivery panel,
 *   4. follows the active locale so a language switch repaints without a reload.
 *
 * No DOM augmentation of official rows is needed here: this plugin's surface is
 * its own settings section plus its own footer pill, both official slots.
 *
 * @module dsh-notify-relay/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify-relay',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const createElement = React.createElement

    /** Plugin identity shared with the host half. */
    const PLUGIN_ID = 'dsh-notify-relay'
    /** Host route prefix (must match index.js). */
    const ROUTE = '/notify-relay'
    /** Browser poll cadence for config + delivery log. */
    const POLL_MS = 4000
    /** How many delivery rows the panel shows. */
    const PANEL_LOG_ROWS = 6
    /** How many delivery rows the settings page shows. */
    const PAGE_LOG_ROWS = 12

    /* ---------------------------------------------------------------- *
     * Vocabulary shared with the host half.
     * ---------------------------------------------------------------- */

    /** Event kinds, in host order. */
    const EVENT_IDS = ['task.done', 'task.failed', 'request.failed', 'approval.asked']

    /** Channel kinds, in host order; `labelKey` resolves through `t`. */
    const CHANNEL_KINDS = [
      { id: 'bark', labelKey: 'chBark', fields: [{ key: 'key', labelKey: 'fBarkKey', secret: true }] },
      { id: 'serverchan', labelKey: 'chServerchan', fields: [{ key: 'sendkey', labelKey: 'fServerchanKey', secret: true }] },
      {
        id: 'telegram',
        labelKey: 'chTelegram',
        fields: [
          { key: 'token', labelKey: 'fTelegramToken', secret: true },
          { key: 'chatId', labelKey: 'fTelegramChat', secret: false },
        ],
      },
      { id: 'wecom', labelKey: 'chWecom', fields: [{ key: 'key', labelKey: 'fWecomKey', secret: true }] },
      { id: 'feishu', labelKey: 'chFeishu', fields: [{ key: 'token', labelKey: 'fFeishuToken', secret: true }] },
      { id: 'ntfy', labelKey: 'chNtfy', fields: [], urlField: { labelKey: 'fNtfyUrl', placeholder: 'https://ntfy.sh/my-topic' } },
      {
        id: 'webhook',
        labelKey: 'chWebhook',
        fields: [{ key: 'token', labelKey: 'fWebhookToken', secret: true }],
        urlField: { labelKey: 'fWebhookUrl', placeholder: 'https://example.com/hook' },
      },
    ]

    const CHANNEL_KIND_IDS = new Set(CHANNEL_KINDS.map((c) => c.id))

    /** Sentinel the host sends instead of a real secret (must match index.js). */
    const REDACTED = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

    /* ---------------------------------------------------------------- *
     * Dictionaries.
     * ---------------------------------------------------------------- */

    const ZH = {
      footerLabel: '外联',
      footerOff: '已关闭',
      footerOn: '已开启',
      footerHeld: (n) => `${n} 条待摘要`,
      footerLastOk: '上次投递成功',
      footerLastFail: '上次投递失败',
      footerMuted: '已静音',
      panelTitle: '外联中枢',
      panelHint: '完整规则在 设置 → 外联中枢 中配置',
      panelEmpty: '暂无投递记录',
      panelRelay: '外联',
      panelChannels: '通道',
      panelHeld: '待摘要',
      panelTest: '发送测试',
      panelClose: '关闭',

      settingsNav: '外联中枢',
      settingsNavHint: '把任务完成、失败与待审批事件经过去重、免打扰、摘要合批后外联到你的通道。',
      masterLabel: '启用外联',
      masterHint: '关闭后所有事件都不会外发，但配置与投递记录保留。',
      eventsTitle: '事件来源',
      evTaskDone: '任务完成',
      evTaskFailed: '任务失败',
      evRequestFailed: '请求失败',
      evApproval: '待审批',
      rulesTitle: '规则',
      dedupLabel: '去重窗口（分钟）',
      dedupHint: '同一指纹在此窗口内再次出现时只投递一次。',
      quietLabel: '免打扰时段',
      quietHint: '窗口可跨午夜（22:00 → 08:00）。选择“丢弃”或“留到摘要”。',
      quietDrop: '丢弃',
      quietDigest: '留到摘要',
      digestLabel: '摘要合批',
      digestHint: '开启后不逐条外发，而是按间隔合成一条摘要。',
      digestInterval: '间隔（分钟）',
      channelsTitle: '外联通道',
      channelsHint: '密钥仅保存在本机 DSH 数据目录，界面回显为掩码；留空表示保持原值。',
      secretPlaceholder: '留空保持原值',
      addChannel: '添加通道',
      chBark: 'Bark',
      chServerchan: 'Server酱',
      chTelegram: 'Telegram',
      chWecom: '企业微信',
      chFeishu: '飞书',
      chNtfy: 'ntfy',
      chWebhook: '通用 Webhook',
      chName: '名称',
      chKind: '类型',
      chEvents: '接收事件',
      chAll: '全部事件',
      chEnabled: '启用',
      chTest: '测试',
      chDelete: '删除',
      fBarkKey: 'Bark Key',
      fServerchanKey: 'SendKey',
      fTelegramToken: 'Bot Token',
      fTelegramChat: 'Chat ID',
      fWecomKey: 'Webhook Key',
      fFeishuToken: '机器人 Token',
      fNtfyUrl: 'ntfy 地址',
      fWebhookUrl: 'Webhook 地址',
      fWebhookToken: 'Bearer Token（可空）',
      logTitle: '最近投递',
      logEmpty: '暂无投递记录',
      flushLabel: '立即摘要',
      logOk: '成功',
      logFail: '失败',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      testSent: (n) => `已向 ${n} 个通道发送测试`,
      testFailed: '测试失败',
      needName: '请填写通道名称',
      needUrl: '请填写通道地址',
      maxChannels: '通道数量已达上限',
    }

    const EN = {
      footerLabel: 'Outbound',
      footerOff: 'off',
      footerOn: 'on',
      footerHeld: (n) => `${n} held`,
      footerLastOk: 'last delivery ok',
      footerLastFail: 'last delivery failed',
      footerMuted: 'muted',
      panelTitle: 'Outbound relay',
      panelHint: 'Full rule center lives in Settings → Outbound relay.',
      panelEmpty: 'No deliveries yet',
      panelRelay: 'Relay',
      panelChannels: 'Channels',
      panelHeld: 'Held',
      panelTest: 'Send test',
      panelClose: 'Close',

      settingsNav: 'Outbound relay',
      settingsNavHint: 'Routes task-done, failure and approval events through dedup, quiet hours and digest batching into your channels.',
      masterLabel: 'Enable outbound',
      masterHint: 'When off nothing is delivered, but the config and the delivery log are kept.',
      eventsTitle: 'Event sources',
      evTaskDone: 'Task done',
      evTaskFailed: 'Task failed',
      evRequestFailed: 'Request failed',
      evApproval: 'Approval asked',
      rulesTitle: 'Rules',
      dedupLabel: 'Dedup window (minutes)',
      dedupHint: 'The same fingerprint inside this window is delivered only once.',
      quietLabel: 'Quiet hours',
      quietHint: 'The window may wrap past midnight (22:00 → 08:00). Pick drop or hold-for-digest.',
      quietDrop: 'drop',
      quietDigest: 'hold for digest',
      digestLabel: 'Digest batching',
      digestHint: 'When on, notifications are folded into one summary per interval instead of sent one by one.',
      digestInterval: 'Interval (minutes)',
      channelsTitle: 'Channels',
      channelsHint: 'Secrets stay in the local DSH data directory and are echoed back masked; leave a field untouched to keep it.',
      secretPlaceholder: 'leave blank to keep',
      addChannel: 'Add channel',
      chBark: 'Bark',
      chServerchan: 'ServerChan',
      chTelegram: 'Telegram',
      chWecom: 'WeCom',
      chFeishu: 'Feishu',
      chNtfy: 'ntfy',
      chWebhook: 'Generic webhook',
      chName: 'Name',
      chKind: 'Type',
      chEvents: 'Events',
      chAll: 'All events',
      chEnabled: 'Enabled',
      chTest: 'Test',
      chDelete: 'Delete',
      fBarkKey: 'Bark key',
      fServerchanKey: 'SendKey',
      fTelegramToken: 'Bot token',
      fTelegramChat: 'Chat ID',
      fWecomKey: 'Webhook key',
      fFeishuToken: 'Bot token',
      fNtfyUrl: 'ntfy URL',
      fWebhookUrl: 'Webhook URL',
      fWebhookToken: 'Bearer token (optional)',
      logTitle: 'Recent deliveries',
      logEmpty: 'No deliveries yet',
      flushLabel: 'Flush digest',
      logOk: 'ok',
      logFail: 'failed',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed',
      testSent: (n) => `Test sent to ${n} channel(s)`,
      testFailed: 'Test failed',
      needName: 'A channel needs a name',
      needUrl: 'This channel needs a URL',
      maxChannels: 'Channel limit reached',
    }

    /**
     * Seeded from the document language so the bundle also works before — and
     * in compositions without — the locale face; apply() then aligns it to the
     * framework's active locale, which is the one the user actually picked
     * (document.documentElement.lang goes stale after an in-app language
     * switch, because the page never reloads).
     */
    let t = (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('zh') ? ZH : EN

    /** Locale namespace this plugin's dictionaries are published under. */
    const LOCALE_NS = 'dsh-notify-relay'

    /** Dictionary for one locale id ('zh', 'en', 'zh-CN', …; unknown reads as English). */
    function dictFor(localeId) {
      return String(localeId || '').toLowerCase().startsWith('zh') ? ZH : EN
    }

    /* ---------------------------------------------------------------- *
     * Inline CSS (design tokens only — no hard-coded colors).
     * ---------------------------------------------------------------- */

    const CSS = [
      /* Footer status pill. */
      '.dsh-relay-footer{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:32px;padding:0 8px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:13px;line-height:1;cursor:pointer}',
      '.dsh-relay-footer:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}',
      '.dsh-relay-footer:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}',
      '.dsh-relay-footer[data-rail=true]{position:relative;justify-content:center;width:32px;margin:0 auto;padding:0}',
      '.dsh-relay-footer-label{flex:1;min-width:0;overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap}',
      /* State dot: green when delivering, neutral when off. Both are static
         tokens so they stay legible in either theme. */
      '.dsh-relay-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-neutral-quaternary,#b3b7bf)}',
      '.dsh-relay-footer[data-on=true] .dsh-relay-dot{background:var(--dsw-alias-state-success-primary,#22a06b)}',
      '.dsh-relay-footer[data-last=failed] .dsh-relay-dot{background:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dsh-relay-held{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:17px;padding:0 6px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-state-warn-primary,#f59e0b);color:var(--dsw-static-neutral-1000,#000);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;line-height:17px;white-space:nowrap}',

      /* Delivery panel (portal). */
      '.dsh-relay-panel{position:fixed;z-index:1000;display:flex;flex-direction:column;gap:8px;width:280px;padding:12px;border-radius:12px;background:var(--dsw-alias-bg-primary,#fff);box-shadow:0 8px 28px 0 #0f111526,0 0 0 1px var(--dsw-alias-line-secondary,#e6e8eb);font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.dsh-relay-panel-title{font-size:13px;font-weight:600}',
      '.dsh-relay-panel-hint{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;line-height:15px}',
      '.dsh-relay-panel-rows{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
      '.dsh-relay-panel-row{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#4b4f56);font-size:11px;line-height:15px}',
      '.dsh-relay-panel-row b{font-weight:600}',
      '.dsh-relay-tag{flex:none;padding:0 5px;border-radius:4px;font-size:10px;font-weight:600;line-height:15px}',
      '.dsh-relay-tag[data-ok=true]{background:var(--dsw-alias-state-success-tertiary,#e6f4ee);color:var(--dsw-alias-state-success-primary,#22a06b)}',
      '.dsh-relay-tag[data-ok=false]{background:var(--dsw-alias-state-error-tertiary,#fdeceb);color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dsh-relay-panel-actions{display:flex;gap:6px}',
      '.dsh-relay-btn{height:26px;padding:0 10px;border:0;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-relay-btn:hover{background:var(--dsw-alias-interactive-bg-active,#2631481f)}',
      '.dsh-relay-btn:disabled{opacity:.5;cursor:default}',

      /* Settings page. */
      '.dsh-relay-page{display:flex;flex-direction:column;gap:14px;max-width:640px;padding:2px 0 8px}',
      '.dsh-relay-page-title{color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;font-weight:600}',
      '.dsh-relay-hint{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;line-height:15px}',
      '.dsh-relay-group{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-secondary,#f7f8f9)}',
      '.dsh-relay-group-title{color:var(--dsw-alias-label-secondary,#4b4f56);font-size:12px;font-weight:600}',
      '.dsh-relay-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.dsh-relay-row-between{justify-content:space-between}',
      '.dsh-relay-row input[type=number],.dsh-relay-row input[type=time],.dsh-relay-row input[type=text],.dsh-relay-row select{height:26px;padding:0 6px;border:1px solid var(--dsw-alias-line-secondary,#e6e8eb);border-radius:6px;background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px}',
      '.dsh-relay-row input[type=number]{width:72px}',
      '.dsh-relay-row input[type=time]{width:92px}',
      '.dsh-relay-field{display:flex;flex-direction:column;gap:3px}',
      '.dsh-relay-field-label{color:var(--dsw-alias-label-tertiary,#81858c);font-size:10px}',
      '.dsh-relay-check{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}',
      '.dsh-relay-channel{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-primary,#fff);box-shadow:0 0 0 1px var(--dsw-alias-line-secondary,#e6e8eb)}',
      '.dsh-relay-channel-head{display:flex;align-items:center;gap:8px}',
      '.dsh-relay-channel-name{flex:1;min-width:0}',
      '.dsh-relay-log{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
      '.dsh-relay-log-row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary,#4b4f56);font-size:11px;line-height:16px}',
      '.dsh-relay-log-time{flex:none;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums}',
      '.dsh-relay-log-chan{flex:none;font-weight:600}',
      '.dsh-relay-log-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-relay-status{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dsh-relay-status[data-kind=saved]{color:var(--dsw-alias-state-success-primary,#22a06b)}',
      '.dsh-relay-status[data-kind=error]{color:var(--dsw-alias-state-error-primary,#d54941)}',
    ]

    function injectCss() {
      if (document.getElementById(`${PLUGIN_ID}-css`)) return null
      const style = document.createElement('style')
      style.id = `${PLUGIN_ID}-css`
      style.textContent = CSS.join('\n')
      document.head.appendChild(style)
      return style
    }

    /* ---------------------------------------------------------------- *
     * Store: the config + delivery log mirror.
     * ---------------------------------------------------------------- */

    /** A fresh, empty config (mirrors the host's defaultConfig). */
    function emptyConfig() {
      return {
        enabled: false,
        events: { 'task.done': false, 'task.failed': true, 'request.failed': true, 'approval.asked': true },
        dedup: { windowMinutes: 10 },
        quiet: { enabled: false, start: '22:00', end: '08:00', mode: 'digest' },
        digest: { enabled: false, intervalMinutes: 30 },
        channels: [],
      }
    }

    const state = {
      config: emptyConfig(),
      log: [],
      loaded: false,
      /** Notifications the host is holding for the next digest flush. */
      held: 0,
      muted: false,
    }

    const listeners = new Set()

    function emitChange() {
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /** useSyncExternalStore-free subscription: works on any seeded React. */
    function useRelayState() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => subscribe(force), [])
      return state
    }

    /* ---------------------------------------------------------------- *
     * Host client.
     * ---------------------------------------------------------------- */

    async function requestJson(path, options) {
      const response = await fetch(path, options)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** Coerce one host channel into a shape this editor can render. */
    function normalizeChannel(raw) {
      if (!raw || typeof raw !== 'object') return null
      const kind = CHANNEL_KIND_IDS.has(raw.kind) ? raw.kind : 'webhook'
      const spec = CHANNEL_KINDS.find((c) => c.id === kind)
      const secrets = {}
      for (const field of spec.fields) {
        secrets[field.key] = typeof raw.secrets?.[field.key] === 'string' ? raw.secrets[field.key] : ''
      }
      const events = Array.isArray(raw.events) ? raw.events.filter((k) => EVENT_IDS.includes(k)) : ['*']
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `ch-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        name: typeof raw.name === 'string' && raw.name ? raw.name : spec.id,
        enabled: raw.enabled !== false,
        secrets,
        events: events.length > 0 ? events : ['*'],
        url: typeof raw.url === 'string' ? raw.url : '',
      }
    }

    function normalizeConfig(raw) {
      const base = emptyConfig()
      if (!raw || typeof raw !== 'object') return base
      const events = { ...base.events }
      for (const id of EVENT_IDS) {
        if (typeof raw.events?.[id] === 'boolean') events[id] = raw.events[id]
      }
      const time = (value, fallback) => (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback)
      const minutes = (value, fallback) => {
        const n = Number(value)
        return Number.isFinite(n) ? Math.min(24 * 60, Math.max(1, Math.trunc(n))) : fallback
      }
      return {
        enabled: raw.enabled === true,
        events,
        dedup: { windowMinutes: minutes(raw.dedup?.windowMinutes, base.dedup.windowMinutes) },
        quiet: {
          enabled: raw.quiet?.enabled === true,
          start: time(raw.quiet?.start, base.quiet.start),
          end: time(raw.quiet?.end, base.quiet.end),
          mode: raw.quiet?.mode === 'drop' ? 'drop' : 'digest',
        },
        digest: {
          enabled: raw.digest?.enabled === true,
          intervalMinutes: minutes(raw.digest?.intervalMinutes, base.digest.intervalMinutes),
        },
        channels: (Array.isArray(raw.channels) ? raw.channels.map(normalizeChannel).filter(Boolean) : []).slice(0, 20),
      }
    }

    function normalizeEntry(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        at: typeof raw.at === 'string' ? raw.at : '',
        channelId: typeof raw.channelId === 'string' ? raw.channelId : '',
        kind: typeof raw.kind === 'string' ? raw.kind : '',
        ok: raw.ok === true,
        status: typeof raw.status === 'number' ? raw.status : null,
        error: typeof raw.error === 'string' ? raw.error : '',
        detail: typeof raw.detail === 'string' ? raw.detail : '',
      }
    }

    async function pullConfig() {
      const data = await requestJson(`${ROUTE}/config`, { headers: { accept: 'application/json' } })
      if (!data?.ok) return
      state.config = normalizeConfig(data.config)
      state.held = Number.isFinite(data.held) ? data.held : 0
      state.muted = data.muted === true
      state.loaded = true
      emitChange()
    }

    async function pullLog() {
      const data = await requestJson(`${ROUTE}/log`, { headers: { accept: 'application/json' } })
      if (!data?.ok) return
      state.log = (Array.isArray(data.entries) ? data.entries.map(normalizeEntry).filter(Boolean) : []).slice(0, 50)
      emitChange()
    }

    async function saveConfig(config) {
      await requestJson(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ config }),
      })
      await pullConfig()
      await pullLog()
    }

    async function testChannel(channelId) {
      const data = await requestJson(`${ROUTE}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(channelId ? { channelId } : {}),
      })
      await pullLog()
      return Array.isArray(data?.results) ? data.results : []
    }

    async function flushDigest() {
      await requestJson(`${ROUTE}/flush`, { method: 'POST', headers: { accept: 'application/json' } })
      await pullLog()
    }

    /* ---------------------------------------------------------------- *
     * Small render helpers.
     * ---------------------------------------------------------------- */

    function Switch({ checked, onChange, label, testId }) {
      return createElement(
        'label',
        { className: 'dsh-relay-check' },
        createElement('input', {
          type: 'checkbox',
          checked: !!checked,
          'data-testid': testId,
          onChange: (event) => onChange(event.target.checked),
        }),
        label,
      )
    }

    function Field({ label, children }) {
      return createElement(
        'div',
        { className: 'dsh-relay-field' },
        createElement('div', { className: 'dsh-relay-field-label' }, label),
        children,
      )
    }

    function shortTime(at) {
      if (!at) return ''
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return at
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** One delivery row, shared by the panel and the settings page. */
    function LogRow({ entry }) {
      return createElement(
        'li',
        { className: 'dsh-relay-log-row' },
        createElement('span', { className: 'dsh-relay-tag', 'data-ok': entry.ok ? 'true' : 'false' }, entry.ok ? t.logOk : t.logFail),
        createElement('span', { className: 'dsh-relay-log-time' }, shortTime(entry.at)),
        createElement('span', { className: 'dsh-relay-log-chan' }, entry.channelId || entry.kind || '-'),
        createElement(
          'span',
          { className: 'dsh-relay-log-detail' },
          entry.detail || entry.error || (entry.status ? `HTTP ${entry.status}` : ''),
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * Settings section — the whole rule center in one editor.
     * ---------------------------------------------------------------- */

    /**
     * Local draft. The editor never writes through to the host on every
     * keystroke: a half-typed number would be rejected, and a rejected write
     * would silently reset the user's other fields.
     */
    function RelayEditor() {
      const snapshot = useRelayState()
      const [draft, setDraft] = React.useState(() => normalizeConfig(snapshot.config))
      const [status, setStatus] = React.useState('')
      const [statusKind, setStatusKind] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      /* Follow the host once the first pull lands (and only then), so a
         reload of the page mid-edit does not clobber the draft. */
      const seeded = React.useRef(false)
      React.useEffect(() => {
        if (seeded.current || !snapshot.loaded) return
        seeded.current = true
        setDraft(normalizeConfig(snapshot.config))
      }, [snapshot.loaded, snapshot.config])

      function patch(changes) {
        setDraft((current) => ({ ...current, ...changes }))
      }

      function patchChannel(id, changes) {
        setDraft((current) => ({
          ...current,
          channels: current.channels.map((channel) => (channel.id === id ? { ...channel, ...changes } : channel)),
        }))
      }

      function addChannel() {
        setDraft((current) => {
          if (current.channels.length >= 20) {
            setStatus(t.maxChannels)
            setStatusKind('error')
            return current
          }
          const kind = CHANNEL_KINDS[0]
          const secrets = {}
          for (const field of kind.fields) secrets[field.key] = ''
          return {
            ...current,
            channels: [
              ...current.channels,
              {
                id: `ch-${Math.random().toString(36).slice(2, 10)}`,
                kind: kind.id,
                name: kind.id,
                enabled: true,
                secrets,
                events: ['*'],
                url: '',
              },
            ],
          }
        })
      }

      async function onSave() {
        setBusy(true)
        setStatus(t.saving)
        setStatusKind('')
        try {
          await saveConfig(draft)
          setStatus(t.saved)
          setStatusKind('saved')
        } catch (error) {
          setStatus(`${t.saveFailed}：${String(error?.message || error)}`)
          setStatusKind('error')
        } finally {
          setBusy(false)
        }
      }

      async function onTest(id) {
        setBusy(true)
        try {
          const results = await testChannel(id)
          const failed = results.filter((r) => !r.ok)
          if (failed.length > 0) {
            setStatus(`${t.testFailed}：${failed.map((f) => f.error || f.status).join(', ')}`)
            setStatusKind('error')
          } else {
            setStatus(t.testSent(results.length))
            setStatusKind('saved')
          }
        } catch (error) {
          setStatus(`${t.testFailed}：${String(error?.message || error)}`)
          setStatusKind('error')
        } finally {
          setBusy(false)
        }
      }

      return createElement(
        'div',
        { className: 'dsh-relay-page' },
        /* Master switch. */
        createElement(
          'div',
          { className: 'dsh-relay-group' },
          createElement(
            'div',
            { className: 'dsh-relay-row dsh-relay-row-between' },
            createElement(Switch, {
              checked: draft.enabled,
              onChange: (value) => patch({ enabled: value }),
              label: t.masterLabel,
              testId: 'relay-master',
            }),
          ),
          createElement('div', { className: 'dsh-relay-hint' }, t.masterHint),
        ),

        /* Event sources. */
        createElement(
          'div',
          { className: 'dsh-relay-group' },
          createElement('div', { className: 'dsh-relay-group-title' }, t.eventsTitle),
          ...EVENT_IDS.map((id) =>
            createElement(Switch, {
              key: id,
              checked: draft.events[id],
              onChange: (value) => patch({ events: { ...draft.events, [id]: value } }),
              label: t[{ 'task.done': 'evTaskDone', 'task.failed': 'evTaskFailed', 'request.failed': 'evRequestFailed', 'approval.asked': 'evApproval' }[id]],
              testId: `relay-event-${id}`,
            }),
          ),
        ),

        /* Rules. */
        createElement(
          'div',
          { className: 'dsh-relay-group' },
          createElement('div', { className: 'dsh-relay-group-title' }, t.rulesTitle),
          createElement(
            'div',
            { className: 'dsh-relay-row dsh-relay-row-between' },
            createElement('span', null, t.dedupLabel),
            createElement('input', {
              type: 'number',
              min: 1,
              max: 1440,
              value: draft.dedup.windowMinutes,
              'data-testid': 'relay-dedup',
              onChange: (event) => patch({ dedup: { windowMinutes: Number(event.target.value) || 1 } }),
            }),
          ),
          createElement('div', { className: 'dsh-relay-hint' }, t.dedupHint),
          createElement(
            'div',
            { className: 'dsh-relay-row dsh-relay-row-between' },
            createElement(Switch, {
              checked: draft.quiet.enabled,
              onChange: (value) => patch({ quiet: { ...draft.quiet, enabled: value } }),
              label: t.quietLabel,
              testId: 'relay-quiet',
            }),
          ),
          createElement(
            'div',
            { className: 'dsh-relay-row' },
            createElement('input', {
              type: 'time',
              value: draft.quiet.start,
              'data-testid': 'relay-quiet-start',
              onChange: (event) => patch({ quiet: { ...draft.quiet, start: event.target.value } }),
            }),
            createElement('span', { className: 'dsh-relay-hint' }, '→'),
            createElement('input', {
              type: 'time',
              value: draft.quiet.end,
              onChange: (event) => patch({ quiet: { ...draft.quiet, end: event.target.value } }),
            }),
            createElement(
              'select',
              {
                value: draft.quiet.mode,
                onChange: (event) => patch({ quiet: { ...draft.quiet, mode: event.target.value } }),
              },
              createElement('option', { value: 'digest' }, t.quietDigest),
              createElement('option', { value: 'drop' }, t.quietDrop),
            ),
          ),
          createElement('div', { className: 'dsh-relay-hint' }, t.quietHint),
          createElement(
            'div',
            { className: 'dsh-relay-row dsh-relay-row-between' },
            createElement(Switch, {
              checked: draft.digest.enabled,
              onChange: (value) => patch({ digest: { ...draft.digest, enabled: value } }),
              label: t.digestLabel,
              testId: 'relay-digest',
            }),
            createElement('input', {
              type: 'number',
              min: 1,
              max: 1440,
              value: draft.digest.intervalMinutes,
              onChange: (event) => patch({ digest: { ...draft.digest, intervalMinutes: Number(event.target.value) || 1 } }),
            }),
          ),
          createElement('div', { className: 'dsh-relay-hint' }, t.digestHint),
        ),

        /* Channels. */
        createElement(
          'div',
          { className: 'dsh-relay-group' },
          createElement('div', { className: 'dsh-relay-group-title' }, t.channelsTitle),
          createElement('div', { className: 'dsh-relay-hint' }, t.channelsHint),
          ...draft.channels.map((channel) =>
            createElement(ChannelCard, {
              key: channel.id,
              channel,
              busy: busy,
              onChange: (changes) => patchChannel(channel.id, changes),
              onTest: () => onTest(channel.id),
              onDelete: () =>
                setDraft((current) => ({ ...current, channels: current.channels.filter((c) => c.id !== channel.id) })),
            }),
          ),
          createElement(
            'button',
            { type: 'button', className: 'dsh-relay-btn', 'data-testid': 'relay-add-channel', onClick: addChannel },
            `+ ${t.addChannel}`,
          ),
        ),

        /* Delivery log. */
        createElement(
          'div',
          { className: 'dsh-relay-group' },
          createElement(
            'div',
            { className: 'dsh-relay-row dsh-relay-row-between' },
            createElement('div', { className: 'dsh-relay-group-title' }, t.logTitle),
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-relay-btn',
                onClick: () => {
                  void flushDigest().catch(() => {})
                },
              },
              t.flushLabel,
            ),
          ),
          snapshot.log.length === 0
            ? createElement('div', { className: 'dsh-relay-hint' }, t.logEmpty)
            : createElement(
                'ul',
                { className: 'dsh-relay-log' },
                snapshot.log.slice(0, PAGE_LOG_ROWS).map((entry, index) => createElement(LogRow, { key: `${entry.at}-${index}`, entry })),
              ),
        ),

        createElement(
          'div',
          { className: 'dsh-relay-row dsh-relay-row-between' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-relay-btn',
              'data-testid': 'relay-save',
              disabled: busy,
              onClick: () => void onSave(),
            },
            t.save,
          ),
          createElement('div', { className: 'dsh-relay-status', 'data-kind': statusKind || undefined }, status),
        ),
      )
    }

    /** One channel editor card. */
    function ChannelCard({ channel, busy, onChange, onTest, onDelete }) {
      const spec = CHANNEL_KINDS.find((c) => c.id === channel.kind) ?? CHANNEL_KINDS[0]
      return createElement(
        'div',
        { className: 'dsh-relay-channel' },
        createElement(
          'div',
          { className: 'dsh-relay-channel-head' },
          createElement('input', {
            type: 'text',
            className: 'dsh-relay-channel-name',
            value: channel.name,
            placeholder: t.chName,
            'data-testid': 'relay-channel-name',
            onChange: (event) => onChange({ name: event.target.value }),
          }),
          createElement(
            'select',
            {
              value: channel.kind,
              'data-testid': 'relay-channel-kind',
              onChange: (event) => {
                const next = CHANNEL_KINDS.find((c) => c.id === event.target.value) ?? CHANNEL_KINDS[0]
                const secrets = {}
                for (const field of next.fields) secrets[field.key] = ''
                onChange({ kind: next.id, url: '', secrets })
              },
            },
            ...CHANNEL_KINDS.map((kind) => createElement('option', { key: kind.id, value: kind.id }, t[kind.labelKey])),
          ),
          createElement(Switch, {
            checked: channel.enabled,
            onChange: (value) => onChange({ enabled: value }),
            label: t.chEnabled,
            testId: 'relay-channel-enabled',
          }),
        ),

        /* Endpoint (ntfy / webhook only). */
        spec.urlField
          ? createElement(
              'div',
              { className: 'dsh-relay-row' },
              createElement('input', {
                type: 'text',
                style: { flex: '1', minWidth: '0' },
                value: channel.url,
                placeholder: spec.urlField.placeholder,
                'data-testid': 'relay-channel-url',
                onChange: (event) => onChange({ url: event.target.value.trim() }),
              }),
            )
          : null,

        /* Secret / id fields. */
        ...spec.fields.map((field) =>
          createElement(
            'div',
            { className: 'dsh-relay-row' },
            createElement('input', {
              type: field.secret ? 'password' : 'text',
              style: { flex: '1', minWidth: '0' },
              value: channel.secrets[field.key] ?? '',
              placeholder: channel.secrets[field.key] ? REDACTED : t.secretPlaceholder,
              'data-testid': `relay-secret-${field.key}`,
              onChange: (event) => onChange({ secrets: { ...channel.secrets, [field.key]: event.target.value } }),
            }),
            createElement('span', { className: 'dsh-relay-hint' }, t[field.labelKey]),
          ),
        ),

        /* Event filter. */
        createElement(
          'div',
          { className: 'dsh-relay-row' },
          createElement('span', { className: 'dsh-relay-hint' }, t.chEvents),
          createElement(
            'label',
            { className: 'dsh-relay-check' },
            createElement('input', {
              type: 'checkbox',
              checked: channel.events.includes('*'),
              onChange: (event) => onChange({ events: event.target.checked ? ['*'] : [] }),
            }),
            t.chAll,
          ),
          ...EVENT_IDS.map((id) =>
            createElement(
              'label',
              { key: id, className: 'dsh-relay-check' },
              createElement('input', {
                type: 'checkbox',
                checked: channel.events.includes('*') || channel.events.includes(id),
                disabled: channel.events.includes('*'),
                onChange: (event) => {
                  const next = new Set(channel.events.filter((k) => k !== '*'))
                  if (event.target.checked) next.add(id)
                  else next.delete(id)
                  onChange({ events: [...next] })
                },
              }),
              t[{ 'task.done': 'evTaskDone', 'task.failed': 'evTaskFailed', 'request.failed': 'evRequestFailed', 'approval.asked': 'evApproval' }[id]],
            ),
          ),
        ),

        createElement(
          'div',
          { className: 'dsh-relay-row' },
          createElement(
            'button',
            { type: 'button', className: 'dsh-relay-btn', disabled: busy, onClick: onTest },
            t.chTest,
          ),
          createElement(
            'button',
            { type: 'button', className: 'dsh-relay-btn', onClick: onDelete },
            t.chDelete,
          ),
        ),
      )
    }

    /** Official settings window: one nav entry for the whole rule center. */
    function SettingsSection() {
      return createElement(
        'div',
        { className: 'dsh-relay-page' },
        createElement('div', { className: 'dsh-relay-page-title' }, t.settingsNav),
        createElement('div', { className: 'dsh-relay-hint' }, t.settingsNavHint),
        createElement(RelayEditor, null),
      )
    }

    /* ---------------------------------------------------------------- *
     * Footer status pill + delivery panel.
     * ---------------------------------------------------------------- */

    /**
     * sidebar.footer.action — a status pill that opens the delivery panel.
     * The pill shows the relay state, how many notifications are held for the
     * next digest, and whether the last delivery failed.
     */
    function FooterAction({ wide }) {
      const snapshot = useRelayState()
      const [open, setOpen] = React.useState(false)
      const anchorRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const config = snapshot.config
      const last = snapshot.log[0]
      const held = snapshot.held

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (panelRef.current?.contains(event.target)) return
          if (anchorRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      async function onTest() {
        setBusy(true)
        setNotice('')
        try {
          const results = await testChannel('')
          const failed = results.filter((r) => !r.ok)
          setNotice(failed.length > 0 ? t.testFailed : t.testSent(results.length))
        } catch {
          setNotice(t.testFailed)
        } finally {
          setBusy(false)
        }
      }

      return createElement(
        React.Fragment,
        null,
        createElement(
          'button',
          {
            ref: anchorRef,
            type: 'button',
            className: 'dsh-relay-footer',
            'data-rail': wide ? 'false' : 'true',
            'data-on': config.enabled ? 'true' : 'false',
            'data-last': last ? (last.ok ? 'ok' : 'failed') : 'none',
            'data-testid': 'relay-footer',
            'aria-label': t.settingsNav,
            title: `${t.settingsNav}：${config.enabled ? t.footerOn : t.footerOff}`,
            onClick: () => setOpen((value) => !value),
          },
          createElement('span', { className: 'dsh-relay-dot' }),
          wide ? createElement('span', { className: 'dsh-relay-footer-label' }, t.footerLabel) : null,
          !config.enabled && wide ? createElement('span', { className: 'dsh-relay-hint' }, t.footerOff) : null,
          config.digest.enabled && held > 0 ? createElement('span', { className: 'dsh-relay-held' }, held) : null,
        ),
        open ? createElement(DeliveryPanel, { anchorRef, panelRef, snapshot, busy, notice, onTest, onClose: () => setOpen(false) }) : null,
      )
    }

    /** Portal-free fixed panel anchored under the footer pill. */
    function DeliveryPanel({ anchorRef, panelRef, snapshot, busy, notice, onTest, onClose }) {
      const [position, setPosition] = React.useState(null)
      const config = snapshot.config

      React.useEffect(() => {
        const place = () => {
          const anchor = anchorRef.current?.getBoundingClientRect()
          if (!anchor) return
          const width = 280
          const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left))
          /* Prefer above the pill: the sidebar footer sits at the bottom of the
             window, so a panel growing downward would fall off-screen. */
          const above = Math.max(8, anchor.top - 8 - 260)
          setPosition({ left, top: anchor.top > 300 ? above : anchor.bottom + 8 })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [anchorRef])

      const style = position ? { left: `${position.left}px`, top: `${position.top}px` } : { left: '-9999px', top: '-9999px' }

      return createElement(
        'div',
        { ref: panelRef, className: 'dsh-relay-panel', style, role: 'dialog', 'data-testid': 'relay-panel' },
        createElement('div', { className: 'dsh-relay-panel-title' }, t.panelTitle),
        createElement(
          'div',
          { className: 'dsh-relay-panel-row' },
          createElement('b', null, t.panelRelay),
          '：',
          config.enabled ? t.footerOn : t.footerOff,
          snapshot.muted ? `（${t.footerMuted}）` : '',
        ),
        createElement(
          'div',
          { className: 'dsh-relay-panel-row' },
          createElement('b', null, t.panelChannels),
          '：',
          `${config.channels.filter((c) => c.enabled).length}/${config.channels.length}`,
        ),
        snapshot.held > 0
          ? createElement(
              'div',
              { className: 'dsh-relay-panel-row' },
              createElement('b', null, t.panelHeld),
              '：',
              snapshot.held,
            )
          : null,
        snapshot.log.length === 0
          ? createElement('div', { className: 'dsh-relay-panel-hint' }, t.panelEmpty)
          : createElement(
              'ul',
              { className: 'dsh-relay-panel-rows' },
              snapshot.log.slice(0, PANEL_LOG_ROWS).map((entry, index) => createElement(LogRow, { key: `${entry.at}-${index}`, entry })),
            ),
        createElement('div', { className: 'dsh-relay-panel-hint' }, t.panelHint),
        notice ? createElement('div', { className: 'dsh-relay-panel-hint' }, notice) : null,
        createElement(
          'div',
          { className: 'dsh-relay-panel-actions' },
          createElement(
            'button',
            { type: 'button', className: 'dsh-relay-btn', disabled: busy, onClick: () => void onTest() },
            t.panelTest,
          ),
          createElement('button', { type: 'button', className: 'dsh-relay-btn', onClick: onClose }, t.panelClose),
        ),
      )
    }

    /* ---------------------------------------------------------------- *
     * Plugin entry.
     * ---------------------------------------------------------------- */

    /** Host context, captured for the test hook. */
    let rootCtx = null

    /**
     * Install polling, the locale alignment and the slot registrations.
     * @param ctx - client context.
     */
    function apply(ctx) {
      rootCtx = ctx
      const style = injectCss()

      /* i18n: publish both dictionaries under our namespace, then follow the
         framework's active locale so a language switch inside DSH's own
         settings repaints this plugin without a reload. The document-language
         seed above covers compositions without a locale face. */
      ctx.effect(() => {
        /* `locale` is listed in exports.inject, so cordis has already waited for
           dsh-client-locale before this fiber activates. The client runner's ctx
           is fail-loud: touching a service that is NOT in inject throws
           "cannot get property X without inject" during apply(), which also
           kills the whole tree. The guard below stays so a composition that
           somehow lacks the face degrades to the document language. */
        const locale = ctx.locale
        if (!locale || typeof locale.register !== 'function') return () => {}
        const align = () => {
          const next = dictFor(locale.getLocale ? locale.getLocale().active : '')
          if (next !== t) {
            t = next
            emitChange()
          }
        }
        try {
          const disposeZh = locale.register(LOCALE_NS, 'zh', ZH)
          const disposeEn = locale.register(LOCALE_NS, 'en', EN)
          const unsubscribe = typeof locale.subscribe === 'function' ? locale.subscribe(align) : () => {}
          align()
          return () => {
            unsubscribe()
            disposeEn()
            disposeZh()
          }
        } catch (error) {
          console.warn('[dsh-notify-relay] locale registration failed; keeping the document language:', error)
          return () => {}
        }
      }, 'notify-relay.locale()')

      ctx.effect(() => {
        const pull = () => {
          void pullConfig().catch(() => {})
          void pullLog().catch(() => {})
        }
        const timer = setInterval(pull, POLL_MS)
        pull()
        const onVisibility = () => {
          if (!document.hidden) pull()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
          if (style && style.isConnected) style.remove()
          listeners.clear()
        }
      }, 'notify-relay.runtime()')

      // Each inject waits for the slot declaration, so load order never matters.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'notify-relay-footer', order: 50 }, FooterAction),
      )

      /* DSH's own Settings window: one nav entry holding the whole rule center.
         `label` is a thunk — the registry re-evaluates it per read, so the nav
         row follows the active locale without re-registering. */
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'notify-relay', order: 50, label: () => t.settingsNav },
          SettingsSection,
        ),
      )
    }

    /**
     * Services required before this plugin loads.
     *
     * `slots` and `locale` — both are registered at root scope by bundles that
     * dsh-base itself composes (dsh-client-modules and dsh-client-locale), so
     * both are ancestors of this fiber and cordis always finds them.
     *
     * The runner's ctx is fail-loud: reading a service that is not listed here
     * throws "cannot get property X without inject" during apply(), which kills
     * the whole tree — so this list is the contract for every ctx.* read in
     * this file (effect/inject are cordis built-ins and always allowed).
     */
    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject

    /**
     * Test hook for `.sandbox/client-harness.cjs`. Only populated when the page
     * sets `window.__DSH_NOTIFY_TEST__`, which the real GUI never does, so it
     * costs nothing at runtime. It exists because the config round-trip chain
     * (pull → normalize → draft → POST → re-pull) lives entirely in closures:
     * a shape mismatch there silently drops channels instead of failing.
     */
    if (typeof window !== 'undefined' && window.__DSH_NOTIFY_TEST__) {
      exports.__test__ = {
        get t() {
          return t
        },
        get state() {
          return state
        },
        normalizeConfig,
        normalizeChannel,
        emptyConfig,
        shortTime,
        subscribe,
        pullConfig,
        pullLog,
        saveConfig,
        testChannel,
        flushDigest,
        LogRow,
        ChannelCard,
        RelayEditor,
        FooterAction,
        SettingsSection,
        ids: { events: EVENT_IDS, channels: CHANNEL_KIND_IDS, redacted: REDACTED },
      }
    }

    return module.exports
  },
})
