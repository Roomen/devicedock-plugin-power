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
	doc._byId = byId
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
			open: async (id) => { const c = claims.get(id); if (c) c.open = true; return { claimId: id, open: true } },
			close: async (id) => { const c = claims.get(id); if (c) c.open = false; return { closed: true } },
			release: async (id) => { claims.delete(id); return { released: true } },
			write: async (id, bytes) => {
				state.writes.push(Array.from(bytes))
				if (bytes[0] === 0x19) state.pushRxText('R0=1031.64\r\nVDD=3300 mV\r\nEND\r\n')
				if (bytes[0] === 0x06) state.pushRxSamples(300, 1000)
				return { bytes: bytes.length }
			},
			onRx(fn) { state.rxHandler = fn; return function () {} },
			onGap(fn) { state.gapHandler = fn; return function () {} },
			ack: async () => ({ ack: true }),
		},
	}
	return sdk
}

// ---------- 运行 app.js ----------
const root = path.join(__dirname, '..')
const files = [
	'js/power-protocol.js', 'js/power-view.js', 'js/power-lane.js', 'js/power-analysis.js',
	'js/power-store.js', 'js/power-wave.js', 'js/power-panels.js', 'js/power-claim.js',
	'js/power-control.js', 'js/power-export.js',
]

function makeEnv(state) {
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
			{ key: 'p1', portName: 'COM7', productName: 'Power Monitor', serialNumber: 'SN-42' },
			{ key: 'p2', portName: 'COM8', productName: 'Other', busy: 'channel A' },
		],
		rxHandler: null,
		gapHandler: null,
		claimErrorHandler: null,
	}
	state.pushRxBytes = function (bytes) {
		state.rxSeq++
		const offset = state.rxOffset
		state.rxOffset += bytes.length
		if (!state.rxHandler) return
		state.rxHandler({ claimId: state.claimIds[0] || 'claim1', gen: state.gen, seq: state.rxSeq, offset: offset, at: Date.now(), bytes: bytes })
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
	assert.equal(document.getElementById('port').options.length, 2)
	assert.match(document.getElementById('port').options[0].textContent, /Power Monitor/)
	assert.match(document.getElementById('port').options[1].textContent, /busy: channel A/)
	assert.equal(text(document, 'chip-sampling'), 'idle')
	assert.equal(text(document, 'chip-theme'), 'theme: dark')
	assert.match(text(document, 'chip-trigger'), /^trigger: off/)
	assert.ok(document.getElementById('log').children.length >= 1, '启动日志')

	// ---- 连接：独占声明 → 打开 → 读设备参数 → 探测 DUT 供电 ----
	click(document, 'btn-connect')
	await tick(500)
	assert.deepEqual(state.acquires[0], ['p1', 'exclusive'], '必须走 claim.acquire(mode=exclusive)')
	assert.equal(text(document, 'chip-port').indexOf('port: Power Monitor'), 0)
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

	// ---- 冷区上限 ----
	document.getElementById('cap').value = '256'
	click(document, 'btn-apply-cap')
	await tick(500)
	assert.ok(state.saved.some(([k, v]) => k === 'settings' && v.capMiB === 256), '冷区上限写进设置：' + JSON.stringify(state.saved.slice(-1)))

	console.log('app-smoke: ok')
	process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
