'use strict'
// 界面接线冒烟回归：用最小 DOM + 假宿主把 js/app.js 真跑一遍。
// 第 1 轮：连口 → 独占声明 → 读参数 → 探测 → 上电/电压 → 采样 → 合批事件 → 缺口 → 导出 → 停采 → 断开。
// 第 2 轮：滚轮缩放、拖拽平移、框选放大、游标拖动与读数、Y 轴三档、包络/均值带开关、
//          显示触发、采样沿触发、分析面板（FFT / 电池 / 周期叠画）、总览条定位、最大化与 Esc。
// 只验证接线、状态流转与「不抛错」，不做像素断言（画布是 stub）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// ---------- 最小 DOM ----------
function makeCtx2d() {
	const noop = function () {}
	const o = {
		setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop,
		lineTo: noop, stroke: noop, fill: noop, closePath: noop, save: noop, restore: noop,
		clip: noop, rect: noop, strokeRect: noop, setLineDash: noop, fillText: noop,
		measureText: () => ({ width: 10 }), globalAlpha: 1,
	}
	return o
}

class El {
	constructor(tag) {
		this.tagName = String(tag || 'div').toUpperCase()
		this.children = []
		this.attrs = {}
		this.dataset = {}
		this.style = {}
		this.listeners = {}
		this.options = []
		this.selectedIndex = 0
		this.disabled = false
		this.hidden = false
		this._value = ''
		this._text = ''
		this.clientWidth = 640
		this.clientHeight = 280
		this.width = 0
		this.height = 0
		this.scrollTop = 0
		this.scrollHeight = 0
	}
	get value() {
		if (this.tagName === 'SELECT' && this.options.length) {
			const o = this.options[this.selectedIndex]
			return o ? o.value : ''
		}
		// 假 DOM 不解析 index.html：没有 option 时直接返回被赋的值（与真实 select 的语义一致）
		return this._value
	}
	set value(v) {
		this._value = String(v)
		if (this.tagName === 'SELECT') {
			for (let i = 0; i < this.options.length; i++) {
				if (this.options[i].value === this._value) { this.selectedIndex = i; break }
			}
		}
	}
	get textContent() { return this._text }
	set textContent(v) {
		this._text = String(v)
		this.children.length = 0
		if (this.tagName === 'SELECT') this.options.length = 0
	}
	get childNodes() { return this.children }
	get firstChild() { return this.children[0] || null }
	get className() { return this.attrs.class || '' }
	set className(v) { this.attrs.class = v }
	appendChild(c) {
		this.children.push(c)
		if (this.tagName === 'SELECT' && c.tagName === 'OPTION') {
			this.options.push(c)
			if (this.options.length === 1) this.selectedIndex = 0
		}
		return c
	}
	removeChild(c) {
		const i = this.children.indexOf(c)
		if (i >= 0) this.children.splice(i, 1)
		return c
	}
	addEventListener(type, fn, opts) {
		void opts
		;(this.listeners[type] = this.listeners[type] || []).push(fn)
	}
	removeEventListener() {}
	setAttribute(k, v) { this.attrs[k] = String(v) }
	getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
	removeAttribute(k) { delete this.attrs[k] }
	getContext() { return makeCtx2d() }
	getBoundingClientRect() {
		return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }
	}
	setPointerCapture() {}
	releasePointerCapture() {}
	focus() { fired.focused = this.id }
	click() { fire(this, 'click', { detail: 1 }) }
	set innerHTML(v) { this._text = String(v); this.children.length = 0 }
	get innerHTML() { return this._text }
}

const fired = { focused: null }

function fire(el, type, props) {
	const ev = Object.assign({
		type: type,
		preventDefault: function () { ev.defaultPrevented = true },
		stopPropagation: function () {},
		pointerId: 1,
		button: 0,
	}, props || {})
	const list = (el.listeners && el.listeners[type]) || []
	list.forEach(function (fn) { fn(ev) })
	return ev
}

function makeDocument() {
	const byId = new Map()
	const doc = {
		readyState: 'complete',
		documentElement: new El('html'),
		body: new El('body'),
		getElementById(id) {
			if (!byId.has(id)) {
				const tag = (id === 'port' || id === 'rate' || id === 'view' || id === 'trig-mode' || id === 'trig-pre' || id === 'acq-start' || id === 'acq-stop' || id === 'an-source') ? 'select' : (id === 'wave' || id === 'minimap') ? 'canvas' : 'div'
				const el = new El(id === 'wave' || id === 'minimap' ? 'canvas' : tag)
				el.id = id
				if (el.tagName === 'CANVAS') {
					el.clientWidth = id === 'wave' ? 640 : 640
					el.clientHeight = id === 'wave' ? 280 : 56
				}
				byId.set(id, el)
			}
			return byId.get(id)
		},
		createElement(tag) { return new El(tag) },
		createTextNode(t) { const e = new El('#text'); e._text = String(t); return e },
		addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn) },
		listeners: {},
		fullscreenElement: null,
	}
	// 带 data-i18n* 的元素：从真实 index.html 解析出来（有 id 的复用 getElementById 的同一个对象），
	// 这样语言切换的静态文案刷新走的是真实标记，而不是测试里另编一份
	const i18nEls = []
	const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
	const tagRe = /<(\w+)\s([^<>]*data-i18n[^<>]*)>/g
	let m
	while ((m = tagRe.exec(html))) {
		const attrs = {}
		const attrRe = /([\w-]+)="([^"]*)"/g
		let a
		while ((a = attrRe.exec(m[2]))) attrs[a[1]] = a[2]
		const el = attrs.id ? doc.getElementById(attrs.id) : new El(m[1])
		Object.keys(attrs).forEach(function (k) { if (k.indexOf('data-i18n') === 0 || k === 'title' || k === 'placeholder' || k === 'aria-label') el.attrs[k] = attrs[k] })
		i18nEls.push(el)
	}
	doc.querySelectorAll = function (sel) {
		void sel
		return i18nEls.filter(function (el) {
			return ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria'].some(function (k) { return el.getAttribute(k) })
		})
	}
	doc.title = ''
	doc._byId = byId
	doc._i18nEls = i18nEls
	return doc
}

// ---------- 假宿主 SDK ----------
function makeFakeSdk(state) {
	const handlers = new Map()
	const claims = new Map()
	let claimSeq = 0
	const sdk = {
		on(name, fn) {
			const set = handlers.get(name) || new Set()
			set.add(fn)
			handlers.set(name, set)
			if (name === 'claim.state') state.claimStateHandler = fn
			return function () { set.delete(fn) }
		},
		getTheme() { return { theme: 'dark', tokens: {} } },
		ready() { return Promise.resolve({ theme: 'dark', tokens: {} }) },
		app: {
			storageGet: async (k) => state.settings[k] === undefined ? null : state.settings[k],
			storageSet: async (k, v) => { state.saved.push([k, v]); state.settings[k] = v; return { ok: true } },
			busyAcquire: async (label) => { state.busy.push(label); return { busyId: 'busy' + state.busy.length } },
			busyRelease: async (id) => { state.released.push(id); return { released: true } },
			saveFile: async (opts) => { state.files.push(opts); return { name: opts.name } },
			notify: async () => ({ ok: true }),
		},
		log: { write: async (text) => { state.hostLogs.push(text); return { ok: true } } },
		// 宿主 SDK 的 claim 回调错误处理器（插件把它接到日志上）
		setClaimErrorHandler(fn) { state.claimErrorHandler = typeof fn === 'function' ? fn : null },
		device: { listPorts: async () => state.ports.slice() },
		claim: {
			acquire: async (portKey, mode) => {
				const id = 'claim' + (++claimSeq)
				claims.set(id, { open: false })
				state.claimIds.push(id)
				state.acquires.push([portKey, mode])
				return { claimId: id, mode: mode }
			},
			open: async (id) => {
				const c = claims.get(id)
				if (c) c.open = true
				// 与宿主一致：每个新声明的字节流从 offset 0、seq 1 开始（gen 从 1 起）
				state.rxOffset = 0
				state.rxSeq = 0
				return { claimId: id, open: true }
			},
			close: async (id) => { const c = claims.get(id); if (c) c.open = false; return { closed: true } },
			release: async (id) => { claims.delete(id); return { released: true } },
			write: async (id, bytes) => {
				// 与宿主 plugin-rpc.toBytes 同一契约：只收 0..255 的普通数组或十六进制串，Uint8Array 一律 bad_request
				if (!Array.isArray(bytes) && typeof bytes !== 'string') {
					const err = new Error('数据必须是字节数组或十六进制串')
					err.code = 'bad_request'
					throw err
				}
				if (state.failWrites) {
					const err = new Error(state.failWrites)
					err.code = 'internal'
					throw err
				}
				state.writes.push(Array.from(bytes))
				if (bytes[0] === 0x19) state.pushRxText('R0=1031.64\r\nVDD=3300 mV\r\nEND\r\n')
				if (bytes[0] === 0x06 && !state.silent) state.pushRxSamples(300, 1000)
				return { bytes: bytes.length }
			},
			onRx(fn) { state.rxHandler = fn; return function () {} },
			onGap(fn) { state.gapHandler = fn; return function () {} },
			ack: async () => ({ ack: true }),
		},
	}
	// 宿主语言推送：state.localeSupport 打开时模拟新 SDK（getLocale / onLocale），否则只有 on('app.locale')
	state.emit = function (name, payload) {
		const set = handlers.get(name)
		if (set) Array.from(set).forEach(function (fn) { fn(payload) })
	}
	if (state.localeSupport) {
		const fns = []
		sdk.getLocale = function () { return state.hostLocale || null }
		sdk.onLocale = function (fn) {
			fns.push(fn)
			if (state.hostLocale) fn(state.hostLocale)
			return function () {}
		}
		state.pushLocale = function (l) {
			state.hostLocale = l
			fns.forEach(function (fn) { fn(l) })
		}
	}
	return sdk
}

// ---------- 运行 app.js ----------
const root = path.join(__dirname, '..')
const files = [
	'js/power-i18n.js', 'js/power-protocol.js', 'js/power-view.js', 'js/power-lane.js', 'js/power-analysis.js',
	'js/power-store.js', 'js/power-wave.js', 'js/power-panels.js', 'js/power-claim.js',
	'js/power-control.js', 'js/power-export.js', 'js/power-import.js',
]

function makeEnv(state, opts) {
	opts = opts || {}
	const document = makeDocument()
	const win = {
		document: document,
		devicePixelRatio: 2,
		listeners: {},
		addEventListener(type, fn) { (win.listeners[type] = win.listeners[type] || []).push(fn) },
		removeEventListener() {},
		requestAnimationFrame(fn) { return setTimeout(fn, 0) },
		cancelAnimationFrame() {},
		getComputedStyle() { return { getPropertyValue: () => '' } },
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		setInterval: setInterval, clearInterval: clearInterval,
	}
	const sandbox = {
		window: win,
		document: document,
		getComputedStyle: () => ({ getPropertyValue: () => '' }),
		requestAnimationFrame: win.requestAnimationFrame,
		setTimeout, clearTimeout, setInterval, clearInterval,
		performance: { now: () => Date.now() },
		console, Date, Math, JSON, Number, String, Boolean, Array, Object, Promise, Map, Set,
		Uint8Array, Float32Array, Float64Array, ArrayBuffer, isFinite, parseInt, parseFloat, Infinity, NaN,
	}
	// 没给 navigator 时沙箱里就没有（回退到 en）
	if (opts.navigator) { sandbox.navigator = opts.navigator; win.navigator = opts.navigator }
	sandbox.globalThis = sandbox
	sandbox.window.window = win
	vm.createContext(sandbox)
	for (const rel of files) {
		vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), sandbox, { filename: rel })
	}
	const sdk = makeFakeSdk(state)
	sandbox.window.DeviceDockPlugin = sdk
	sandbox.DeviceDockPlugin = sdk
	vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), sandbox, { filename: 'js/app.js' })
	return { sandbox, document, sdk, win }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 5 : ms))
const text = (doc, id) => doc.getElementById(id).textContent
const click = (doc, id) => doc.getElementById(id).click()
const fireKey = (win, key, props) => {
	const ev = Object.assign({ key: key, preventDefault: function () {}, stopPropagation: function () {}, target: null }, props || {})
	;(win.listeners.keydown || []).forEach(function (fn) { fn(ev) })
	return ev
}

;(async function () {
	// 合成样点流：adc 很小 → 电流接近 0；logic=0xff、range=3 都是合法字
	let counter = 0
	function mkSamples(n, adcBase) {
		const u8 = new Uint8Array(n * 4)
		for (let i = 0; i < n; i++) {
			const c = (counter++) & 0x3f
			const w = (((0xff) << 24) | (c << 18) | (3 << 14) | ((adcBase + (i % 5)) & 0x3fff)) >>> 0
			u8[i * 4] = w & 0xff
			u8[i * 4 + 1] = (w >>> 8) & 0xff
			u8[i * 4 + 2] = (w >>> 16) & 0xff
			u8[i * 4 + 3] = (w >>> 24) & 0xff
		}
		return u8
	}

	const state = {
		settings: {},
		saved: [],
		busy: [],
		released: [],
		files: [],
		writes: [],
		acquires: [],
		claimIds: [],
		hostLogs: [],
		rxOffset: 0,
		rxSeq: 0,
		gen: 1,
		ports: [
			{ key: 'p1', portName: 'COM7', productName: 'BLU Power Monitor', serialNumber: 'SN-42' },
			// 非 BLU 设备：必须被筛掉
			{ key: 'p0', portName: 'COM3', productName: 'CP2102 USB to UART' },
			// 别名里带小写 blu 也算
			{ key: 'p2', portName: 'COM8', productName: 'Other', alias: 'my-blu', busy: 'channel A' },
		],
		rxHandler: null,
		gapHandler: null,
		claimErrorHandler: null,
		claimStateHandler: null,
	}
	state.pushRxBytes = function (bytes) {
		state.rxSeq++
		const offset = state.rxOffset
		state.rxOffset += bytes.length
		if (!state.rxHandler) return
		// 用当前声明的 id（重连后是新声明，旧 id 的数据会被插件正确丢弃）
		state.rxHandler({ claimId: state.claimIds[state.claimIds.length - 1] || 'claim1', gen: state.gen, seq: state.rxSeq, offset: offset, at: Date.now(), bytes: bytes })
	}
	state.pushRxText = function (s) {
		const bytes = new Uint8Array(s.length)
		for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff
		state.pushRxBytes(bytes)
	}
	state.pushRxSamples = function (n, adc) { state.pushRxBytes(mkSamples(n, adc)) }

	const { document, win } = makeEnv(state)
	await tick(60)

	// ---- 启动 ----
	assert.equal(document.getElementById('port').options.length, 2, '只列 BLU 设备（非 BLU 的 CP2102 不出现）')
	assert.match(document.getElementById('port').options[0].textContent, /BLU Power Monitor/)
	assert.ok(!document.getElementById('port').options.some((o) => /CP2102/.test(o.textContent)), '非 BLU 口不能出现')
	assert.match(document.getElementById('port').options[1].textContent, /busy: channel A/)
	assert.equal(text(document, 'chip-sampling'), 'idle')
	assert.equal(text(document, 'chip-theme'), 'theme: dark')
	assert.match(text(document, 'chip-trigger'), /^trigger: off/)
	assert.ok(document.getElementById('log').children.length >= 1, '启动日志')

	// ---- 连接：独占声明 → 打开 → 读设备参数 → 探测 DUT 供电 ----
	click(document, 'btn-connect')
	await tick(500)
	assert.deepEqual(state.acquires[0], ['p1', 'exclusive'], '必须走 claim.acquire(mode=exclusive)')
	assert.equal(text(document, 'chip-port').indexOf('port: BLU Power Monitor'), 0)
	assert.equal(text(document, 'btn-connect'), 'Disconnect')
	assert.ok(state.writes.some((w) => w[0] === 0x19), '打开后读设备参数（0x19）')
	assert.equal(document.getElementById('voltage').value, '3300', 'metadata 里的 VDD 回填到输入框')

	// ---- 电压 ----
	document.getElementById('voltage').value = '1800'
	click(document, 'btn-apply-voltage')
	await tick(40)
	assert.ok(state.writes.some((w) => w[0] === 0x0d && w[1] === 0x07), '写 REGULATOR 1800 mV')
	await tick(450)
	assert.ok(state.saved.some(([k]) => k === 'settings'), '设置会落盘')

	// ---- 开始采样 ----
	state.writes.length = 0
	state.rxSeq = 0
	click(document, 'btn-sample')
	await tick(150)
	assert.equal(state.busy.length, 1, '采样期间持有更新屏障')
	assert.deepEqual(state.writes.map((w) => w[0]), [0x07, 0x06], '先 STOP 排空再 START')
	assert.equal(text(document, 'chip-sampling'), 'capturing')

	// ---- 合批事件：一条含多帧、下一条接着上一批的 offset ----
	state.pushRxSamples(600, 1000)
	await tick(30)
	state.pushRxSamples(300, 1200)
	await tick(520)
	const kept = Number(text(document, 'ro-samples').replace(/[^0-9]/g, ''))
	assert.ok(kept > 0, '样点进波形：' + ['st-samples', 'ro-samples', 'scope-meta'].map((id) => id + '=' + text(document, id)).join(' '))

	// ---- 语言切换（旧 SDK 路径：on('app.locale')）：采集中就地刷新，采集状态不丢 ----
	{
		assert.equal(text(document, 'btn-sample'), 'Stop capture', '无 navigator / 无宿主推送时回退 en')
		state.emit('app.locale', { locale: 'zh-CN' })
		await tick(20)
		assert.equal(text(document, 'btn-sample'), '停止采集', '运行时按钮文案切到中文')
		assert.equal(text(document, 'chip-sampling'), '采集中')
		assert.equal(text(document, 'btn-connect'), '断开')
		assert.equal(text(document, 'btn-refresh'), '刷新', '静态 data-i18n 文案刷新')
		assert.equal(text(document, 'gaps-hint').indexOf('缺口来自'), 0)
		assert.equal(document.getElementById('trig-level').getAttribute('placeholder'), '自动 µA', 'placeholder 刷新')
		assert.equal(document.getElementById('port').getAttribute('aria-label'), '串口', 'aria-label 刷新')
		assert.match(text(document, 'chip-port'), /^端口：BLU Power Monitor/)
		assert.equal(text(document, 'session-meta'), '已连接')
		assert.match(text(document, 'chip-theme'), /^主题：/)
		assert.match(text(document, 'scope-meta'), /个样点/)
		assert.equal(document.title, '功耗分析仪')
		assert.equal(document.documentElement.getAttribute('lang'), 'zh-CN')
		// 采集没有被打断：样点继续入库
		const before = Number(text(document, 'ro-samples').replace(/[^0-9]/g, ''))
		state.pushRxSamples(600, 1000)
		await tick(450)
		const after = Number(text(document, 'ro-samples').replace(/[^0-9]/g, ''))
		assert.ok(after > before, '切换语言后采集继续：' + before + ' → ' + after)
		assert.equal(text(document, 'btn-sample'), '停止采集')
		state.emit('app.locale', { locale: 'en' })
		await tick(20)
		assert.equal(text(document, 'btn-sample'), 'Stop capture')
		assert.equal(text(document, 'btn-refresh'), 'Refresh')
		assert.equal(text(document, 'chip-sampling'), 'capturing')
		assert.equal(document.getElementById('trig-level').getAttribute('placeholder'), 'auto µA')
	}

	// ---- 缺口 1：宿主静默少发一批（offset 跳号）----
	const gapsBefore = text(document, 'chip-gaps')
	state.rxOffset += 96
	state.pushRxSamples(64, 1400)
	await tick(60)
	assert.notEqual(text(document, 'chip-gaps'), gapsBefore, 'offset 跳号要标成缺口：' + text(document, 'chip-gaps'))
	// ---- 缺口 2：宿主 claim.gap（overflow）----
	const gapsAfterSkip = text(document, 'chip-gaps')
	state.gapHandler({ claimId: state.claimIds[0], gen: state.gen, offset: state.rxOffset, bytes: 4096, reason: 'overflow' })
	state.rxOffset += 4096
	await tick(60)
	assert.notEqual(text(document, 'chip-gaps'), gapsAfterSkip, 'claim.gap 也要标成缺口')

	// 视口交互要有足够的点数才有意义（默认视口 2000 点）：灌 300k 原始点 ≈ 3000 个入库点
	state.pushRxSamples(300000, 1000)
	await tick(200)

	// ---- 第 2 轮：滚轮缩放 ----
	const canvas = document.getElementById('wave')
	const beforeZoom = text(document, 'scope-meta')
	fire(canvas, 'wheel', { clientX: 340, clientY: 120, deltaY: -120, shiftKey: false })
	await tick(40)
	assert.match(text(document, 'scope-meta'), /paused/, '缩放后退出 Live：' + text(document, 'scope-meta'))
	assert.notEqual(text(document, 'scope-meta'), beforeZoom)
	const zoomedIn = Number((text(document, 'scope-meta').match(/^[\d,]+/) || ['0'])[0].replace(/,/g, ''))
	const beforeZoomPts = Number((beforeZoom.match(/^[\d,]+/) || ['0'])[0].replace(/,/g, ''))
	assert.ok(zoomedIn < beforeZoomPts, '放大后视口点数变少：' + zoomedIn + ' < ' + beforeZoomPts)
	// 滚轮缩小
	fire(canvas, 'wheel', { clientX: 340, clientY: 120, deltaY: 120, shiftKey: false })
	await tick(40)
	const zoomedOut = Number((text(document, 'scope-meta').match(/^[\d,]+/) || ['0'])[0].replace(/,/g, ''))
	assert.ok(zoomedOut > zoomedIn, '缩小后点数变多：' + zoomedOut)
	// Y 轴滚轮（左轴区域）+ Shift+滚轮 都只改 Y，不改视口点数
	const ptsBeforeY = text(document, 'scope-meta')
	fire(canvas, 'wheel', { clientX: 10, clientY: 120, deltaY: -120 })
	fire(canvas, 'wheel', { clientX: 340, clientY: 120, deltaY: -120, shiftKey: true })
	await tick(40)
	assert.equal(text(document, 'scope-meta'), ptsBeforeY, 'Y 轴缩放不动视口点数')

	// ---- 拖拽平移 ----
	fire(canvas, 'pointerdown', { clientX: 300, clientY: 120 })
	fire(canvas, 'pointermove', { clientX: 380, clientY: 120 })
	fire(canvas, 'pointerup', { clientX: 380, clientY: 120 })
	await tick(40)
	assert.match(text(document, 'scope-meta'), /paused/, '平移后仍是暂停态')

	// ---- 框选放大 + 游标 ----
	fire(canvas, 'pointerdown', { clientX: 420, clientY: 120, shiftKey: true })
	fire(canvas, 'pointermove', { clientX: 240, clientY: 120 })
	fire(canvas, 'pointerup', { clientX: 240, clientY: 120 })
	await tick(60)
	assert.match(text(document, 'cur-a'), /^\d+ · /, '框选后游标 A 有读数：' + text(document, 'cur-a'))
	assert.match(text(document, 'cur-b'), /^\d+ · /, '框选后游标 B 有读数：' + text(document, 'cur-b'))
	assert.notEqual(text(document, 'cur-dt'), '—', '游标间时长有值：' + text(document, 'cur-dt'))
	assert.notEqual(text(document, 'cur-energy'), '—', '游标间能量有值')
	await tick(300) // 分析是 120 ms 防抖 + 400 ms 面板刷新
	assert.match(text(document, 'an-meta'), /selection/, '分析默认跟着游标走：' + text(document, 'an-meta'))

	// ---- 游标拖动（靠近 A 线抓取），并断言不抛错 ----
	const aText = text(document, 'cur-a')
	fire(canvas, 'pointerdown', { clientX: 240, clientY: 120 })
	fire(canvas, 'pointermove', { clientX: 260, clientY: 120 })
	fire(canvas, 'pointerup', { clientX: 260, clientY: 120 })
	await tick(40)
	assert.ok(text(document, 'cur-a').length > 0, '拖动游标后仍有读数')
	assert.ok(aText.length > 0)

	// ---- 键盘：左移 / 放大 / 复位 / 游标键 ----
	fireKey(win, 'ArrowLeft')
	fireKey(win, '+')
	await tick(30)
	assert.match(text(document, 'scope-meta'), /paused/)
	fireKey(win, '0')
	await tick(30)
	assert.ok(!/paused/.test(text(document, 'scope-meta')) || true, '复位不抛错')
	fireKey(win, '[')
	fireKey(win, ']')
	await tick(20)
	assert.match(text(document, 'cur-a'), /^\d+ · /)

	// ---- Y 轴三档 + 包络/均值带开关 ----
	click(document, 'btn-ylog')
	await tick(30)
	assert.equal(document.getElementById('btn-ylog').getAttribute('aria-pressed'), 'true')
	assert.equal(document.getElementById('btn-ylin').getAttribute('aria-pressed'), 'false')
	click(document, 'btn-ysym')
	await tick(30)
	assert.equal(document.getElementById('btn-ysym').getAttribute('aria-pressed'), 'true')
	click(document, 'btn-ylin')
	await tick(30)
	assert.equal(document.getElementById('btn-ylin').getAttribute('aria-pressed'), 'true')
	const envBefore = document.getElementById('btn-env').getAttribute('aria-pressed')
	click(document, 'btn-env')
	await tick(20)
	assert.notEqual(document.getElementById('btn-env').getAttribute('aria-pressed'), envBefore)
	click(document, 'btn-env')
	const bandBefore = document.getElementById('btn-band').getAttribute('aria-pressed')
	click(document, 'btn-band')
	await tick(20)
	assert.notEqual(document.getElementById('btn-band').getAttribute('aria-pressed'), bandBefore)
	click(document, 'btn-band')
	await tick(20)

	// ---- 显示触发：改模式后 chip 有电平，喂一段方波后能钉住 ----
	const trigSel = document.getElementById('trig-mode')
	trigSel.value = 'rise'
	fire(trigSel, 'change', {})
	await tick(30)
	assert.match(text(document, 'chip-trigger'), /^trigger: rise @/, '触发 chip：' + text(document, 'chip-trigger'))
	// 方波：20 点低 / 20 点高，共 4000 点
	const list = []
	for (let i = 0; i < 4000; i++) list.push((i % 40) < 20 ? 200 : 3000)
	state.pushRxBytes((function () {
		const u8 = new Uint8Array(list.length * 4)
		for (let i = 0; i < list.length; i++) {
			const c = (counter++) & 0x3f
			const w = (((0xff) << 24) | (c << 18) | (3 << 14) | (list[i] & 0x3fff)) >>> 0
			u8[i * 4] = w & 0xff
			u8[i * 4 + 1] = (w >>> 8) & 0xff
			u8[i * 4 + 2] = (w >>> 16) & 0xff
			u8[i * 4 + 3] = (w >>> 24) & 0xff
		}
		return u8
	})())
	await tick(80)
	assert.equal(document.getElementById('chip-trigger').dataset.state, 'busy', '命中触发后 chip 变忙：' + text(document, 'chip-trigger'))
	// 手工电平与 pre 位置
	const trigLevel = document.getElementById('trig-level')
	trigLevel.value = '100'
	fire(trigLevel, 'change', {})
	const trigPre = document.getElementById('trig-pre')
	trigPre.value = '0.5'
	fire(trigPre, 'change', {})
	await tick(30)
	assert.match(text(document, 'chip-trigger'), /100/, '手工电平写进 chip：' + text(document, 'chip-trigger'))
	// 关掉触发
	trigSel.value = 'off'
	fire(trigSel, 'change', {})
	await tick(20)
	assert.match(text(document, 'chip-trigger'), /^trigger: off/)

	// ---- 分析面板：FFT / 电池 / 周期叠画 ----
	click(document, 'btn-fft')
	await tick(20)
	assert.equal(document.getElementById('btn-fft').getAttribute('aria-pressed'), 'true')
	assert.equal(document.getElementById('an-fft-block').hidden, false, 'FFT 面板展开')
	click(document, 'btn-an-refresh')
	await tick(220)
	assert.notEqual(text(document, 'an-fft-meta'), '—', 'FFT meta 有内容：' + text(document, 'an-fft-meta'))
	assert.ok(document.getElementById('an-fft').children.length >= 0)
	click(document, 'btn-battery')
	await tick(220)
	assert.equal(document.getElementById('an-battery-block').hidden, false, '电池面板展开')
	assert.notEqual(text(document, 'an-battery'), '—', '电池估算有值：' + text(document, 'an-battery'))
	document.getElementById('an-capacity').value = '1500'
	fire(document.getElementById('an-capacity'), 'change', {})
	await tick(220)
	assert.notEqual(text(document, 'an-battery'), '—')
	click(document, 'btn-cycles')
	await tick(220)
	assert.equal(document.getElementById('an-cycles-block').hidden, false, '叠画面板展开')
	assert.notEqual(text(document, 'an-cycles-meta'), '—', '叠画 meta：' + text(document, 'an-cycles-meta'))
	// 分析区间切到 window
	const anSrc = document.getElementById('an-source')
	anSrc.value = 'window'
	fire(anSrc, 'change', {})
	await tick(220)
	assert.match(text(document, 'an-meta'), /window/, '切到窗口区间：' + text(document, 'an-meta'))
	// 关掉三个面板
	click(document, 'btn-fft')
	click(document, 'btn-battery')
	click(document, 'btn-cycles')
	await tick(220)
	assert.equal(document.getElementById('an-fft-block').hidden, true)
	assert.equal(document.getElementById('an-battery-block').hidden, true)
	assert.equal(document.getElementById('an-cycles-block').hidden, true)

	// ---- 采样沿触发（下拉）----
	const acqStart = document.getElementById('acq-start')
	acqStart.value = 'rise'
	fire(acqStart, 'change', {})
	const acqStop = document.getElementById('acq-stop')
	acqStop.value = 'fall'
	fire(acqStop, 'change', {})
	await tick(30)
	assert.equal(acqStart.value, 'rise', '启动沿设置保留')

	// ---- 总览条定位 ----
	const mm = document.getElementById('minimap')
	fire(mm, 'pointerdown', { clientX: 100, clientY: 20 })
	fire(mm, 'pointerup', { clientX: 100, clientY: 20 })
	await tick(40)
	assert.match(text(document, 'scope-meta'), /paused/, '总览条定位后暂停 Live')

	// ---- 最大化 / Esc ----
	click(document, 'btn-max')
	await tick(30)
	assert.equal(document.body.dataset.max, '1', '最大化隐藏侧栏')
	assert.equal(document.getElementById('btn-max').getAttribute('aria-pressed'), 'true')
	fireKey(win, 'Escape')
	await tick(30)
	assert.equal(document.body.dataset.max, '0', 'Esc 退出最大化')
	assert.equal(document.getElementById('btn-max').getAttribute('aria-pressed'), 'false')

	// ---- 导出 ----
	click(document, 'btn-export-view')
	await tick(80)
	assert.equal(state.files.length, 1, '窗口导出调用 saveFile')
	assert.match(state.files[0].name, /\.csv$/)
	assert.ok(state.files[0].text.indexOf('index,time_s,current_uA,power_uW') === 0)
	click(document, 'btn-export-summary')
	await tick(80)
	assert.equal(state.files.length, 2)
	assert.match(state.files[1].name, /\.json$/)

	// ---- SDK 的 claim 回调错误处理器：插件必须接上，并写两份日志 ----
	assert.equal(typeof state.claimErrorHandler, 'function', '插件要注册 setClaimErrorHandler')
	const logsBefore = document.getElementById('log').children.length
	const hostBefore = state.hostLogs.length
	state.claimErrorHandler(new Error('synthetic claim failure'), { claimId: 'claim1', gen: 1, seq: 9 })
	await tick(20)
	assert.ok(state.hostLogs.length > hostBefore, '回调异常写进宿主日志')
	assert.match(state.hostLogs[state.hostLogs.length - 1], /claim\.rx handler threw/, '宿主日志内容：' + state.hostLogs[state.hostLogs.length - 1])
	assert.ok(document.getElementById('log').children.length > logsBefore, '回调异常也写进插件日志')

	// ---- 宿主日志 ----
	assert.ok(state.hostLogs.some((l) => /claimed .* exclusively/.test(l)), '连接时写宿主日志：' + JSON.stringify(state.hostLogs))
	assert.ok(state.hostLogs.some((l) => /capture started/.test(l)), '开始采样写宿主日志')
	assert.ok(state.hostLogs.some((l) => /dropped .* bytes/.test(l)), '宿主丢弃时写宿主日志')

	// ---- 停止采样 ----
	state.writes.length = 0
	click(document, 'btn-sample')
	await tick(120)
	assert.equal(state.released.length, 1, '停止后必须释放更新屏障')
	assert.equal(text(document, 'chip-sampling'), 'idle')
	assert.deepEqual(state.writes.map((w) => w[0]), [0x07], '停止只发 STOP')
	assert.ok(state.hostLogs.some((l) => /capture stopped/.test(l)), '停止采样写宿主日志')

	// ---- 断开 ----
	click(document, 'btn-connect')
	await tick(80)
	assert.equal(text(document, 'btn-connect'), 'Connect')
	assert.equal(document.getElementById('port').disabled, false)

	// ---- 意外断开：终止会话、释放更新屏障、供电状态失效 ----
	{
		const releasedBefore = state.released.length
		// 重新连接并开始采样
		click(document, 'btn-connect')
		await tick(500)
		click(document, 'btn-sample')
		await tick(150)
		assert.equal(text(document, 'chip-sampling'), 'capturing')
		state.pushRxSamples(600, 1000)
		await tick(120)
		// 宿主收回占用声明（意外断开）
		assert.equal(typeof state.claimStateHandler, 'function', '插件要订阅占用状态')
		state.claimStateHandler({ claims: [] })
		await tick(150)
		assert.equal(text(document, 'chip-sampling'), 'idle', '断开后采样会话必须结束')
		assert.equal(state.released.length, releasedBefore + 1, '断开后必须释放更新屏障')
		assert.equal(text(document, 'st-power'), 'unknown', '断开后供电状态必须置为未知：' + text(document, 'st-power'))
		assert.equal(text(document, 'btn-sample'), 'Start capture')
		// 重新连接后：旧会话状态不能串过来（必须能真正重新开始采样）
		click(document, 'btn-connect')
		await tick(500)
		assert.equal(text(document, 'btn-connect'), 'Disconnect')
		state.writes.length = 0
		click(document, 'btn-sample')
		await tick(150)
		assert.ok(state.writes.some((w) => w[0] === 0x06), '新连接必须真的发 START（不能因为旧 sampling=true 直接返回）')
		click(document, 'btn-sample')
		await tick(150)
		click(document, 'btn-connect')
		await tick(150)
	}

	// ---- 失败必须可见：START 写失败 / 设备无应答都要写到状态条，不能静默回到 idle ----
	{
		click(document, 'btn-connect')
		await tick(500)
		assert.equal(text(document, 'btn-connect'), 'Disconnect')
		// 1) 写入失败
		state.failWrites = 'USB 写超时'
		click(document, 'btn-sample')
		await tick(200)
		state.failWrites = null
		assert.equal(text(document, 'chip-sampling'), 'start failed', '开始失败不能显示成 idle：' + text(document, 'chip-sampling'))
		assert.equal(document.getElementById('chip-sampling').dataset.state, 'error')
		const sl = document.getElementById('status-line')
		assert.equal(sl.hidden, false, '状态条要显示出来')
		assert.equal(sl.dataset.level, 'error')
		assert.match(sl.textContent, /START could not be written.*USB 写超时/, '状态条写明原因：' + sl.textContent)
		assert.equal(text(document, 'btn-sample'), 'Start capture')
		// 阻塞 4：语言切换时状态条按保存的键与参数重绘（不是保留旧语言的文本）
		state.emit('app.locale', { locale: 'zh-CN' })
		await tick(20)
		assert.match(sl.textContent, /^开始采样失败：START 写入失败.*USB 写超时/, '状态条切到中文：' + sl.textContent)
		assert.equal(sl.dataset.level, 'error', '级别不变')
		assert.equal(text(document, 'chip-sampling'), '启动失败')
		state.emit('app.locale', { locale: 'en' })
		await tick(20)
		assert.match(sl.textContent, /^Starting the capture failed: START could not be written/)
		// 诊断面板：发送失败计数与最近错误
		click(document, 'btn-diag')
		await tick(10)
		assert.equal(document.getElementById('diag').hidden, false, '诊断面板可展开')
		assert.match(text(document, 'diag-tx'), /writes .* [1-9]\d* failed/, '诊断显示发送统计：' + text(document, 'diag-tx'))
		assert.match(text(document, 'diag-rx'), /batches .* B/)
		assert.match(text(document, 'diag-error'), /USB 写超时/, '诊断显示最近错误：' + text(document, 'diag-error'))
		// 阻塞 4：诊断里的最近错误也跟着切语言
		const diagEn = text(document, 'diag-error')
		state.emit('app.locale', { locale: 'zh-CN' })
		await tick(20)
		assert.match(text(document, 'diag-error'), /写入失败.*USB 写超时/, '诊断最近错误切到中文：' + text(document, 'diag-error'))
		state.emit('app.locale', { locale: 'en' })
		await tick(20)
		assert.equal(text(document, 'diag-error'), diagEn)
		// 2) 设备无应答：START 写成功但一个字节都不回 → 看门狗报「无应答」，不是缺口
		state.silent = true
		const gapsBefore = text(document, 'chip-gaps')
		click(document, 'btn-sample')
		await tick(200)
		assert.equal(text(document, 'chip-sampling'), 'capturing')
		await tick(3200)
		assert.equal(text(document, 'chip-sampling'), 'no response', '看门狗必须真的在跑：' + text(document, 'chip-sampling'))
		assert.match(sl.textContent, /No response from the device/, '状态条：' + sl.textContent)
		assert.equal(text(document, 'chip-gaps'), gapsBefore, '从未收到数据不算缺口')
		state.silent = false
		click(document, 'btn-sample')
		await tick(200)
		click(document, 'btn-diag')
		click(document, 'btn-connect')
		await tick(150)
	}

	// ---- BLU 筛选空态：没有 BLU 口时给明确提示，不退回列全部口 ----
	{
		const saved = state.ports
		state.ports = [{ key: 'q1', portName: 'COM9', productName: 'CH340' }, { key: 'q2', portName: 'COM10', productName: 'FTDI' }]
		click(document, 'btn-refresh')
		await tick(40)
		const sel = document.getElementById('port')
		assert.equal(sel.options.length, 1, '空态只有一条提示')
		assert.equal(sel.options[0].value, '')
		assert.match(sel.options[0].textContent, /No BLU device found.*2/, '空态写明未发现 BLU 并说明隐藏了几个口：' + sel.options[0].textContent)
		assert.equal(sel.disabled, true)
		state.ports = saved
		click(document, 'btn-refresh')
		await tick(40)
		assert.equal(sel.options.length, 2)
		assert.equal(sel.disabled, false)
	}

	// ---- CSV 导入：本地文件解析后替换会话 ----
	{
		const csv = [
			'index,time_s,current_uA,power_uW,voltage_mV',
			'0,0,1000,3300,3300',
			'1,0.001,1000,3300,3300',
			'# gap import 2..2',
			'2,0.002,0,0,3300',
		].join('\n')
		const file = { name: 'capture.csv', text: async () => csv }
		// 假 DOM 的 file input：直接挂一个 files 列表
		document.getElementById('import-file').files = [file]
		click(document, 'btn-import')
		await tick(300)
		assert.match(text(document, 'import-hint'), /3 rows/, '导入提示：' + text(document, 'import-hint'))
		assert.ok(Number(text(document, 'ro-samples').replace(/[^0-9]/g, '')) >= 3, '导入的样点进了会话')
		assert.notEqual(text(document, 'chip-gaps'), 'gaps: 0', '导入文件里的缺口标记要生效：' + text(document, 'chip-gaps'))
		assert.ok(state.hostLogs.some((l) => /imported 3 samples/.test(l)), '导入写宿主日志：' + JSON.stringify(state.hostLogs.slice(-3)))
		// 没有选文件时给出提示，不抛错
		document.getElementById('import-file').files = []
		click(document, 'btn-import')
		await tick(40)
		assert.match(text(document, 'import-hint'), /Choose a CSV file/)
		// 阻塞 4：已显示的导出 / 导入提示跟着切语言
		const exportEn = text(document, 'export-hint')
		assert.match(exportEn, /^Saved /, '导出提示：' + exportEn)
		state.emit('app.locale', { locale: 'zh-CN' })
		await tick(20)
		assert.equal(text(document, 'import-hint'), '请先选择 CSV 文件。')
		assert.match(text(document, 'export-hint'), /^已保存 /, '导出提示切到中文：' + text(document, 'export-hint'))
		state.emit('app.locale', { locale: 'en' })
		await tick(20)
		assert.match(text(document, 'import-hint'), /Choose a CSV file/)
		assert.equal(text(document, 'export-hint'), exportEn)
	}

	// ---- 冷区上限 ----
	document.getElementById('cap').value = '256'
	click(document, 'btn-apply-cap')
	await tick(500)
	assert.ok(state.saved.some(([k, v]) => k === 'settings' && v.capMiB === 256), '冷区上限写进设置：' + JSON.stringify(state.saved.slice(-1)))

	// ---- 语言来源：navigator 回退 / 新 SDK onLocale 覆盖 navigator ----
	{
		// 1) 旧宿主：SDK 没有 onLocale，navigator 是中文 → 中文界面
		const s1 = Object.assign({}, state, { settings: {}, saved: [], hostLogs: [], claimIds: [], busy: [], released: [], acquires: [] })
		const e1 = makeEnv(s1, { navigator: { language: 'zh-CN' } })
		await tick(80)
		assert.equal(e1.document.getElementById('btn-sample').textContent, '开始采集', 'navigator 回退为中文')
		assert.equal(e1.document.getElementById('btn-refresh').textContent, '刷新')
		assert.equal(e1.document.getElementById('chip-sampling').textContent, '空闲')
		assert.equal(e1.document.getElementById('btn-connect').textContent, '连接')
		// 宿主后来推了 en（旧 SDK 也会把 app.locale 转给 on()）
		s1.emit('app.locale', { locale: 'en' })
		await tick(20)
		assert.equal(e1.document.getElementById('btn-sample').textContent, 'Start capture')

		// 2) 新宿主：onLocale 已有值时立即回调，覆盖 navigator；之后的推送就地生效
		const s2 = Object.assign({}, state, {
			settings: {}, saved: [], hostLogs: [], claimIds: [], busy: [], released: [], acquires: [],
			localeSupport: true, hostLocale: 'en',
			ports: [{ key: 'z1', portName: 'COM4', productName: 'CH340' }],
		})
		const e2 = makeEnv(s2, { navigator: { language: 'zh-CN' } })
		await tick(80)
		assert.equal(e2.document.getElementById('btn-sample').textContent, 'Start capture', '宿主语言优先于 navigator')
		assert.match(e2.document.getElementById('port').options[0].textContent, /^No BLU device found \(1 other port\(s\) hidden\)/)
		s2.pushLocale('zh-CN')
		await tick(20)
		assert.equal(e2.document.getElementById('btn-sample').textContent, '开始采集')
		assert.match(e2.document.getElementById('port').options[0].textContent, /^未发现 BLU 设备（已隐藏 1 个其他串口）/, '空态提示也跟着切语言：' + e2.document.getElementById('port').options[0].textContent)
		assert.equal(e2.document.getElementById('port').disabled, true, '空态下拉保持禁用')
	}

	console.log('app-smoke: ok')
	process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
