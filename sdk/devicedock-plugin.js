// DeviceDock 插件端 SDK（运行在 sandbox="allow-scripts" 的插件 iframe 内，也可在 node 单测中加载）。
// 与宿主页面不同源，所有能力调用走 window.parent.postMessage({ __devicedock: 1, id, method, params }, '*')；
// 宿主在收到 load 后立即推送 ready（含初始 { theme, tokens }），主题切换时推送 theme-change / theme。
;(function (root) {
	'use strict'

	const PROTOCOL = 1
	const DEFAULT_TIMEOUT_MS = 15000

	function createSdk(env) {
		const win = env || root
		const doc = win && win.document ? win.document : null
		const pending = new Map()
		const listeners = new Map()
		let seq = 0
		let currentTheme = { theme: 'light', tokens: {} }
		let readyInfo = null
		const readyWaiters = []

		function emitLocal(name, payload) {
			const set = listeners.get(name)
			if (!set) return
			Array.from(set).forEach(function (fn) {
				try { fn(payload) } catch (e) {}
			})
		}

		function applyTheme(payload, targetDoc) {
			const d = targetDoc || doc
			if (!payload || typeof payload !== 'object') return currentTheme
			const mode = payload.theme === 'dark' ? 'dark' : 'light'
			const tokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : currentTheme.tokens
			currentTheme = { theme: mode, tokens: Object.assign({}, tokens) }
			if (d && d.documentElement) {
				d.documentElement.setAttribute('data-theme', mode)
				if (d.documentElement.style && typeof d.documentElement.style.setProperty === 'function') {
					Object.keys(currentTheme.tokens).forEach(function (k) {
						if (k.indexOf('--') === 0) d.documentElement.style.setProperty(k, String(currentTheme.tokens[k]))
					})
				}
			}
			return currentTheme
		}

		function onMessage(ev) {
			const msg = ev && ev.data
			if (!msg || typeof msg !== 'object' || msg.__devicedock !== PROTOCOL) return
			if (typeof msg.id === 'string' && pending.has(msg.id)) {
				const job = pending.get(msg.id)
				pending.delete(msg.id)
				clearTimeout(job.timer)
				if (msg.error) {
					const err = new Error(msg.error.message || '宿主调用失败')
					err.code = msg.error.code || 'internal'
					job.reject(err)
				} else {
					job.resolve(msg.result)
				}
				return
			}
			if (typeof msg.event === 'string') {
				const p = msg.payload
				if (msg.event === 'ready') {
					if (p && (p.theme || p.tokens)) applyTheme(p)
					readyInfo = p || {}
					while (readyWaiters.length) readyWaiters.shift()(readyInfo)
					emitLocal('ready', readyInfo)
					emitLocal('theme', currentTheme)
					emitLocal('theme-change', currentTheme)
					return
				}
				if (msg.event === 'theme' || msg.event === 'theme-change') {
					applyTheme(p)
					emitLocal('theme', currentTheme)
					emitLocal('theme-change', currentTheme)
					return
				}
				emitLocal(msg.event, p)
			}
		}

		if (win && typeof win.addEventListener === 'function') {
			win.addEventListener('message', onMessage)
		}

		function postToHost(envelope) {
			const target = win && win.parent && win.parent !== win ? win.parent : (win && win.__DEVICEDOCK_HOST_TARGET__)
			if (!target || typeof target.postMessage !== 'function') {
				throw new Error('未连接到 DeviceDock 插件宿主')
			}
			target.postMessage(envelope, '*')
		}

		// 即发即忘：不登记 pending Promise、不起超时定时器。宿主快速路径不回包，
		// 用 call 会留下一个永远等不到响应的 Promise 与定时器。
		function post(method, params) {
			try {
				postToHost({ __devicedock: PROTOCOL, id: 'post-' + (++seq), method: String(method), params: params || {} })
			} catch (e) {}
		}

		function call(method, params, opts) {
			const timeoutMs = (opts && Number(opts.timeoutMs)) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
			return new Promise(function (resolve, reject) {
				const id = 'req-' + (++seq)
				const timer = setTimeout(function () {
					if (!pending.has(id)) return
					pending.delete(id)
					const err = new Error('调用宿主超时：' + method)
					err.code = 'timeout'
					reject(err)
				}, timeoutMs)
				pending.set(id, { resolve: resolve, reject: reject, timer: timer })
				try {
					postToHost({ __devicedock: PROTOCOL, id: id, method: String(method), params: params || {} })
				} catch (e) {
					clearTimeout(timer)
					pending.delete(id)
					reject(e)
				}
			})
		}

		function on(event, fn) {
			if (typeof fn !== 'function') return function () {}
			const name = String(event || '')
			let set = listeners.get(name)
			if (!set) {
				set = new Set()
				listeners.set(name, set)
			}
			set.add(fn)
			return function () { set.delete(fn) }
		}

		// claim.rx 的 bytes 是 Uint8Array（合批事件，一条可能含多帧）；统一成 Uint8Array 视图，
		// 兼容老式数组 payload 与跨文档 structured clone 传进来的 typed array。
		function bytesView(v) {
			if (v instanceof Uint8Array) return v
			if (v && v.buffer && typeof v.byteLength === 'number' && typeof v.length === 'number') {
				return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength)
			}
			if (Array.isArray(v)) return Uint8Array.from(v)
			return new Uint8Array(0)
		}
		// 合批事件：bytes 为 Uint8Array，gen / seq / offset 用于判断缺口
		// （offset !== 上一批 offset + 上一批长度 即有缺口，缺口通知见 claim.gap）。
		//
		// 同一 claim 的批次**串行**交给回调：上一批回调（含它返回的 Promise）结束后才调用下一批，
		// 每批结束后按序 ack 该批 seq——保证累积确认只覆盖已完成的连续批次，宿主不会提前放行。
		// 回调抛错（或 Promise 拒绝）：仍 ack 该批（视为已消费，避免把宿主卡死在背压里），
		// 同时调用可选的 onError 处理器；没有就 console.error。
		const claimQueues = new Map()
		let claimErrorHandler = null
		function reportClaimError(err, info) {
			if (typeof claimErrorHandler === 'function') {
				try { claimErrorHandler(err, info); return } catch (e) {}
			}
			if (typeof console !== 'undefined' && console.error) console.error('claim.rx handler failed', err)
		}
		function enqueueClaim(claimId, job) {
			const prev = claimQueues.get(claimId) || Promise.resolve()
			const next = prev.then(job).catch(function () {})
			claimQueues.set(claimId, next)
			next.then(function () { if (claimQueues.get(claimId) === next) claimQueues.delete(claimId) })
			return next
		}
		function onClaimRx(fn) {
			if (typeof fn !== 'function') return function () {}
			return on('claim.rx', function (pkt) {
				const p = pkt && typeof pkt === 'object' ? pkt : {}
				const item = { claimId: p.claimId, gen: p.gen || 0, at: p.at || 0, seq: p.seq || 0, offset: p.offset || 0, bytes: bytesView(p.bytes) }
				if (!item.claimId) return
				enqueueClaim(String(item.claimId), function () {
					const ack = function () {
						if (!item.seq) return
						post('claim.ack', { claimId: item.claimId, gen: item.gen, seq: item.seq })
					}
					let out
					try {
						out = fn(item)
					} catch (e) {
						reportClaimError(e, { claimId: item.claimId, gen: item.gen, seq: item.seq })
						ack()
						return
					}
					if (out && typeof out.then === 'function') {
						return out.then(ack, function (e) {
							reportClaimError(e, { claimId: item.claimId, gen: item.gen, seq: item.seq })
							ack()
						})
					}
					ack()
				})
			})
		}
		// 回调失败时的处理器（可选）；不设就 console.error
		function setClaimErrorHandler(fn) { claimErrorHandler = typeof fn === 'function' ? fn : null }
		// 测试用：等某个 claim 的队列排空
		function claimQueueDone(claimId) { return claimQueues.get(String(claimId)) || Promise.resolve() }

		// 缺口通知（overflow / closing）：offset 是被丢字节的起点，插件据此知道样本缺了哪些
		function onClaimGap(fn) {
			if (typeof fn !== 'function') return function () {}
			return on('claim.gap', function (p) {
				const g = p && typeof p === 'object' ? p : {}
				fn({ claimId: g.claimId, gen: g.gen || 0, offset: g.offset || 0, bytes: g.bytes || 0, reason: g.reason || '' })
			})
		}

		function ready() {
			if (readyInfo) return Promise.resolve(readyInfo)
			return new Promise(function (resolve) { readyWaiters.push(resolve) })
		}

		return {
			PROTOCOL: PROTOCOL,
			call: call,
			on: on,
			ready: ready,
			applyTheme: applyTheme,
			getTheme: function () { return Object.assign({}, currentTheme, { tokens: Object.assign({}, currentTheme.tokens) }) },
			// 测试注入入口
			_handleMessage: onMessage,
			post: post,
			_pendingCount: function () { return pending.size },
			setClaimErrorHandler: setClaimErrorHandler,
			_claimQueueDone: claimQueueDone,
			bytesView: bytesView,
			device: {
				listPorts: function () { return call('device.listPorts', {}) },
				listBle: function () { return call('device.listBle', {}) },
				listClassic: function () { return call('device.listClassic', {}) },
				bleScan: function (start) { return call('device.bleScan', { start: start !== false }) },
				lanes: function () { return call('device.lanes', {}) },
			},
			serial: {
				write: function (lane, bytes) { return call('serial.write', { lane: lane, bytes: bytes }) },
				onRx: function (fn) { return on('serial.rx', fn) },
				onTx: function (fn) { return on('serial.tx', fn) },
			},
			claim: {
				acquire: function (portKey, mode) { return call('claim.acquire', { portKey: portKey, mode: mode || 'exclusive' }) },
				release: function (claimId) { return call('claim.release', { claimId: claimId }) },
				list: function () { return call('claim.list', {}) },
				open: function (claimId, opts) { return call('claim.open', Object.assign({ claimId: claimId }, opts || {})) },
				close: function (claimId) { return call('claim.close', { claimId: claimId }) },
				write: function (claimId, bytes) { return call('claim.write', { claimId: claimId, bytes: bytes }) },
				onRx: onClaimRx,
				onGap: onClaimGap,
				// 即发即忘（宿主不回包）：返回 undefined
				ack: function (claimId, gen, seq) { post('claim.ack', { claimId: claimId, gen: gen, seq: seq }) },
			},
			protocol: {
				info: function (lane) { return call('protocol.info', { lane: lane }) },
				call: function (lane, fn, args) { return call('protocol.call', { lane: lane, fn: fn, args: args || [] }) },
				onFrame: function (fn) { return on('protocol.frame', fn) },
			},
			log: {
				write: function (text) { return call('log.write', { text: text }) },
				recent: function (count) { return call('log.recent', { count: count || 50 }) },
				export: function () { return call('log.export', {}) },
			},
			app: {
				theme: function () { return call('app.theme', {}) },
				platform: function () { return call('app.platform', {}) },
				busyAcquire: function (label) { return call('app.busyAcquire', { label: label }) },
				busyRelease: function (busyId) { return call('app.busyRelease', { busyId: busyId }) },
				storageGet: function (key) { return call('app.storageGet', { key: key }).then(function (r) { return r ? r.value : null }) },
				storageSet: function (key, value) { return call('app.storageSet', { key: key, value: value }) },
				storageRemove: function (key) { return call('app.storageRemove', { key: key }) },
				saveFile: function (opts) { return call('app.saveFile', opts || {}) },
				dialog: function (opts) { return call('app.dialog', opts || {}) },
				notify: function (text, kind) { return call('app.notify', { text: text, kind: kind }) },
			},
		}
	}

	const instance = createSdk(root)
	instance.createSdk = createSdk
	root.DeviceDockPlugin = instance
	if (typeof module !== 'undefined' && module.exports) module.exports = instance
})(typeof window !== 'undefined' ? window : globalThis)
