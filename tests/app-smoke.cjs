'use strict'
// 界面接线冒烟回归：用最小 DOM + 假宿主把 js/app.js 真跑一遍，
// 覆盖「列口 → 独占声明 → 打开 → 上电/电压 → 开始采样 → claim.rx 合批事件 → 缺口 → 停止 → 释放 busy」。
// 只验证接线与状态流转，不做像素断言（画布是 stub）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// ---------- 最小 DOM ----------
function makeCtx2d() {
	const noop = function () {}
	return {
		setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop,
		lineTo: noop, stroke: noop, fillText: noop, fill: noop, closePath: noop,
		set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
		set lineCap(v) {}, set font(v) {}, set textBaseline(v) {},
	}
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
		this._value = ''
		this._text = ''
		this.clientWidth = 640
		this.clientHeight = 280
		this.width = 0
		this.height = 0
		this.scrollTop = 0
		this.scrollHeight = 0
	}
	// <select> 的 value 跟着 selectedIndex 走（与浏览器一致），其它元素就是普通字符串
	get value() {
		if (this.tagName === 'SELECT') {
			const o = this.options[this.selectedIndex]
			return o ? o.value : ''
		}
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
		// 设定 textContent 会清空子节点（与浏览器一致）
		this.children.length = 0
	}
	get childNodes() { return this.children }
	get firstChild() { return this.children[0] || null }
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
	appendChildText(t) { return this.appendChild(new El('span')) && t }
	addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
	removeEventListener() {}
	setAttribute(k, v) { this.attrs[k] = String(v) }
	getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
	getContext() { return makeCtx2d() }
	click() { (this.listeners.click || []).forEach((fn) => fn({ detail: 1 })) }
	set innerHTML(v) { this._text = String(v); this.children.length = 0 }
	get innerHTML() { return this._text }
}

function makeDocument() {
	const byId = new Map()
	const doc = {
		readyState: 'complete',
		documentElement: new El('html'),
		getElementById(id) {
			if (!byId.has(id)) {
				const el = new El(id === 'port' || id === 'rate' || id === 'view' ? 'select' : 'div')
				el.id = id
				byId.set(id, el)
			}
			return byId.get(id)
		},
		createElement(tag) { return new El(tag) },
		createTextNode(t) { const e = new El('#text'); e._text = String(t); return e },
		addEventListener() {},
		body: new El('body'),
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
				// 设备行为：GET_META_DATA 回文本（直到 END），AVERAGE_START 开始推样点
				if (bytes[0] === 0x19) state.pushRxText('R0=1031.64\r\nVDD=3300 mV\r\nEND\r\n')
				if (bytes[0] === 0x06) state.pushRxSamples(300, 1)
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
	'js/power-protocol.js', 'js/power-lane.js', 'js/power-analysis.js',
	'js/power-store.js', 'js/power-wave.js', 'js/power-claim.js', 'js/power-control.js', 'js/power-export.js',
]

function makeEnv(state) {
	const document = makeDocument()
	const win = {
		document: document,
		devicePixelRatio: 2,
		addEventListener() {},
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
		rxOffset: 0,
		rxSeq: 0,
		gen: 1,
		ports: [
			{ key: 'p1', portName: 'COM7', productName: 'Power Monitor', serialNumber: 'SN-42' },
			{ key: 'p2', portName: 'COM8', productName: 'Other', busy: 'channel A' },
		],
		rxHandler: null,
		gapHandler: null,
	}
	// 宿主按 claim 合批：offset 是该 gen 字节流里的绝对偏移，seq 单调递增
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

	const { document } = makeEnv(state)
	await tick(60)

	// ---- 启动 ----
	assert.equal(document.getElementById('port').options.length, 2)
	assert.match(document.getElementById('port').options[0].textContent, /Power Monitor/)
	assert.match(document.getElementById('port').options[1].textContent, /busy: channel A/)
	assert.equal(text(document, 'chip-sampling'), 'idle')
	assert.equal(text(document, 'chip-theme'), 'theme: dark')
	assert.ok(document.getElementById('log').children.length >= 1, '启动日志')

	// ---- 连接：独占声明 → 打开 → 读设备参数 → 探测 DUT 供电 ----
	click(document, 'btn-connect')
	await tick(500) // metadata + 250 ms 供电探测
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
	await tick(450) // 设置防抖落盘
	assert.ok(state.saved.some(([k]) => k === 'settings'), '设置会落盘')

	// ---- 开始采样：先申请更新屏障，再 STOP 排空 → START ----
	state.writes.length = 0
	state.rxSeq = 0
	click(document, 'btn-sample')
	await tick(150)
	assert.equal(state.busy.length, 1, '采样期间持有更新屏障')
	assert.deepEqual(state.writes.map((w) => w[0]), [0x07, 0x06], '先 STOP 排空再 START')
	assert.equal(text(document, 'chip-sampling'), 'capturing')
	assert.equal(text(document, 'btn-sample'), 'Stop capture')

	// ---- 合批事件：一条含多帧、下一条接着上一批的 offset ----
	state.pushRxSamples(600, 1000)
	await tick(30)
	state.pushRxSamples(300, 1200)
	await tick(300) // 等读数刷新（400 ms 定时器 / rAF 循环）
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

	// ---- 导出：窗口导出成功 ----
	click(document, 'btn-export-view')
	await tick(80)
	assert.equal(state.files.length, 1, '窗口导出调用 saveFile')
	assert.match(state.files[0].name, /\.csv$/)
	assert.ok(state.files[0].text.indexOf('index,time_s,current_uA,power_uW') === 0)
	// 摘要导出
	click(document, 'btn-export-summary')
	await tick(80)
	assert.equal(state.files.length, 2)
	assert.match(state.files[1].name, /\.json$/)

	// ---- 停止采样：释放更新屏障 + 只发 STOP ----
	state.writes.length = 0
	click(document, 'btn-sample')
	await tick(120)
	assert.equal(state.released.length, 1, '停止后必须释放更新屏障')
	assert.equal(text(document, 'chip-sampling'), 'idle')
	assert.deepEqual(state.writes.map((w) => w[0]), [0x07], '停止只发 STOP')

	// ---- 断开：claim.close + claim.release ----
	click(document, 'btn-connect')
	await tick(80)
	assert.equal(text(document, 'btn-connect'), 'Connect')
	assert.equal(document.getElementById('port').disabled, false)

	// ---- 冷区上限：改设置并落盘 ----
	document.getElementById('cap').value = '256'
	click(document, 'btn-apply-cap')
	await tick(500)
	assert.ok(state.saved.some(([k, v]) => k === 'settings' && v.capMiB === 256), '冷区上限写进设置：' + JSON.stringify(state.saved.slice(-1)))

	console.log('app-smoke: ok')
	// 界面里还有 400 ms 的读数定时器与 rAF 循环：测试结束必须显式退出
	process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
