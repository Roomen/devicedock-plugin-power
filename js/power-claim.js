// 串口占用（claim）链路的插件侧封装：列口 → 独占声明 → 打开 → 写 → 收 claim.rx。
//
// 事件形状（宿主定稿）：
//   claim.rx  { claimId, gen, seq, offset, at, bytes: Uint8Array }
//     gen    该 claim 第几次 claim.open，换 gen = 新字节流（不是缺口）
//     seq    同一 gen 内从 1 单调递增
//     offset 本批首字节在该 gen 字节流中的绝对偏移（含已丢弃的字节）
//   缺口判据：offset ≠ 上批 offset + 上批 bytes.length
//   claim.gap { claimId, gen, offset, bytes, reason: 'overflow' | 'closing' }
//     宿主丢弃了字节（直发、保证送达），插件必须标缺口。
//
// 回调纪律（宿主 SDK 定稿后的实际行为）：
//  - SDK 对同一 claim 串行调用 claim.onRx：上一批回调（及其返回的 Promise）结束后才给下一批，
//    每批结束后按序 claim.ack（即发即忘的 post，没有回包、没有超时）。
//  - 回调抛错仍会 ack（视为已消费，避免把宿主卡在背压里），并交给 setClaimErrorHandler；
//    所以本文件的回调自己接住一切异常并标缺口，别指望宿主替我们兜住。
//  - 所以回调里只做「校验 offset/gen + 解码字节流 + 入队」这类线性廉价工作，样点入库（含画布/统计刷新）
//    排到回调外的异步批次里，且绝不在回调里 await 长任务。
//  - 队列有硬上限：真跟不上（例如冷存储归档卡住）时按「丢最老 + 标记缺口」处理，宁可报缺口也不撑爆内存，
//    更不能抛错让整批静默消失。
;(function (global) {
	'use strict'

	// 浏览器里由 <script> 顺序保证已加载；node 单测里按相对路径取同一份实现
	const PROTO = global.PowerProtocol || (typeof require === 'function' ? require('./power-protocol.js') : null)

	function toBytes(value) {
		if (!value) return new Uint8Array(0)
		if (value instanceof Uint8Array) return value
		if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		if (value instanceof ArrayBuffer) return new Uint8Array(value)
		if (typeof value === 'string') {
			// 宿主历史上可能给十六进制串：按字节解析，不是 UTF-8
			const hex = value.replace(/[^0-9a-f]/gi, '')
			const out = new Uint8Array(hex.length >> 1)
			for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
			return out
		}
		if (Array.isArray(value) || typeof value.length === 'number') return Uint8Array.from(value)
		return new Uint8Array(0)
	}

	/**
	 * @param {object} cfg
	 * @param {object} cfg.host SDK（或测试里的假宿主）：需有 device.listPorts / claim.* 与 on()
	 * @param {function} [cfg.onSamples] (samples, at, meta) 样点批次（samples 为 { iUA, range, logic }[]）
	 * @param {function} [cfg.onGap] (info) 数据缺口 { reason, at, gen, offset, bytes, ... }
	 * @param {function} [cfg.onState] (state) 连接态变化
	 * @param {function} [cfg.onLog] (message, level)
	 * @param {number} [cfg.baudRate]
	 * @param {function} [cfg.createParser] 返回 { push(bytes), reset(), remainder, lostSamples }
	 * @param {number} [cfg.maxPendingSamples] 待入库样点的硬上限（超过按缺口丢弃最老的）
	 * @param {number} [cfg.drainBudgetMs] 一次异步入库最多占用的时间（默认 6 ms，超时让出线程）
	 * @param {number} [cfg.drainChunkSamples] 一次交给上层的样点批次上限
	 * @param {function} [cfg.scheduleDrain] (fn) 排一个异步批次（默认 setTimeout 0）
	 * @param {function} [cfg.now] 单调时钟（默认 Date.now）
	 */
	function createClaimLink(cfg) {
		cfg = cfg || {}
		const host = cfg.host
		const onSamples = typeof cfg.onSamples === 'function' ? cfg.onSamples : function () {}
		const onGap = typeof cfg.onGap === 'function' ? cfg.onGap : function () {}
		// 返回 true 表示这段字节被上层消费掉（例如设备 metadata 文本），不再按样点解析
		const onBytes = typeof cfg.onBytes === 'function' ? cfg.onBytes : null
		const onState = typeof cfg.onState === 'function' ? cfg.onState : function () {}
		const onLog = typeof cfg.onLog === 'function' ? cfg.onLog : function () {}
		const baudRate = cfg.baudRate || 115200
		const createParser = typeof cfg.createParser === 'function'
			? cfg.createParser
			: function () { return new PROTO.SampleParser(new PROTO.Converter(PROTO.defaultModifiers())) }
		// 100 kHz 满速下 1 s ≈ 10 万样点；上限取 4 s，
		const MAX_PENDING = cfg.maxPendingSamples > 0 ? cfg.maxPendingSamples : 400000
		const DRAIN_BUDGET_MS = cfg.drainBudgetMs > 0 ? cfg.drainBudgetMs : 6
		const DRAIN_CHUNK = cfg.drainChunkSamples > 0 ? cfg.drainChunkSamples : 16384
		const now = typeof cfg.now === 'function' ? cfg.now : function () { return Date.now() }
		const scheduleDrain = typeof cfg.scheduleDrain === 'function'
			? cfg.scheduleDrain
			: function (fn) { return setTimeout(fn, 0) }

		let claimId = null
		// 未 open 时以收到的第一条 claim.rx 的 claimId 为准（真机上 open 之后才有数据）
		let boundClaimId = null
		let portKey = null
		let open = false
		let opening = false
		let gen = 0
		let parser = createParser()
		let dropStream = false
		let attached = false
		// 字节流偏移 / 代次（宿主侧的坐标系）
		let streamGen = 0
		let expectedOffset = 0
		let lastSeq = 0
		// 异步入库队列
		let pending = []
		let pendingCount = 0
		let drainTimer = 0
		const stats = {
			bytes: 0,
			samples: 0,
			events: 0,
			gaps: 0,
			gapBytes: 0,
			offsetGaps: 0,
			hostGaps: 0,
			genSwitches: 0,
			sampleLossGaps: 0,
			decodeErrors: 0,
			backlogDropped: 0,
			drainedBytes: 0,
			lastGap: null,
		}

		function emitState() {
			onState({ claimId: claimId, portKey: portKey, open: open, opening: opening, gen: gen })
		}

		function reportGap(info) {
			stats.gaps++
			stats.lastGap = info
			onGap(info)
		}

		function attach() {
			if (attached || !host || typeof host.on !== 'function') return
			attached = true
			const claim = host.claim || {}
			if (typeof claim.onRx === 'function') claim.onRx(handleRx)
			else host.on('claim.rx', handleRx)
			if (typeof claim.onGap === 'function') claim.onGap(handleGap)
			else host.on('claim.gap', handleGap)
			host.on('claim.state', handleClaimState)
		}

		function detach() {
			attached = false
		}

		// ---- 字节流状态：换 gen = 新流；offset 不连续 = 缺口 ----
		function resetStream(nextGen, offset) {
			streamGen = nextGen || 0
			expectedOffset = offset || 0
			lastSeq = 0
		}

		/** 缺口后保留已学到的相位判据（能在 1..3 字节偏移上重同步），只丢掉半帧残字节 */
		function breakStream() {
			if (!parser) return
			// 残字节属于缺口前那一段，不能拼进缺口后的数据
			if (parser.remainder) parser.remainder = new Uint8Array(0)
			// 错位 / 丢字节期间的样点污染了档位切换滤波的滑动均值
			if (parser.converter && typeof parser.converter.resetFilter === 'function') parser.converter.resetFilter()
		}

		function noteGap(info) {
			breakStream()
			reportGap(info)
		}

		// ---- 异步入库 ----
		function scheduleFlush() {
			if (drainTimer) return
			drainTimer = scheduleDrain(function () {
				drainTimer = 0
				drainStep()
			})
		}

		function drainStep() {
			const started = now()
			while (pending.length) {
				const job = pending[0]
				const rest = job.samples.length - job.from
				const take = Math.min(rest, DRAIN_CHUNK)
				const from = job.from
				const chunk = from === 0 && take === job.samples.length
					? job.samples
					: job.samples.slice(from, from + take)
				job.from += take
				pendingCount -= take
				if (job.from >= job.samples.length) pending.shift()
				// meta.from / meta.total 让上层能把「批末到达时刻」按样点回推成时间戳
				const meta = Object.assign({}, job.meta, { from: from, total: job.samples.length })
				try {
					onSamples(chunk, job.at, meta)
				} catch (e) {
					onLog('样点处理出错：' + (e && e.message ? e.message : e), 'error')
				}
				// 按时间预算让出线程：重活（画布/统计刷新）由上层自己排，这里只负责把队列喂进去
				if (pending.length && now() - started >= DRAIN_BUDGET_MS) break
			}
			if (pending.length) scheduleFlush()
		}

		/**
		 * 队列硬上限：真跟不上时丢最老的整批并标缺口。
		 * 丢的是还没进波形的样点，所以缺口位置就是当前波形末端。
		 */
		function trimPending() {
			if (pendingCount <= MAX_PENDING) return
			let droppedSamples = 0
			let droppedBytes = 0
			while (pending.length && pendingCount > MAX_PENDING) {
				const job = pending.shift()
				const rest = job.samples.length - job.from
				droppedSamples += rest
				pendingCount -= rest
				droppedBytes += (job.meta && job.meta.bytes) || 0
			}
			stats.backlogDropped += droppedSamples
			noteGap({ reason: 'plugin_backlog', at: now(), gen: streamGen, missedSamples: droppedSamples, bytes: droppedBytes })
		}

		// ---- claim.rx ----
		/**
		 * claim.rx 回调：只做「校验 offset/gen + 解码 + 入队」，不 await 长任务、不抛错。
		 * 返回值固定 undefined —— 宿主串行发送并按回调结束自动 ack。
		 */
		function handleRx(event) {
			if (!event || typeof event !== 'object') return undefined
			const mine = claimId ? String(claimId) : boundClaimId
			// 只认本 claim 的数据（别的 claim 的事件不该进来，但宁可挡一次）
			if (mine && event.claimId && String(event.claimId) !== mine) return undefined
			if (!boundClaimId && event.claimId) boundClaimId = String(event.claimId)
			const at = typeof event.at === 'number' ? event.at : Date.now()
			const evGen = typeof event.gen === 'number' ? event.gen : 0
			const seq = typeof event.seq === 'number' ? event.seq : 0
			const offset = typeof event.offset === 'number' ? event.offset : null
			const bytes = toBytes(event.bytes)

			if (evGen && evGen !== streamGen) {
				// 换 gen：这是新一次 open 的字节流，从它自己的 offset 重新算，不算缺口
				if (streamGen) stats.genSwitches++
				resetStream(evGen, offset == null ? 0 : offset)
				// 新流的第一批可能不是从 0 开始（宿主已丢过前段），按缺口记
				if (offset != null && offset > 0) {
					stats.offsetGaps++
					stats.gapBytes += offset
					noteGap({ reason: 'stream_start_offset', at: at, gen: evGen, offset: offset, bytes: offset })
				}
			} else if (offset != null) {
				if (offset !== expectedOffset) {
					const missing = offset - expectedOffset
					if (missing > 0) {
						stats.offsetGaps++
						stats.gapBytes += missing
						noteGap({ reason: 'offset_gap', at: at, gen: streamGen, expectedOffset: expectedOffset, offset: offset, bytes: missing })
					}
					// offset 反向（理论上不该发生）：同样按不连续处理
					else if (offset < expectedOffset) {
						stats.offsetGaps++
						noteGap({ reason: 'offset_rewind', at: at, gen: streamGen, expectedOffset: expectedOffset, offset: offset, bytes: 0 })
					}
				}
			}
			if (seq) lastSeq = seq
			stats.events++
			stats.bytes += bytes.length
			if (offset != null) expectedOffset = offset + bytes.length
			else if (bytes.length) expectedOffset += bytes.length

			if (!bytes.length) return undefined
			// 排空窗口（STOP 后的残包、START 前的旧数据）：字节照样计数，但不解析不入库。
			// offset 已经推进过，所以恢复接收不会把排空期误判成缺口。
			if (dropStream) {
				stats.drainedBytes += bytes.length
				return undefined
			}

			if (onBytes && onBytes(bytes, { gen: streamGen, seq: seq, offset: offset, at: at }) === true) return undefined
			const before = parser.lostSamples || 0
			let out
			try {
				out = parser.push(bytes)
			} catch (e) {
				// 回调抛错会被宿主当成「已消费」而吞掉，所以这里必须自己接住并标缺口
				stats.decodeErrors++
				onLog('样点解码失败：' + (e && e.message ? e.message : e), 'error')
				noteGap({ reason: 'decode_error', at: at, gen: streamGen })
				return undefined
			}
			const after = parser.lostSamples || 0
			if (after > before) {
				// 设备侧计数器跳变：相位没错，但确实丢了样点
				stats.sampleLossGaps++
				noteGap({ reason: 'sample_loss', at: at, gen: streamGen, missedSamples: after - before, bytes: 0 })
			}
			stats.samples += out.length
			if (!out.length) return undefined
			pending.push({ samples: out, at: at, meta: { gen: streamGen, seq: seq, offset: offset, bytes: bytes.length }, from: 0 })
			pendingCount += out.length
			// 硬上限兜底：绝不让队列无限长，也绝不因为跟不上就静默丢
			if (pendingCount > MAX_PENDING) trimPending()
			// 入库排到回调外面：回调要尽快返回（宿主串行发下一批 + 自动 ack）
			scheduleFlush()
			return undefined
		}

		// ---- claim.gap（宿主丢弃报告，保证送达）----
		function handleGap(event) {
			const e = event && typeof event === 'object' ? event : {}
			const id = e.claimId != null ? String(e.claimId) : ''
			const mine = claimId ? String(claimId) : boundClaimId
			if (id && mine && id !== mine) return { gap: false, ignored: true }
			const evGen = Number(e.gen) || 0
			if (evGen && streamGen && evGen !== streamGen) return { gap: false, stale: true }
			const bytes = Number(e.bytes) || 0
			stats.hostGaps++
			stats.gapBytes += bytes
			const at = now()
			// reason 原样透出（宿主目前是 'overflow' / 'closing'），未知值不要谎报成 overflow
			const reason = typeof e.reason === 'string' && e.reason ? e.reason : 'overflow'
			noteGap({ reason: reason, at: at, gen: evGen || streamGen, offset: Number(e.offset) || 0, bytes: bytes })
			return { gap: true, bytes: bytes }
		}

		function handleClaimState(event) {
			const claims = event && Array.isArray(event.claims) ? event.claims : null
			if (!claims || !claimId) return
			const rec = claims.find(function (c) { return String(c.claimId) === String(claimId) })
			// 占用声明被宿主收走（停用 / 手动释放）：本地状态跟着关，别继续以为能写
			if (!rec) {
				if (open || opening) {
					open = false
					opening = false
					gen++
					emitState()
					onLog('占用声明已被释放，串口按已关闭处理', 'warn')
				}
				return
			}
			const nextOpen = !!rec.open
			if (nextOpen !== open) {
				open = nextOpen
				if (!nextOpen) gen++
				emitState()
			}
		}

		// ---- 声明 / 打开 / 关闭 ----
		async function listPorts() {
			if (!host || !host.device || typeof host.device.listPorts !== 'function') return []
			const ports = await host.device.listPorts()
			return Array.isArray(ports) ? ports : []
		}

		async function openOn(key) {
			if (!host || !host.claim) throw new Error('宿主没有提供串口占用能力')
			if (open || opening) await close()
			opening = true
			emitState()
			const res = await host.claim.acquire(String(key), 'exclusive')
			const id = res && res.claimId
			if (!id) {
				opening = false
				emitState()
				throw new Error('宿主未返回占用声明')
			}
			claimId = id
			portKey = String(key)
			try {
				await host.claim.open(claimId, { baudRate: baudRate })
			} catch (e) {
				opening = false
				const failedId = claimId
				claimId = null
				portKey = null
				emitState()
				try { await host.claim.release(failedId) } catch (e2) { /* 忽略 */ }
				throw e
			}
			opening = false
			open = true
			gen++
			resetStream(0, 0)
			parser = createParser()
			dropStream = false
			emitState()
			return { ok: true, claimId: claimId }
		}

		async function close() {
			const id = claimId
			open = false
			opening = false
			claimId = null
			boundClaimId = null
			portKey = null
			resetStream(0, 0)
			gen++
			emitState()
			if (!id || !host || !host.claim) return { ok: true }
			let closeErr = null
			try {
				await host.claim.close(id)
			} catch (e) {
				closeErr = e
			}
			try {
				await host.claim.release(id)
			} catch (e) {
				if (!closeErr) closeErr = e
			}
			// 关闭失败要如实抛出：占用与更新屏障都保留，交给宿主重试
			if (closeErr) throw closeErr
			return { ok: true }
		}

		/** 绑定发起时的连接代次：中途关闭 / 换设备的结果不算到新连接头上 */
		async function write(bytes, note) {
			const myGen = gen
			const myId = claimId
			if (!open || !myId) {
				if (note) onLog('写入失败（未打开）：' + note, 'error')
				return { ok: false, stale: false }
			}
			const data = toBytes(bytes)
			try {
				await host.claim.write(myId, data)
			} catch (e) {
				onLog('写入错误' + (note ? '（' + note + '）' : '') + '：' + (e && e.message ? e.message : e), 'error')
				return { ok: false, stale: false, error: e }
			}
			if (!open || gen !== myGen || claimId !== myId) {
				if (note) onLog('写入完成时连接已变化：' + note, 'warn')
				return { ok: false, stale: true }
			}
			return { ok: true, stale: false }
		}

		function noteExternalGap(reason, info) {
			stats.hostGaps++
			noteGap(Object.assign({ reason: reason, at: Date.now(), gen: streamGen }, info || {}))
		}

		return {
			attach: attach,
			detach: detach,
			listPorts: listPorts,
			open: openOn,
			close: close,
			write: write,
			handleRx: handleRx,
			handleGap: handleGap,
			handleDropped: handleGap, // 兼容旧名
			handleClaimState: handleClaimState,
			noteExternalGap: noteExternalGap,
			isOpen: function () { return open },
			isOpening: function () { return opening },
			gen: function () { return gen },
			streamGen: function () { return streamGen },
			claimId: function () { return claimId },
			portKey: function () { return portKey },
			// 排空窗口：STOP 后的残包与 START 前的旧数据都不许进波形。
			// 离开排空窗口时重新播种设备侧样点计数器：这段是我们主动丢的，不能报成设备丢点。
			setDrop: function (on) {
				const next = !!on
				if (dropStream && !next && parser && 'lastCounter' in parser) parser.lastCounter = -1
				dropStream = next
			},
			isDropping: function () { return dropStream },
			resetParser: function (resetStats) {
				if (parser && typeof parser.reset === 'function') parser.reset()
				if (resetStats && parser && typeof parser.resetStats === 'function') parser.resetStats()
			},
			setParser: function (p) { parser = p || createParser() },
			getParser: function () { return parser },
			setConverterModifiers: function (mod) {
				if (parser && parser.converter && typeof parser.converter.setModifiers === 'function') parser.converter.setModifiers(mod)
			},
			residualBytes: function () {
				return parser && parser.remainder ? parser.remainder.length : 0
			},
			// 待处理样点（异步入库队列）与排空等待：测试与界面用
			pendingSamples: function () { return pendingCount },
			/** 把队列里的样点立刻交出去（测试 / 界面在停止采样收尾时用） */
			flush: function () {
				drainStep()
				return pendingCount
			},
			stats: function () { return Object.assign({}, stats) },
			resetStats: function () {
				Object.keys(stats).forEach(function (k) {
					if (typeof stats[k] === 'number') stats[k] = 0
				})
			},
		}
	}

	const api = { createClaimLink: createClaimLink, toBytes: toBytes }
	global.PowerClaim = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
