/**
 * dsh-notify-relay — client-half harness.
 *
 * Materializes client.js and runs apply() against a fake cordis ctx, so
 * activation-time errors surface WITHOUT a browser. DSH's module loader only
 * materializes a client bundle when a browser imports it, so a headless boot
 * proves nothing about the client half: a missing `inject` service, a TDZ
 * ReferenceError or a throw inside apply() all show up as
 * "web boot: 1 entry did not activate" — exactly the failure that slipped
 * through once already.
 *
 * The second half of this harness is the one that earns its keep: it renders
 * the real settings section and the real footer pill with a miniature React,
 * then drives them. The config round-trip (pull → normalize → draft → POST →
 * re-pull) lives entirely in closures, so a shape mismatch there silently
 * drops channels instead of failing — only a rendered interaction catches it.
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const file = process.argv[2] || 'client.js'
const source = fs.readFileSync(file, 'utf8')

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  failures.push(label)
  return false
}

/* ------------------------------------------------------------------ *
 * Minimal DOM.
 * ------------------------------------------------------------------ */

const made = []

function el(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
    dataset: {},
    children: [],
    attributes: {},
    textContent: '',
    isConnected: true,
    parent: null,
    appendChild(child) {
      child.parent = this
      this.children.push(child)
      return child
    },
    remove() {
      if (this.parent) {
        const at = this.parent.children.indexOf(this)
        if (at >= 0) this.parent.children.splice(at, 1)
        this.parent = null
      }
      this.isConnected = false
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null
    },
    querySelectorAll(selector) {
      const out = []
      const walk = (node) => {
        for (const child of node.children || []) {
          const matches =
            selector.startsWith('.')
              ? String(child.className || '').split(/\s+/).includes(selector.slice(1))
              : selector.startsWith('[')
                ? selector.slice(1, -1) in (child.attributes || {})
                : child.tagName === String(selector).toUpperCase()
          if (matches) out.push(child)
          walk(child)
        }
      }
      walk(this)
      return out
    },
    closest: () => null,
    getBoundingClientRect: () => ({ top: 400, left: 40, right: 200, bottom: 432, width: 160, height: 32 }),
    addEventListener() {},
    removeEventListener() {},
    setAttribute(key, value) {
      this.attributes[key] = value
    },
    getAttribute(key) {
      return this.attributes[key] ?? null
    },
    hasAttribute(key) {
      return key in this.attributes
    },
  }
  made.push(node)
  return node
}

const LANG = process.env.HARNESS_LANG === 'en' ? 'en' : 'zh'
const documentElement = el('html')
documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN'
const body = el('body')
const head = el('head')

global.document = {
  documentElement,
  body,
  head,
  createElement: el,
  createTextNode: (text) => ({ textContent: text }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
global.navigator = { language: LANG === 'en' ? 'en-US' : 'zh-CN' }
global.window = {
  document: global.document,
  navigator: global.navigator,
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => fn(),
  /* The client half only publishes its internals (including the event-vocabulary
     list the host/client parity check compares) when this flag is set. In the
     real GUI it is never set, so nothing internal leaks into production. */
  __DSH_NOTIFY_TEST__: true,
}

/* ------------------------------------------------------------------ *
 * Miniature React: enough to render and drive these components.
 *
 * createElement returns plain objects, hooks live on a per-instance record so
 * state survives a re-render, and effects run once — which is exactly the
 * contract these components rely on.
 * ------------------------------------------------------------------ */

function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props || {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    },
  }
}

/**
 * The stub React the bundle captures at factory time. It forwards every hook
 * to whichever instance is currently rendering, so the components built inside
 * the vm sandbox get real per-instance hook state from `mount()` below.
 */
let activeReact = null

function fallbackReact() {
  throw new Error('a React hook was called outside mount()')
}

const reactStub = {
  createElement: (...args) => activeReact.createElement(...args),
  Fragment: Symbol('Fragment'),
  useState: (...args) => activeReact.useState(...args),
  useRef: (...args) => activeReact.useRef(...args),
  useEffect: (...args) => activeReact.useEffect(...args),
  useReducer: (...args) => activeReact.useReducer(...args),
  useMemo: (...args) => activeReact.useMemo(...args),
  useCallback: (...args) => activeReact.useCallback(...args),
}

/** Every instance mounted during the last flatten, in mount (tree) order. */
const mountedInstances = []

/** Renders one function component and keeps its hook state across re-renders. */
function mount(Component, initialProps) {
  const instance = {
    tree: null,
    cleanups: [],
    hooks: [],
    index: 0,
    props: initialProps || {},
  }
  const react = {
    createElement,
    Fragment: reactStub.Fragment,
    useState(initial) {
      const at = instance.index++
      if (!(at in instance.hooks)) {
        instance.hooks[at] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = instance.hooks[at]
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
        },
      ]
    },
    useRef(initial) {
      const at = instance.index++
      if (!(at in instance.hooks)) instance.hooks[at] = { current: initial }
      return instance.hooks[at]
    },
    useEffect(effect) {
      const at = instance.index++
      if (!(at in instance.hooks)) {
        instance.hooks[at] = true
        const cleanup = effect()
        if (typeof cleanup === 'function') instance.cleanups.push(cleanup)
      }
    },
    useReducer(reducer, initial) {
      const at = instance.index++
      if (!(at in instance.hooks)) instance.hooks[at] = { value: initial }
      const slot = instance.hooks[at]
      return [
        slot.value,
        (action) => {
          slot.value = reducer(slot.value, action)
        },
      ]
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  instance.react = react
  instance.render = () => {
    instance.index = 0
    const previous = activeReact
    activeReact = react
    try {
      instance.tree = Component(instance.props)
    } finally {
      activeReact = previous
    }
    return instance.tree
  }
  instance.render()
  mountedInstances.push(instance)
  return instance
}

/**
 * Position-keyed reconciler.
 *
 * The plugin's components are function components, so a raw element tree stops
 * at the first `<RelayEditor/>` and every assertion would read an empty list.
 * Worse, re-mounting on each query would throw away the draft state the
 * interaction tests drive. So composite children are matched by their position
 * in the tree and re-rendered in place, which is the smallest reconciler that
 * keeps hook state across a re-render.
 */
const instancesByPath = new Map()
let rootComponent = null
let rootProps = {}

function renderTree(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map((entry, index) => renderTree(entry, `${path}[${index}]`))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    let instance = instancesByPath.get(path)
    if (!instance) {
      instance = mount(node.type, node.props || {})
      instancesByPath.set(path, instance)
    } else {
      instance.props = node.props || {}
      instance.render()
    }
    return renderTree(instance.tree, path)
  }
  const children = renderTree(node.props ? node.props.children : null, path)
  return { ...node, props: { ...(node.props || {}), children } }
}

/** Renders a component tree and returns a tree with composites expanded. */
function render(Component, props) {
  rootComponent = Component
  rootProps = props || {}
  return renderTree({ type: Component, props: rootProps }, 'root')
}

/** Re-renders from the root, preserving every instance's hook state. */
function rerender() {
  return render(rootComponent, rootProps)
}

/** Flattens a rendered tree into a list of host nodes and text. */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) {
    for (const entry of node) flatten(entry, out)
    return out
  }
  if (typeof node !== 'object') {
    out.push({ text: String(node) })
    return out
  }
  out.push(node)
  flatten(node.props ? node.props.children : null, out)
  return out
}

/** Every node carrying the given data-testid. */
function byTestId(tree, testId) {
  return flatten(tree).filter((node) => node.props && node.props['data-testid'] === testId)
}

/** Every host input of a given type. */
function inputsOfType(tree, type) {
  return flatten(tree).filter((node) => node.type === 'input' && node.props && node.props.type === type)
}

/** Every element whose props contain the given key. */
function withProp(tree, key) {
  return flatten(tree).filter((node) => node.props && key in node.props)
}

/** All visible text in a tree, joined. */
function textOf(tree) {
  return flatten(tree)
    .filter((node) => typeof node === 'object' && node.text !== undefined)
    .map((node) => node.text)
    .join(' ')
}

/* ------------------------------------------------------------------ *
 * Fake host: the routes the client half talks to.
 * ------------------------------------------------------------------ */

const REDACTED = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

const hostConfig = {
  enabled: true,
  events: { 'task.done': false, 'task.failed': true, 'request.failed': true, 'approval.asked': true },
  dedup: { windowMinutes: 7 },
  quiet: { enabled: true, start: '23:00', end: '07:00', mode: 'drop' },
  digest: { enabled: true, intervalMinutes: 15 },
  channels: [
    {
      id: 'live',
      kind: 'telegram',
      name: '我的手机',
      enabled: true,
      secrets: { token: REDACTED, chatId: '4242' },
      events: ['task.failed'],
      url: '',
    },
  ],
}

const hostLog = [
  { at: '2026-09-25T10:00:00.000Z', event: 'task.failed', title: 'turn 3 failed', channelId: 'live', kind: 'webhook', ok: true, status: 200, ms: 120 },
  { at: '2026-09-25T09:00:00.000Z', event: 'request.failed', title: 'HTTP 500', channelId: 'live', kind: 'webhook', ok: false, status: 500, error: 'http 500', ms: 80 },
  /* A row the rule center chose not to deliver. The interesting row is the
     one every competitor omits. */
  { at: '2026-09-25T08:00:00.000Z', event: 'task.done', title: '', channelId: '', kind: '', ok: false, suppressed: 'digest', error: 'digest batching on', ms: 0 },
]

const posts = []
let held = 0
let pending = 0

const fakeFetch = async (url, options = {}) => {
  const method = options.method || 'GET'
  if (method === 'POST') {
    posts.push({ url, body: JSON.parse(options.body || '{}') })
    /* The host answers with the redacted mirror of what it stored, which is
       what the real route does after a successful write. */
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, config: hostConfig, held, muted: false, pending }),
    }
  }
  if (String(url).endsWith('/notify-relay/config')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, config: hostConfig, held, muted: false, pending }) }
  }
  if (String(url).endsWith('/notify-relay/log')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, entries: hostLog }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}

/* ------------------------------------------------------------------ *
 * Fake locale service (ctx.locale).
 * ------------------------------------------------------------------ */

const localeDicts = new Map()
const localeListeners = new Set()
let activeLocale = LANG

const fakeLocale = {
  register(ns, localeOrDicts, dict) {
    const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
    for (const [locale, entries] of pairs) localeDicts.set(`${ns}:${locale}`, entries)
    return () => {}
  },
  bind(ns) {
    return (key) => {
      const dict = localeDicts.get(`${ns}:${activeLocale}`) || localeDicts.get(`${ns}:en`) || {}
      const value = dict[key]
      return value === undefined ? key : value
    }
  },
  getLocale: () => ({ active: activeLocale, locales: [], revision: 1 }),
  subscribe(fn) {
    localeListeners.add(fn)
    return () => localeListeners.delete(fn)
  },
  setLocale(id) {
    activeLocale = id
    for (const fn of [...localeListeners]) fn()
  },
}

/* ------------------------------------------------------------------ *
 * Module loader facade + require stubs.
 * ------------------------------------------------------------------ */

const loader = {
  load(registration) {
    const require = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react-dom') return { createPortal: (node) => node }
      throw new Error(`unexpected require("${name}") — the client half must stay dependency-free`)
    }
    const returned = registration.factory(require)
    global.__exports__ = returned && typeof returned === 'object' && 'apply' in returned ? returned : null
  },
}

/* The browser half never receives the host's EVENT_KINDS, so its own list is
   the only thing standing between a new event kind and a UI that cannot
   configure it. That is not a hypothetical: `task.aborted`, `task.blocked`,
   `approval.decided` and `tool.failed` were all added to the host and missed
   here, which shipped a settings page with four switches for eight events.
   Comparing the two lists is the only check that catches it. */
const hostModule = require('../index.js')
const hostEventKinds = hostModule.EVENT_KINDS.map((kind) => kind.id)
/* Same hazard, different list: the browser half keeps its own CHANNEL_KINDS so
   it can render the picker and the per-kind secret fields. DingTalk was added
   to both, but a hardcoded "7" in the option-count check would have caught only
   the addition, not a future drift between the two halves. Read the host's list
   and compare against what the client actually renders. */
const hostChannelKinds = hostModule.CHANNEL_KINDS.map((kind) => kind.id)
const EXPECTED_CHANNEL_KINDS = hostChannelKinds.length
const CHANNEL_KIND_IDS = new Set(hostChannelKinds)

/* The stub React forwards to whichever instance mount() is rendering. */
global.window.__ModuleLoader__ = loader

const sandbox = {
  window: global.window,
  document: global.document,
  navigator: global.navigator,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: fakeFetch,
  AbortController,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Symbol,
  Map,
  Set,
  WeakMap,
  Promise,
  RegExp,
  isNaN,
  parseInt,
  parseFloat,
}
sandbox.globalThis = sandbox

/* ------------------------------------------------------------------ *
 * 1. materialize
 * ------------------------------------------------------------------ */

console.log('— materializing the client bundle —')
try {
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: file })
  console.log('  ok: factory executed (no throw at module scope)')
} catch (error) {
  console.log(`  FAIL at materialization: ${error && error.message}`)
  console.log(String(error && error.stack).split('\n').slice(1, 6).join('\n'))
  process.exit(1)
}

const clientExports = global.__exports__
if (!clientExports || typeof clientExports.apply !== 'function') {
  console.log('  FAIL: module.exports has no apply()')
  process.exit(1)
}
console.log(`  exports: apply=${typeof clientExports.apply} inject=${JSON.stringify(clientExports.inject)}`)

/* ------------------------------------------------------------------ *
 * 2. apply against a strict, fail-loud fake ctx
 * ------------------------------------------------------------------ */

console.log('— applying against a fake ctx —')
const registered = []
const effects = []
const injectedProps = {
  wide: true,
  sessionId: 'sess-harness',
  useResource: () => ({ subscribe: () => () => {}, getSnapshot: () => null }),
  useWorkspaces: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ items: [] }) }),
  useSessions: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) }),
  useSessionStatus: () => ({ subscribe: () => () => {}, getSnapshot: () => null }),
  usePanelInfo: () => ({ subscribe: () => () => {}, getSnapshot: () => null }),
}

const fakeServices = {
  slots: {
    register(descriptor, component) {
      registered.push({ descriptor, component })
      return () => {}
    },
    inject(hole, fn) {
      return fn(injectedProps)
    },
    provideRoot() {},
    entries: () => [],
    subscribe: () => () => {},
  },
  locale: fakeLocale,
  /* Cordis built-ins the plugin is allowed to read. */
  effect(fn, name) {
    effects.push(name)
    return fn()
  },
  on: () => () => {},
  set() {},
  get() {
    return undefined
  },
  inject() {},
}

/* The real client runner's ctx is FAIL-LOUD: reading a service the module did
   not list in `inject` throws `cannot get property "X" without inject`, and
   that kills the whole plugin tree. A permissive fake ctx would hide it
   forever — the service would sit on the object and the read would silently
   return undefined. So this fake is strict too. */
const CORDIS_BUILTINS = new Set([
  'effect', 'inject', 'on', 'emit', 'set', 'get', 'scope', 'plugin', 'provide',
  'dispatch', 'accept', 'dispose', 'define', 'flush', 'start', 'extend', 'module',
  'fiber', 'serialize', 'resolve', 'isActive', 'collect',
])
const declared = Array.isArray(clientExports.inject) ? clientExports.inject : []
const allowed = new Set([...declared, ...CORDIS_BUILTINS])
const fakeCtx = new Proxy(fakeServices, {
  get(target, prop) {
    if (typeof prop === 'symbol') return target[prop]
    if (!allowed.has(prop)) throw new Error(`cannot get property "${String(prop)}" without inject`)
    return target[prop]
  },
})

try {
  clientExports.apply(fakeCtx)
  console.log(`  ok: apply() returned; ${registered.length} slot(s), ${effects.length} effect(s)`)
  for (const entry of registered) console.log(`     slot: ${entry.descriptor.name} (id=${entry.descriptor.id})`)
} catch (error) {
  console.log(`  FAIL during apply(): ${error && error.message}`)
  console.log(String(error && error.stack).split('\n').slice(1, 7).join('\n'))
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 3. inject contract
 * ------------------------------------------------------------------ */

console.log('— inject contract —')
const REACHABLE = new Set(['slots', 'locale'])
for (const service of declared) {
  if (!REACHABLE.has(service)) {
    console.log(`  FAIL: inject lists "${service}", which this plugin's fiber cannot reach`)
    console.log('        (cordis waits for it forever -> "web boot: 1 entry did not activate")')
    process.exit(1)
  }
}
for (const service of REACHABLE) {
  if (!declared.includes(service)) {
    console.log(`  FAIL: inject is missing "${service}" — the module reads it, and the runner would throw`)
    process.exit(1)
  }
}
check(`inject = [${declared.join(', ')}] — all declared, all reachable`, true)

/* ------------------------------------------------------------------ *
 * 4. slot registrations
 * ------------------------------------------------------------------ */

console.log('— slot registrations —')
const section = registered.find((entry) => entry.descriptor.name === 'settings.section')
if (!check('settings.section registered', !!section, `registered: ${registered.map((r) => r.descriptor.name).join(', ')}`)) process.exit(1)
check('settings.section id is notify-relay', section.descriptor.id === 'notify-relay', section.descriptor.id)
check('settings.section has an order', typeof section.descriptor.order === 'number', String(section.descriptor.order))
check('the nav label is a thunk', typeof section.descriptor.label === 'function', typeof section.descriptor.label)

const footer = registered.find((entry) => entry.descriptor.name === 'sidebar.footer.action')
if (!check('sidebar.footer.action registered', !!footer, `registered: ${registered.map((r) => r.descriptor.name).join(', ')}`)) process.exit(1)

/* The nav label must follow the active locale: a static string is captured at
   registration and goes stale the moment the user switches language, because
   the page never reloads. Read it in the active language, switch to the other
   one, and read it again — the harness runs once per language, so the expected
   value depends on which language this run started in. */
const navOther = LANG === 'en' ? 'zh' : 'en'
const navLabel = (id) => (id === 'en' ? 'Outbound relay' : '外联中枢')
const navBefore = section.descriptor.label()
fakeLocale.setLocale(navOther)
const navAfter = section.descriptor.label()
fakeLocale.setLocale(LANG)
check('nav label reads the active language', navBefore === navLabel(LANG), `${navBefore} (lang=${LANG})`)
check('nav label follows a language switch', navAfter === navLabel(navOther), `${navAfter} (switched to ${navOther})`)

/* ------------------------------------------------------------------ *
 * 5. dictionaries
 * ------------------------------------------------------------------ */

console.log('— dictionaries —')
const zh = localeDicts.get('dsh-notify-relay:zh')
const en = localeDicts.get('dsh-notify-relay:en')
check('zh dictionary registered', !!zh)
check('en dictionary registered', !!en)
if (zh && en) {
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key))
  check('every zh key exists in en', missingInEn.length === 0, missingInEn.join(', '))
  check('every en key exists in zh', missingInZh.length === 0, missingInZh.join(', '))
  check('dictionaries are non-trivial', zhKeys.length > 40, `${zhKeys.length} keys`)
  const empties = [...zhKeys, ...enKeys].filter((key) => {
    const value = zh[key] ?? en[key]
    return typeof value === 'string' && value.trim() === ''
  })
  check('no empty strings', empties.length === 0, empties.join(', '))
  /* Function-valued entries (plural helpers) must exist in both. */
  const zhFns = zhKeys.filter((key) => typeof zh[key] === 'function')
  const enFns = enKeys.filter((key) => typeof en[key] === 'function')
  check('plural helpers exist in both', zhFns.length === enFns.length && zhFns.length > 0, `zh=${zhFns.join(',')} en=${enFns.join(',')}`)
  if (zhFns.length) {
    check('zh plural helper returns a string', typeof zh[zhFns[0]](3) === 'string')
    check('en plural helper returns a string', typeof en[enFns[0]](3) === 'string')
  }
}

/* ------------------------------------------------------------------ *
 * 6. render the settings section
 * ------------------------------------------------------------------ */

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  /* The poll effect fired an async pull during apply(); let it land so the
     editor's draft is seeded from the host instead of from emptyConfig(). */
  await settle()

  console.log('— settings section render —')
  let tree = render(section.component)
  check('settings section renders a container', !!(tree && tree.type === 'div'), String(tree && tree.type))
  check('title is rendered', textOf(tree).includes(LANG === 'en' ? 'Outbound relay' : '外联中枢'))

  const master = byTestId(tree, 'relay-master')
  check('master switch rendered', master.length === 1, `${master.length} found`)
  check('master switch is checked (host says enabled)', master[0] && master[0].props.checked === true, master[0] ? String(master[0].props.checked) : '')

  const eventSwitches = ['relay-event-task.done', 'relay-event-task.failed', 'relay-event-request.failed', 'relay-event-approval.asked']
  for (const testId of eventSwitches) {
    const found = byTestId(tree, testId)
    check(`event switch ${testId} rendered`, found.length === 1, `${found.length} found`)
  }
  const taskDone = byTestId(tree, 'relay-event-task.done')[0]
  const taskFailed = byTestId(tree, 'relay-event-task.failed')[0]
  check('task.done switch is off (host says off)', taskDone && taskDone.props.checked === false)
  check('task.failed switch is on (host says on)', taskFailed && taskFailed.props.checked === true)

  const dedup = byTestId(tree, 'relay-dedup')
  check('dedup input rendered', dedup.length === 1)
  check('dedup input carries the host value', dedup[0] && dedup[0].props.value === 7, String(dedup[0] && dedup[0].props.value))

  const quiet = byTestId(tree, 'relay-quiet')
  check('quiet-hours switch rendered', quiet.length === 1)
  check('quiet-hours switch is on', quiet[0] && quiet[0].props.checked === true)

  const quietStart = byTestId(tree, 'relay-quiet-start')
  check('quiet start input rendered', quietStart.length === 1)
  check('quiet start carries 23:00', quietStart[0] && quietStart[0].props.value === '23:00', String(quietStart[0] && quietStart[0].props.value))

  const digest = byTestId(tree, 'relay-digest')
  check('digest switch rendered', digest.length === 1)
  check('digest switch is on', digest[0] && digest[0].props.checked === true)

  /* The channel card is the part that silently breaks: if normalizeChannel
     dropped a field the card renders with an empty secret box and a save then
     overwrites the stored token with "". */
  const channelUrl = byTestId(tree, 'relay-channel-url')
  check('telegram channel has no URL field (fixed endpoint)', channelUrl.length === 0, `${channelUrl.length} found`)
  const chatField = byTestId(tree, 'relay-secret-chatId')
  check('telegram chat id field rendered', chatField.length === 1, `${chatField.length} found`)
  check('telegram chat id keeps its value', chatField[0] && chatField[0].props.value === '4242', String(chatField[0] && chatField[0].props.value))
  const tokenField = byTestId(tree, 'relay-secret-token')
  check('telegram token field rendered', tokenField.length === 1, `${tokenField.length} found`)
  check('telegram token is masked', tokenField[0] && tokenField[0].props.value === REDACTED, String(tokenField[0] && tokenField[0].props.value))
  check('telegram token is a password input', tokenField[0] && tokenField[0].props.type === 'password', String(tokenField[0] && tokenField[0].props.type))

  const kindSelect = byTestId(tree, 'relay-channel-kind')
  check('channel kind select rendered', kindSelect.length === 1)
  /* The count must equal CHANNEL_KINDS.length in BOTH halves. A hardcoded
     number is how the last channel addition (DingTalk) broke this: the select
     grew to 8 and the check still asked for 7. Read it from the module under
     test instead, so a new channel cannot desynchronise the harness. */
  const kindCount = kindSelect[0] ? flatten(kindSelect[0]).filter((node) => node.type === 'option').length : 0
  check('channel kind select lists every declared kind', kindCount === EXPECTED_CHANNEL_KINDS, `${kindCount} options, expected ${EXPECTED_CHANNEL_KINDS}`)
  const hostKinds = CHANNEL_KIND_IDS.size
  check('the client lists exactly the kinds the host declares', kindCount === hostKinds, `client ${kindCount}, host ${hostKinds}`)

  const logRows = flatten(tree).filter((node) => node.props && node.props.className === 'dsh-relay-log-row')
  check('delivery log rows rendered', logRows.length === 3, `${logRows.length} found`)
  check('a failed delivery is marked failed', textOf(tree).includes(LANG === 'en' ? 'failed' : '失败'))

  /* ---- the event vocabulary must match the host, kind for kind ---- */
  const clientEventIds = clientExports.__test__ ? clientExports.__test__.ids.events : null
  const labelKeys = clientExports.__test__ ? clientExports.__test__.ids.labels : null
  check('the client exposes its event list for comparison', Array.isArray(clientEventIds), String(clientEventIds))
  if (Array.isArray(clientEventIds)) {
    check(
      'the client event list matches the host EVENT_KINDS exactly',
      clientEventIds.length === hostEventKinds.length && clientEventIds.every((id, index) => id === hostEventKinds[index]),
      `client=[${clientEventIds.join(',')}] host=[${hostEventKinds.join(',')}]`,
    )
    /* Every kind needs a label in BOTH dictionaries, or the switch renders
       with the raw key as its caption in the language nobody tested. The
       mapping is the client's own, so ask it rather than deriving a key —
       `approval.asked` labels as `evApproval`, not `evApprovalAsked`. */
    check('every event kind has a label key', labelKeys && clientEventIds.every((id) => typeof labelKeys[id] === 'string'), JSON.stringify(labelKeys))
    if (labelKeys) {
      for (const locale of ['zh', 'en']) {
        fakeLocale.setLocale(locale)
        const dict = clientExports.__test__.t
        const missing = clientEventIds.filter((id) => {
          const value = dict[labelKeys[id]]
          return typeof value !== 'string' || value.length === 0
        })
        check(`every event kind has a ${locale} label`, missing.length === 0, missing.map((id) => labelKeys[id]).join(','))
      }
      fakeLocale.setLocale(LANG)
    }
  }

  /* ---- the observability surface ----

     The most common complaint about notification plugins in this ecosystem is
     "I cannot tell whether it fired". So the log must show the rows where the
     rule center decided NOT to deliver, must name the EVENT (not just the
     channel), and the retry queue must be reachable. */
  const suppressedRows = logRows.filter((node) => node.props['data-suppressed'] === 'true')
  check('a suppressed row is marked as such', suppressedRows.length === 1, `${suppressedRows.length} found`)
  check('the suppressed row names the verdict reason', textOf(suppressedRows[0] || { props: {} }).includes('digest'), textOf(suppressedRows[0] || { props: {} }))
  check('a row names the event, not just the channel', logRows.some((node) => textOf(node).includes('task.failed')), JSON.stringify(logRows.map((n) => textOf(n))))
  check('the retry button is disabled when nothing is pending', byTestId(tree, 'relay-retry')[0]?.props.disabled === true, String(byTestId(tree, 'relay-retry')[0]?.props.disabled))

  const languageSelect = byTestId(tree, 'relay-language')
  check('delivery language select rendered', languageSelect.length === 1)
  check('delivery language offers zh and en', flatten(languageSelect[0] || { props: {} }).filter((node) => node.type === 'option').length === 2)

  /* ------------------------------------------------------------------ *
   * 7. drive the editor: toggle + save, and prove the round-trip contract
   * ------------------------------------------------------------------ */

  console.log('— editor interaction —')
  check('save button rendered', byTestId(tree, 'relay-save').length === 1)
  check('add-channel button rendered', byTestId(tree, 'relay-add-channel').length === 1)

  /* Toggle the master switch off. Every query below reads the tree returned by
     rerender(), never the first one: a stale node's closure still works, but a
     stale tree still shows the old value. */
  byTestId(tree, 'relay-master')[0].props.onChange({ target: { checked: false } })
  tree = rerender()
  check('toggling the master switch updates the draft', byTestId(tree, 'relay-master')[0].props.checked === false)

  /* Toggle an event on. */
  byTestId(tree, 'relay-event-task.done')[0].props.onChange({ target: { checked: true } })
  tree = rerender()
  check('toggling an event switch updates the draft', byTestId(tree, 'relay-event-task.done')[0].props.checked === true)

  /* Add a channel: the new card must appear. */
  byTestId(tree, 'relay-add-channel')[0].props.onClick()
  tree = rerender()
  const cardsAfterAdd = byTestId(tree, 'relay-channel-kind').length
  check('add-channel appends a card', cardsAfterAdd === 2, `${cardsAfterAdd} cards`)

  /* Save, and inspect exactly what the host receives. */
  const before = posts.length
  byTestId(tree, 'relay-save')[0].props.onClick()
  await settle()

  const saved = posts.slice(before)
  check('save issues exactly one POST', saved.length === 1, `${saved.length} posts`)
  if (saved.length === 1) {
    check('save posts to the config route', saved[0].url.endsWith('/notify-relay/config'), saved[0].url)
    const sent = saved[0].body.config
    check('POST carries the toggled master switch', sent && sent.enabled === false, JSON.stringify(sent && sent.enabled))
    check('POST carries the toggled event', sent && sent.events['task.done'] === true)
    check('POST carries the dedup window', sent && sent.dedup.windowMinutes === 7, sent ? String(sent.dedup.windowMinutes) : '')
    check('POST carries the quiet window', sent && sent.quiet.start === '23:00' && sent.quiet.mode === 'drop')
    check('POST carries the digest interval', sent && sent.digest.intervalMinutes === 15, sent ? String(sent.digest.intervalMinutes) : '')
    check('POST carries both channels', Array.isArray(saved[0].body.config.channels) && saved[0].body.config.channels.length === 2, sent ? String(sent.channels.length) : 'no channels')
    const original = sent && sent.channels && sent.channels.find((channel) => channel.id === 'live')
    check('the untouched secret is echoed back as the mask', original && original.secrets.token === REDACTED, original ? JSON.stringify(original.secrets) : 'channel lost')
    check('the non-secret id is echoed back intact', original && original.secrets.chatId === '4242', original ? JSON.stringify(original.secrets) : 'channel lost')
    check('the event filter survives', original && original.events.join(',') === 'task.failed', original ? original.events.join(',') : '')
    check('the channel name survives', original && original.name === '我的手机', original ? original.name : '')
    check('the url field is present for webhook kinds', 'url' in (original || {}))
  }

  /* ------------------------------------------------------------------ *
   * 8. footer pill
   * ------------------------------------------------------------------ */

  console.log('— footer pill —')
  instancesByPath.clear()
  let footerTree = render(footer.component, { wide: true })
  const pill = byTestId(footerTree, 'relay-footer')
  check('footer pill rendered', pill.length === 1)
  check('pill reports the relay as on', pill[0] && pill[0].props['data-on'] === 'true', pill[0] ? String(pill[0].props['data-on']) : '')
  check('pill reports the last delivery state', pill[0] && pill[0].props['data-last'] === 'ok', pill[0] ? String(pill[0].props['data-last']) : '')
  check('pill is not in rail mode when wide', pill[0] && pill[0].props['data-rail'] === 'false')
  check('pill carries an accessible label', pill[0] && typeof pill[0].props['aria-label'] === 'string' && pill[0].props['aria-label'].length > 0)

  /* Opening the panel must render the delivery log. */
  pill[0].props.onClick()
  footerTree = rerender()
  const panel = byTestId(footerTree, 'relay-panel')
  check('clicking the pill opens the delivery panel', panel.length === 1, `${panel.length} found`)
  if (panel.length === 1) {
    check('the panel lists the recent deliveries', textOf(panel[0]).includes('10:00') || textOf(panel[0]).length > 20)
    check('the panel names the settings page', textOf(panel[0]).includes(LANG === 'en' ? 'Settings' : '设置'))
  }

  /* Rail mode (a collapsed sidebar) must render the compact pill. */
  instancesByPath.clear()
  const railTree = render(footer.component, { wide: false })
  const railPill = byTestId(railTree, 'relay-footer')[0]
  check('rail mode renders the compact pill', railPill && railPill.props['data-rail'] === 'true')

  /* ------------------------------------------------------------------ *
   * 9. broken variants
   * ------------------------------------------------------------------ */

  console.log('— broken variants —')
  const variants = [
    {
      label: 'a static settings.section label',
      mutate: (src) => src.replace('label: () => t.settingsNav', 'label: t.settingsNav'),
      expect: (state) => state.registered.some((entry) => entry.descriptor.name === 'settings.section' && typeof entry.descriptor.label !== 'function'),
    },
    {
      label: 'the footer slot registration removed',
      mutate: (src) =>
        src.replace(
          /      ctx\.slots\.inject\('sidebar\.footer\.action', \(\) =>\n        ctx\.slots\.register\(\{ name: 'sidebar\.footer\.action'[^\n]*\n      \)\n/,
          '',
        ),
      expect: (state) => !state.registered.some((entry) => entry.descriptor.name === 'sidebar.footer.action'),
    },
    {
      label: 'the en dictionary deleted',
      mutate: (src) => src.replace(/const EN = \{[\s\S]*?\n    \}/, 'const EN = {}'),
      expect: (state) => Object.keys(state.dicts.get('dsh-notify-relay:en') || {}).length === 0,
    },
    {
      label: 'inject loses locale',
      mutate: (src) => src.replace("const inject = ['slots', 'locale']", "const inject = ['slots']"),
      expect: (state) => state.threw && /without inject/.test(state.threw.message),
    },
  ]

  for (const variant of variants) {
    const mutated = variant.mutate(source)
    if (mutated === source) {
      console.log(`  skip ${variant.label} (pattern no longer present)`)
      continue
    }
    /* The variant is materialized in a fresh sandbox so its registrations do
       not pollute the assertions above. The exports land in a closure variable
       because the vm context has its own global object. */
    let variantExports = null
    const variantLoader = {
      load(registration) {
        const require = (name) => {
          if (name === 'react') return reactStub
          if (name === 'react-dom') return { createPortal: (node) => node }
          throw new Error(`unexpected require("${name}")`)
        }
        variantExports = registration.factory(require)
      },
    }
    const variantWindow = { ...global.window, __ModuleLoader__: variantLoader }
    const variantSandbox = { ...sandbox, window: variantWindow }
    variantSandbox.globalThis = variantSandbox
    try {
      vm.createContext(variantSandbox)
      vm.runInContext(mutated, variantSandbox, { filename: 'client-variant.js' })
    } catch (error) {
      console.log(`  ok   variant rejected: ${variant.label} (materialization threw: ${error.message})`)
      continue
    }
    if (!variantExports || typeof variantExports.apply !== 'function') {
      console.log(`  FAIL variant rejected: ${variant.label} — the variant exported no apply(), so nothing was proved`)
      failures.push(variant.label)
      continue
    }

    /* A fresh fake ctx with its own registration list, so the variant's
       behaviour is observed rather than inferred. */
    const state = { registered: [], dicts: localeDicts, threw: null }
    const variantServices = {
      slots: {
        register(descriptor, component) {
          state.registered.push({ descriptor, component })
          return () => {}
        },
        inject(hole, fn) {
          return fn(injectedProps)
        },
      },
      locale: fakeLocale,
      effect(fn) {
        return fn()
      },
      on: () => () => {},
      set() {},
      get() {
        return undefined
      },
      inject() {},
    }
    const variantCtx = new Proxy(variantServices, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop]
        const variantDeclared = Array.isArray(variantExports.inject) ? variantExports.inject : []
        if (!variantDeclared.includes(prop) && !CORDIS_BUILTINS.has(prop)) {
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        }
        return target[prop]
      },
    })
    try {
      variantExports.apply(variantCtx)
    } catch (error) {
      state.threw = error
    }

    if (variant.expect(state)) {
      console.log(`  ok   variant rejected: ${variant.label}`)
    } else {
      console.log(
        `  FAIL variant rejected: ${variant.label} — expected a failure, got none ` +
          `(threw=${state.threw ? state.threw.message : 'no'}, slots=${state.registered.map((entry) => entry.descriptor.name).join('|')})`,
      )
      failures.push(variant.label)
    }
  }

  /* ------------------------------------------------------------------ *
   * report
   * ------------------------------------------------------------------ */

  console.log(`\n${failures.length} failure(s)`)
  if (failures.length) {
    console.log('\nCLIENT GATE FAIL')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log('CLIENT GATE OK')
  process.exit(0)
}

main().catch((error) => {
  console.log(`FAIL: ${error && error.message}`)
  console.log(String(error && error.stack).split('\n').slice(1, 8).join('\n'))
  process.exit(1)
})
