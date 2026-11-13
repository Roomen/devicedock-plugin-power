// 功耗仪控制：电源 / 电压 / 采样启停 / 摘要，串一条队列。
// 全部经占用的串口（claim）写字节，不碰 navigator.serial，也不碰宿主的 S/A/B 路。
// 这些不变量都有回归测试兜底：
//  - 电压写失败绝不上电；写失败把供电标成 unknown（协议没有回读，不能瞎猜）。
//  - 写入完成后连接已变化（重连 / 换设备）的结果不算到新连接头上，也不改新连接的供电状态。
//  - STOP 排空残包 → 再 START；存储初始化等 await 之后要重新确认取消 / 断开 / 换设备。
//  - 摘要按模式取样点数与能量口径（长期模式不拿当前电压凑能量）。
//  - 数据有缺口时，能量不跨缺口累加。
;(function (global) {
	'use strict'

	const PROTO = global.PowerProtocol || (typeof require === 'function' ? require('./power-protocol.js') : null)
	const VIEW = global.PowerView || (typeof require === 'function' ? require('./power-view.js') : null)
	const I18N = global.PowerI18n || (typeof require === 'function' ? require('./power-i18n.js') : null)
	const tr = I18N.t
	const msg = I18N.msg

	const DEFAULTS = {
		rxDrainMs: 50,
		warmupSec: 0.1,
		warmupMaxSamples: 1000,
		probeMs: 250,
		dutOnThresholdUA: 0.5,
		maxQueueDepth: 8,
	}

	function emptyStats() {
		return { n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0, chargeUC: 0, chargeUAh: 0, energyUWh: 0, dur: 0, gaps: 0 }
	}

	/**
	 * @param {object} cfg
	 * @param {object} cfg.link power-claim 链路（isOpen/gen/write/setDrop/resetParser/write）
	 * @param {object} [cfg.wave] power-wave 波形会话
	 * @param {object} [cfg.store] 冷存储（init）
	 * @param {function} [cfg.log]
	 * @param {function} [cfg.onChange] 状态变化（界面刷新）
	 * @param {function} [cfg.onSampleStored] (sampleIndex, tMs) 时间锚点
	 * @param {object} [cfg.clock] { setTimeout, clearTimeout, now }
	 * @param {object} [cfg.settings] { recordMode, targetRateHz, voltageMv }
	 */
	function createControl(cfg) {
		cfg = cfg || {}
		const link = cfg.link
		const wave = cfg.wave || null
		const store = cfg.store || null
		const log = typeof cfg.log === 'function' ? cfg.log : function () {}
		const onChange = typeof cfg.onChange === 'function' ? cfg.onChange : function () {}
		const onSampleStored = typeof cfg.onSampleStored === 'function' ? cfg.onSampleStored : function () {}
		const clock = cfg.clock || {
			setTimeout: function (fn, ms) { return setTimeout(fn, ms) },
			clearTimeout: function (t) { clearTimeout(t) },
			now: function () { return Date.now() },
		}
		const opts = Object.assign({}, DEFAULTS, cfg.options || {})

		const settings = cfg.settings || {}
		let recordMode = settings.recordMode === 'long' ? 'long' : 'wave'
		let targetRateHz = Number(settings.targetRateHz) > 0 ? Number(settings.targetRateHz) : 1000
		let voltageMv = Number(settings.voltageMv) > 0 ? Math.round(Number(settings.voltageMv)) : null
		let samplePeriodSec = targetRateHz > 0 ? 1 / targetRateHz : 0
		let deviceStreamHz = 0

		let power = { on: null, source: 'unknown' }
		let sampling = false
		let voltageChanges = 0
		let modifiers = PROTO.defaultModifiers()
		let modifiersOk = false
		let rateAdj = new PROTO.RateAdjuster(targetRateHz, PROTO.NOMINAL_BASE_HZ)
		// 设备实际推送速率（实测）与主机重采样后的输出速率
		let rawStreamCount = 0
		let rawStreamFirstMs = 0
		let peakRateHz = 0
		let ignoredSamples = 0
		// 采样沿触发（start / stop）与它需要的触发电平
		let acq = VIEW ? VIEW.createAcqTrigger() : null
		let trigLevelUA = null
		let stopScheduled = false
		// 缺口计数（长跑模式没有波形环，摘要里也得有数）
		let gapCount = 0
		// 长期模式的折叠总览（minimap）：长跑时不进波形环，只留 min/max 总览
		const folding = new PROTO.FoldingBuffer(10000)
		let warmupLeft = 0
		let acqStoreEnabled = true
		let firstStoredMs = 0
		let sessionT0Ms = 0
		let lastTMs = 0
		// t=0 是合法时间戳：用显式布尔判断「有没有上一个样点」，不要靠真假值
		let lastTMsValid = false
		let gapPending = false
		let metaCollecting = false
		let metaBuf = ''
		let probe = null
		let opChain = Promise.resolve()
		let opDepth = 0
		// energyUAs: Σ i·dt（µA·s = µC）；energyUWs: Σ i·V(t)·dt（µW·s），电压按摄入时刻记，属历史口径
		const longStats = { n: 0, sumI: 0, minI: Infinity, maxI: -Infinity, energyUAs: 0, energyUWs: 0, durSec: 0, gaps: 0, t0: 0, tLast: 0 }

		// ---- 串行队列：界面操作排队，后台（failFast）不排在界面操作后面 ----
		function runOp(fn, o) {
			o = o || {}
			if (o.failFast && opDepth > 0) {
				return Promise.resolve({ ok: false, code: 'power_busy', message: tr('ctl.busy_running'), ref: msg('ctl.busy_running') })
			}
			if (opDepth >= opts.maxQueueDepth) {
				return Promise.resolve({ ok: false, code: 'power_busy', message: tr('ctl.busy_queue'), ref: msg('ctl.busy_queue') })
			}
			opDepth++
			const run = opChain.then(fn, fn)
			opChain = run.then(function () {}, function () {}).then(function () { opDepth-- })
			return run
		}

		function guardStart(guard) {
			if (!guard || typeof guard.start !== 'function') return Promise.resolve(null)
			return Promise.resolve(guard.start()).then(function (e) { return e || null })
		}
		function guardStep(guard) {
			if (!guard || typeof guard.step !== 'function') return null
			return guard.step() || null
		}

		function powerPayload() {
			return { state: power.on === true ? 'on' : (power.on === false ? 'off' : 'unknown'), source: power.source }
		}

		function markPowered(on, source) {
			const known = on === true || on === false
			power = { on: known ? on : null, source: known ? (source || 'unknown') : 'unknown' }
			onChange()
			return powerPayload()
		}

		function toggleVoltageSource(v) {
			voltageMv = v
			onChange()
		}

		function readVoltageMv() {
			return voltageMv
		}

		function isConnected() {
			return !!(link && link.isOpen())
		}

		function genOf() {
			return link && typeof link.gen === 'function' ? link.gen() : 0
		}

		function stillSameConn(gen) {
			return isConnected() && genOf() === gen
		}

		function setRecordMode(mode) {
			recordMode = mode === 'long' ? 'long' : 'wave'
			onChange()
		}
		function setTargetRateHz(hz) {
			const h = Number(hz) > 0 ? Math.round(Number(hz)) : 1000
			targetRateHz = Math.max(1, Math.min(PROTO.NOMINAL_BASE_HZ, h))
			if (!(samplePeriodSec > 0) || !sampling) samplePeriodSec = 1 / targetRateHz
			onChange()
		}
		function setSamplePeriodSec(s) {
			if (isFinite(s) && s > 0) samplePeriodSec = s
		}
		function getSamplePeriodSec() {
			return samplePeriodSec > 0 ? samplePeriodSec : (targetRateHz > 0 ? 1 / targetRateHz : 0)
		}

		function resetLongStats() {
			longStats.n = 0
			longStats.sumI = 0
			longStats.minI = Infinity
			longStats.maxI = -Infinity
			longStats.energyUAs = 0
			longStats.energyUWs = 0
			longStats.durSec = 0
			longStats.gaps = 0
			longStats.t0 = 0
			longStats.tLast = 0
		}

		// ---- 缺口：时间轴断开，能量不许跨缺口积分 ----
		//
		// 缺口是**有序**到达的（power-claim 把断点排进同一个队列），所以这里看到它时，
		// 断点之前的样点已经全部入库。必须同时把「跨样点累积」的状态全部清掉：
		//  - 主机重采样累加器：否则缺口两侧的电流会被平均进同一个输出点；
		//  - 采样沿触发的滞回状态与等待期 pre-range；
		//  - 上一个样点的时间戳：下一段第一个点重新起算，dt 不跨缺口。
		function noteGap(info) {
			const idx = wave && typeof wave.total === 'function' ? wave.total() : 0
			if (wave && typeof wave.noteGap === 'function') wave.noteGap(idx)
			gapPending = true
			gapCount++
			if (recordMode === 'long') longStats.gaps++
			rateAdj.reset()
			if (acq) {
				acq.startState = 0
				acq.stopState = 0
				if (!acq.storeEnabled) {
					acq.preMin = Infinity
					acq.preMax = -Infinity
				}
			}
			lastTMs = 0
			lastTMsValid = false
			onChange()
			return { at: idx, info: info || null }
		}

		// ---- 样点入库 ----
		/**
		 * 原始字节流解出的样点批次入口：测量设备速率 → 主机重采样 → 入库。
		 * 设备满速 100 kHz，目标 1 kHz 时不能把 100 倍的数据全存下来。
		 * @param {Array} list [{ iUA, range, logic }]
		 * @param {number} at 批末到达时间（ms）
		 * @param {object} meta { from, total } 本批在整批里的偏移与总数
		 */
		function pushSamples(list, at, meta) {
			if (!list || !list.length) return 0
			const total = meta && meta.total > 0 ? meta.total : list.length
			const from = meta && typeof meta.from === 'number' ? meta.from : 0
			// DUT 供电探测期间：样点只进探测缓冲，绝不碰主波形（否则波形开头会多出一段探测数据）
			if (probe) {
				for (let i = 0; i < list.length; i++) probe.vals.push(list[i].iUA)
				return 0
			}
			// 未采样时段（探测结束后到 START 之间、STOP 后的残包）：字节已消费但不入库
			if (!sampling) {
				ignoredSamples += list.length
				return 0
			}
			// 设备速率实测：第一批只记起点（它属于起点时刻），之后累计样点数除以经过时间
			if (!rawStreamFirstMs) rawStreamFirstMs = at
			else rawStreamCount += list.length
			const elapsed = at - rawStreamFirstMs
			if (elapsed >= 100) {
				const measured = Math.round((rawStreamCount / elapsed) * 1000)
				if (measured > 0 && Math.abs(measured - deviceStreamHz) > Math.max(50, deviceStreamHz * 0.02)) {
					deviceStreamHz = measured
					rateAdj.setBaseRateHz(measured)
					// 输出周期按重采样后的实际速率算，统计的时长才有意义
					const outHz = rateAdj.appliedRateHz()
					if (outHz > 0) samplePeriodSec = 1 / outHz
				}
			}
			const baseHz = deviceStreamHz > 0 ? deviceStreamHz : PROTO.NOMINAL_BASE_HZ
			const stepMs = 1000 / baseHz
			let stored = 0
			for (let i = 0; i < list.length; i++) {
				const s = list[i]
				// 批末对齐到达时刻，批内等间隔回推
				const t = at - (total - 1 - (from + i)) * stepMs
				const outs = rateAdj.push(s.iUA, t)
				for (let k = 0; k < outs.length; k++) {
					const ua = outs[k].iUA
					// 采样沿触发：等启动沿期间只累计 pre-range，命中后才开闸入库
					if (acq && !acq.storeEnabled) {
						if (feedAcq(ua, 'start')) {
							acq.storeEnabled = true
							acq.startLatched = true
							log(msg('ctl.acq_start_hit'), 'success')
						}
						continue
					}
					if (ingest(outs[k].tMs, ua, s)) stored++
					// 停沿：入库之后生效，STOP 排到回调外异步发
					if (acq && acq.stop !== 'off' && acq.storeEnabled && feedAcq(ua, 'stop')) {
						requestStop(msg('ctl.acq_stop_hit'))
						break
					}
				}
			}
			return stored
		}

		/** 触发电平：用户设了就用它，否则用最近窗口 min/max 中点（Auto） */
		function trigLevel() {
			if (trigLevelUA != null && isFinite(trigLevelUA)) return trigLevelUA
			if (!wave) return 0
			const total = wave.total()
			if (total < 8) return 0
			const win = Math.min(total, 4000)
			const st = wave.stats(total - win, total)
			return (st.minI + st.maxI) * 0.5
		}

		function feedAcq(ua, kind) {
			if (!acq || !VIEW) return false
			return VIEW.feedAcqEdge(acq, { iUA: ua, kind: kind, thr: trigLevel() })
		}

		/** 停采排到回调之外：绝不能在这条入库路径里 await */
		function requestStop(reason) {
			if (stopScheduled) return
			stopScheduled = true
			log(reason, 'warn')
			clock.setTimeout(function () {
				stopScheduled = false
				if (!sampling) return
				// stopSampling 内部只发一条 STOP，失败会自己记日志
				stopSampling().catch(function (e) {
					log(msg('ctl.stop_failed', { err: (e && e.message ? e.message : e) }), 'error')
				})
			}, 0)
		}

		function ingest(tMs, iUA, info) {
			if (!isFinite(iUA)) return false
			if (!firstStoredMs) {
				firstStoredMs = tMs
				sessionT0Ms = tMs
			}
			const tSec = (tMs - sessionT0Ms) / 1000
			const prev = lastTMs
			// 缺口之后的第一个样点没有「上一个」：dt = 0，时间轴在这里断开
			const hasPrev = lastTMsValid && !gapPending
			const dt = hasPrev ? Math.max(0, (tMs - prev) / 1000) : 0
			gapPending = false
			lastTMs = tMs
			lastTMsValid = true

			if (recordMode === 'long') {
				if (!longStats.t0) longStats.t0 = tSec
				longStats.tLast = tSec
				longStats.n++
				longStats.sumI += iUA
				if (iUA < longStats.minI) longStats.minI = iUA
				if (iUA > longStats.maxI) longStats.maxI = iUA
				longStats.energyUAs += iUA * dt
				longStats.energyUWs += iUA * (voltageMv != null ? voltageMv / 1000 : 0) * dt
				// 时长只累计**有效**的段内间隔：缺口处 dt = 0，不能算进时长
				longStats.durSec += dt
				// 长期模式不进波形环，但仍然维护一条折叠总览（min/max 分桶），供 minimap 用
				folding.addData(iUA, tSec)
				return true
			}
			if (!wave) return false
			if (!wave.push(iUA)) return false
			// 时间锚点这类界面钩子抛错不能打断入库
			try {
				onSampleStored(wave.total() - 1, tMs)
			} catch (e) {
				log(msg('ctl.anchor_failed', { err: (e && e.message ? e.message : e) }), 'warn')
			}
			return true
		}

		// ---- 写 ----
		function errText(w) {
			const e = w && w.error
			if (!e) return ''
			return msg('ctl.err_detail', { msg: (e.message ? e.message : String(e)) + (e.code ? ' [' + e.code + ']' : '') })
		}

		function writeRaw(bytes, note) {
			if (!link || typeof link.write !== 'function') return Promise.resolve({ ok: false, stale: false })
			return link.write(bytes, note)
		}

		/**
		 * 写源电压。已连接时只有设备写入成功才算「已施加」：失败保持上一次有效值，
		 * 不把请求值当成事实。
		 */
		async function applyVoltageMv(mv, guard) {
			if (mv == null || !isFinite(mv)) {
				log(msg('ctl.voltage_required'), 'error')
				return { ok: false, stale: false }
			}
			const clamped = Math.max(PROTO.VDD_LOW_MV, Math.min(PROTO.VDD_HIGH_MV, Math.round(mv)))
			if (!isConnected()) {
				toggleVoltageSource(clamped)
				log(msg('ctl.voltage_pending', { mv: clamped }))
				return { ok: false, stale: false }
			}
			if (guardStep(guard)) return { ok: false, stale: false }
			const w = await writeRaw(PROTO.cmdRegulatorSet(clamped), 'REGULATOR ' + clamped + ' mV')
			if (!w.ok) {
				if (!w.stale) log(msg('ctl.voltage_write_failed_log'), 'error')
				onChange()
				return { ok: false, stale: !!w.stale }
			}
			if (voltageMv !== clamped && sampling) voltageChanges++
			toggleVoltageSource(clamped)
			log(msg('ctl.voltage_set', { mv: clamped }), 'success')
			return { ok: true, stale: false }
		}

		async function doPowerOn(guard) {
			if (!isConnected()) return { ok: false, code: 'power_not_connected', message: tr('ctl.not_connected'), ref: msg('ctl.not_connected') }
			const mv = readVoltageMv()
			if (mv == null || !isFinite(mv) || mv < PROTO.VDD_LOW_MV) {
				log(msg('ctl.voltage_required_open'), 'error')
				return { ok: false, code: 'voltage_unknown', message: tr('ctl.voltage_unknown'), ref: msg('ctl.voltage_unknown') }
			}
			const gen = genOf()
			const v = await applyVoltageMv(mv, guard)
			if (!v.ok) {
				if (v.stale) return { ok: false, code: 'disconnected', message: tr('ctl.power_on_conn_changed_voltage'), ref: msg('ctl.power_on_conn_changed_voltage'), executed: 'unknown', powered: powerPayload() }
				log(msg('ctl.power_on_aborted'), 'error')
				return { ok: false, code: 'voltage_write_failed', message: tr('ctl.power_on_voltage_failed'), ref: msg('ctl.power_on_voltage_failed'), voltageMv: voltageMv, powered: powerPayload() }
			}
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: tr('ctl.power_on_cancelled'), ref: msg('ctl.power_on_cancelled'), executed: false, powered: powerPayload() }
			if (!stillSameConn(gen)) {
				return { ok: false, code: 'disconnected', message: tr('ctl.power_on_device_changed'), ref: msg('ctl.power_on_device_changed'), executed: false, powered: powerPayload() }
			}
			const w = await writeRaw(PROTO.cmdDutPower(true), tr('ctl.note_power_on'))
			if (!w.ok) {
				// 连接已经变了：这次结果不属于新连接，不能改它的供电状态
				if (w.stale) return { ok: false, code: 'disconnected', message: tr('ctl.power_on_conn_changed'), ref: msg('ctl.power_on_conn_changed'), executed: 'unknown', powered: powerPayload() }
				// 同一连接写失败：不知道设备收没收到，标未知
				markPowered(null, 'unknown')
				log(msg('ctl.power_on_write_failed_log'), 'error')
				return { ok: false, code: 'power_write_failed', message: tr('ctl.power_on_write_failed'), ref: msg('ctl.power_on_write_failed'), executed: 'unknown', powered: powerPayload() }
			}
			markPowered(true, 'commanded')
			log(msg('ctl.power_on_done'), 'success')
			return { ok: true, changed: true, powered: powerPayload(), voltageMv: voltageMv }
		}

		async function doPowerOff(guard) {
			if (!isConnected()) return { ok: false, code: 'power_not_connected', message: tr('ctl.not_connected'), ref: msg('ctl.not_connected') }
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: tr('ctl.cancelled_nothing_done'), ref: msg('ctl.cancelled_nothing_done'), executed: false, powered: powerPayload() }
			const gen = genOf()
			const w = await writeRaw(PROTO.cmdDutPower(false), tr('ctl.note_power_off'))
			if (!w.ok) {
				if (w.stale) return { ok: false, code: 'disconnected', message: tr('ctl.power_off_conn_changed'), ref: msg('ctl.power_off_conn_changed'), executed: 'unknown', powered: powerPayload() }
				markPowered(null, 'unknown')
				log(msg('ctl.power_off_write_failed_log'), 'error')
				return { ok: false, code: 'power_write_failed', message: tr('ctl.power_off_write_failed'), ref: msg('ctl.power_off_write_failed'), executed: 'unknown', powered: powerPayload() }
			}
			markPowered(false, 'commanded')
			log(msg('ctl.power_off_done'))
			return { ok: true, changed: true, powered: powerPayload() }
		}

		// ---- 设备 metadata（0x19：文本直到 END）----
		function appendMetadataText(text) {
			if (!metaCollecting || !text) return
			metaBuf += text
		}

		async function fetchModifiers() {
			metaCollecting = true
			metaBuf = ''
			const mw = await writeRaw(PROTO.cmdMeta(), 'GET_META_DATA')
			if (!mw || !mw.ok) {
				// 请求都没写出去就不用干等 3 s：直接按默认参数走，并把原因写清楚
				metaCollecting = false
				metaBuf = ''
				modifiers = PROTO.defaultModifiers()
				modifiersOk = false
				log(msg('ctl.meta_write_failed', { err: errText(mw) }), 'error')
				onChange()
				return false
			}
			const deadline = clock.now() + 3000
			let text = metaBuf
			while (clock.now() < deadline) {
				if (text && text.indexOf('END') >= 0) break
				await new Promise(function (r) { clock.setTimeout(r, 50) })
				text = metaBuf
			}
			metaCollecting = false
			if (text && text.indexOf('END') >= 0) {
				modifiers = PROTO.parseMetadata(text)
				modifiersOk = true
				metaBuf = ''
				if (link && typeof link.setConverterModifiers === 'function') link.setConverterModifiers(modifiers)
				const saved = modifiers.savedVddMv || 0
				log(msg('ctl.meta_done', { details:
					(modifiers.deviceSn ? ' · SN ' + modifiers.deviceSn : '') +
					(saved ? ' · VDD ' + saved + ' mV' : '') +
					(modifiers.Calibrated != null ? ' · Calibrated=' + modifiers.Calibrated : '') }), 'success')
				if (saved >= PROTO.VDD_LOW_MV && saved <= PROTO.VDD_HIGH_MV) toggleVoltageSource(Math.round(saved))
				else {
					log(msg('ctl.meta_no_vdd'), 'warn')
					toggleVoltageSource(null)
				}
				return true
			}
			// 设备内置默认 R 表；读失败仍可用默认修正，不阻断
			modifiers = PROTO.defaultModifiers()
			modifiersOk = false
			metaBuf = ''
			log(msg('ctl.meta_timeout'), 'warn')
			onChange()
			return false
		}

		// ---- 采样 ----
		function clearSessionState() {
			if (wave) wave.reset()
			firstStoredMs = 0
			sessionT0Ms = 0
			lastTMs = 0
			lastTMsValid = false
			gapPending = false
			gapCount = 0
			resetLongStats()
			folding.reset()
			voltageChanges = 0
			deviceStreamHz = 0
			rawStreamCount = 0
			rawStreamFirstMs = 0
			peakRateHz = 0
			ignoredSamples = 0
		}

		async function drainSampleRx(ms) {
			link.setDrop(true)
			link.resetParser(false)
			const wait = Math.max(0, ms == null ? opts.rxDrainMs : ms)
			if (wait > 0) await new Promise(function (r) { clock.setTimeout(r, wait) })
			link.resetParser(false)
		}

		async function startSampling(guard) {
			if (!isConnected()) return { ok: false, code: 'power_not_connected', message: tr('ctl.not_connected'), ref: msg('ctl.not_connected') }
			if (sampling) return { ok: true, changed: false, sampling: true }
			const mv = readVoltageMv()
			if (!isFinite(mv) || mv == null || mv < PROTO.VDD_LOW_MV) {
				log(msg('ctl.voltage_required_start'), 'error')
				return { ok: false, code: 'voltage_unknown', message: tr('ctl.voltage_unknown'), ref: msg('ctl.voltage_unknown') }
			}
			// 先 STOP → 排空残留 → 再 START
			link.setDrop(true)
			const gen0 = genOf()
			const preStop = await writeRaw(PROTO.cmdAverageStop(), 'AVERAGE_STOP')
			if (!preStop || !preStop.ok) {
				// 写不进 STOP 就不能保证设备处于已停止态，也说明这条链路现在写不通：中止启动并说明原因，
				// 不能继续 START 让后面的「采样已开始」把这条失败盖掉
				if (preStop && preStop.stale) {
					return { ok: false, code: 'disconnected', message: tr('ctl.start_device_changed'), ref: msg('ctl.start_device_changed'), executed: false }
				}
				log(msg('ctl.prestop_failed_log', { err: errText(preStop) }), 'error')
				return { ok: false, code: 'capture_prestop_failed', message: tr('ctl.prestop_failed', { err: errText(preStop) }), ref: msg('ctl.prestop_failed', { err: errText(preStop) }), executed: false }
			}
			await drainSampleRx(opts.rxDrainMs)
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: tr('ctl.start_cancelled'), ref: msg('ctl.start_cancelled'), executed: false }
			if (!stillSameConn(gen0)) {
				return { ok: false, code: 'disconnected', message: tr('ctl.start_device_changed'), ref: msg('ctl.start_device_changed'), executed: false }
			}

			const baseHz = deviceStreamHz > 1000 ? deviceStreamHz : PROTO.NOMINAL_BASE_HZ
			clearSessionState()
			// 先按标称速率起步，实测会在 pushSamples 里修正
			deviceStreamHz = baseHz
			if (recordMode === 'wave' && store) {
				try {
					await store.init()
				} catch (e) {
					log(msg('ctl.store_init_failed', { err: (e && e.message ? e.message : e) }), 'warn')
				}
			}
			// 存储初始化等 await 之后重新确认：取消 / 断开 / 换设备都不能继续
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: tr('ctl.start_cancelled'), ref: msg('ctl.start_cancelled'), executed: false }
			if (!stillSameConn(gen0)) {
				return { ok: false, code: 'disconnected', message: tr('ctl.start_device_changed'), ref: msg('ctl.start_device_changed'), executed: false }
			}

			link.resetParser(true)
			if (link.setConverterModifiers) link.setConverterModifiers(modifiers)
			rateAdj = new PROTO.RateAdjuster(targetRateHz, baseHz)
			samplePeriodSec = targetRateHz > 0 ? 1 / targetRateHz : samplePeriodSec
			warmupLeft = Math.max(0, Math.min(opts.warmupMaxSamples, Math.round(targetRateHz * opts.warmupSec)))
			metaCollecting = false
			metaBuf = ''
			acqStoreEnabled = true
			// 采样沿触发：Arm 后先 START 设备，等沿再入库
			if (acq) {
				acq.startState = 0
				acq.stopState = 0
				acq.startLatched = acq.start === 'off'
				acq.storeEnabled = acq.start === 'off'
				acq.preMin = Infinity
				acq.preMax = -Infinity
				if (acq.start !== 'off') log(msg('ctl.acq_armed', { edge: tr('ui.edge_' + acq.start), level: trigLevelUA != null ? trigLevelUA.toFixed(2) + ' µA' : tr('ctl.level_auto') }))
			}
			stopScheduled = false
			sampling = true
			onChange()

			const startW = await writeRaw(PROTO.cmdAverageStart(), 'AVERAGE_START')
			if (!startW.ok) {
				if (startW.stale) {
					return { ok: false, code: 'disconnected', message: tr('ctl.start_conn_changed'), ref: msg('ctl.start_conn_changed'), executed: 'unknown' }
				}
				sampling = false
				link.setDrop(true)
				log(msg('ctl.start_write_failed_log', { err: errText(startW) }), 'error')
				onChange()
				return { ok: false, code: 'capture_start_failed', message: tr('ctl.start_write_failed', { err: errText(startW) }), ref: msg('ctl.start_write_failed', { err: errText(startW) }) }
			}
			// START 已下发后再接收样点（此前 drop 挡住 STOP 尾包与竞态）
			link.setDrop(false)
			const warmMs = targetRateHz > 0 ? Math.round(warmupLeft / targetRateHz * 1000) : 0
			log(msg('ctl.started', {
				hz: targetRateHz, mode: tr(recordMode === 'long' ? 'ctl.mode_long' : 'ctl.mode_wave'),
				ms: warmMs, n: warmupLeft, mods: modifiersOk ? '' : tr('ctl.default_mods'),
			}), 'success')
			return { ok: true, changed: true, sampling: true }
		}

		async function stopSampling(guard) {
			if (!sampling) return { ok: true, changed: false, sampling: false }
			const gen0 = genOf()
			// 1) 先停止接收新数据（排空窗口挡住 STOP 之后的尾包与竞态）
			link.setDrop(true)
			acqStoreEnabled = true
			// 2) 把**截止点之前已经收到**的样点排空入库，再冻结统计。
			//    不能直接 sampling=false：队列里剩下的样点会被当成「未采样」丢掉，而且没有任何记录。
			let flushed = { drained: 0, remaining: 0, remainingBytes: 0 }
			if (link && typeof link.flushQueue === 'function') {
				flushed = link.flushQueue(250)
			}
			if (flushed.remaining > 0) {
				// 确实排不完的（例如冷存储卡住）：计数 + 标缺口，绝不静默丢
				noteGap({ reason: 'stop_drain', missedSamples: flushed.remaining, bytes: flushed.remainingBytes })
				log(msg('ctl.stop_undrained', { n: flushed.remaining }), 'warn')
			}
			sampling = false
			onChange()
			let stopW = { ok: true, stale: false }
			try {
				stopW = await writeRaw(PROTO.cmdAverageStop(), 'AVERAGE_STOP')
			} catch (e) {
				stopW = { ok: false, stale: false }
			}
			link.resetParser(false)
			const stopped = !!(wave && wave.storageStop && wave.storageStop())
			log(msg(stopped ? 'ctl.stopped_storage' : 'ctl.stopped'))
			if (!stopW.ok) log(msg('ctl.stop_write_failed_log'), 'warn')
			onChange()
			if (stopW.ok) return { ok: true, changed: true, sampling: false }
			if (stopW.stale) return { ok: false, code: 'disconnected', message: tr('ctl.stop_conn_changed'), ref: msg('ctl.stop_conn_changed'), executed: 'unknown', sampling: false }
			return { ok: false, code: 'stop_write_failed', message: tr('ctl.stop_write_failed'), ref: msg('ctl.stop_write_failed'), sampling: false }
		}

		// ---- 对外（界面 / 测试）----
		function setPower(on, guard) {
			const want = !!on
			return runOp(async function () {
				const g = await guardStart(guard)
				if (g) return g
				if (!isConnected()) return { ok: false, code: 'power_not_connected', message: tr('ctl.not_connected'), ref: msg('ctl.not_connected') }
				const gen = genOf()
				// 只有「上次命令」的状态才能跳过；实测 / 未知都不足以代替一次显式命令
				if (power.source === 'commanded' && power.on === want) {
					return { ok: true, changed: false, powered: powerPayload() }
				}
				const r = want ? await doPowerOn(guard) : await doPowerOff(guard)
				if (!stillSameConn(gen) && r && r.ok) {
					return { ok: false, code: 'disconnected', message: tr('ctl.op_disconnected'), ref: msg('ctl.op_disconnected'), executed: 'unknown', powered: powerPayload() }
				}
				return r
			}, { failFast: !!guard })
		}

		function setVoltage(millivolts, guard) {
			const requested = Math.round(Number(millivolts))
			return runOp(async function () {
				const g = await guardStart(guard)
				if (g) return g
				if (!isConnected()) {
					if (isFinite(requested) && requested >= PROTO.VDD_LOW_MV && requested <= PROTO.VDD_HIGH_MV) {
						toggleVoltageSource(requested)
						return { ok: true, pending: true, requestedMv: requested }
					}
					return { ok: false, code: 'power_not_connected', message: tr('ctl.not_connected'), ref: msg('ctl.not_connected') }
				}
				if (!isFinite(requested) || requested < PROTO.VDD_LOW_MV || requested > PROTO.VDD_HIGH_MV) {
					return { ok: false, code: 'out_of_range', message: tr('ctl.out_of_range', { lo: PROTO.VDD_LOW_MV, hi: PROTO.VDD_HIGH_MV }), ref: msg('ctl.out_of_range', { lo: PROTO.VDD_LOW_MV, hi: PROTO.VDD_HIGH_MV }) }
				}
				const gen = genOf()
				const applied = await applyVoltageMv(requested, guard)
				if (!stillSameConn(gen) || applied.stale) {
					return { ok: false, code: 'disconnected', message: tr('ctl.op_disconnected'), ref: msg('ctl.op_disconnected'), executed: 'unknown' }
				}
				if (!applied.ok) return { ok: false, code: 'voltage_write_failed', message: tr('ctl.voltage_not_applied'), ref: msg('ctl.voltage_not_applied'), voltageMv: voltageMv, requestedMv: requested }
				return { ok: true, requestedMv: requested, appliedMv: voltageMv, clamped: voltageMv !== requested }
			}, { failFast: !!guard })
		}

		function startCapture(guard) {
			return runOp(async function () {
				const g = await guardStart(guard)
				if (g) return g
				const r = await startSampling(guard)
				return r
			}, { failFast: !!guard })
		}

		function stopCapture(guard) {
			return runOp(async function () {
				const g = await guardStart(guard)
				if (g) return g
				return await stopSampling(guard)
			}, { failFast: !!guard })
		}

		function togglePower() {
			if (!isConnected()) return Promise.resolve({ ok: false, code: 'power_not_connected', message: tr('ctl.not_connected'), ref: msg('ctl.not_connected') })
			return setPower(power.on !== true)
		}

		/** DUT 是否带电：协议没有回读命令，只能短采一段看中位数 */
		async function probeDutPower() {
			if (!isConnected() || sampling || metaCollecting) return null
			probe = { vals: [] }
			link.setDrop(false)
			link.resetParser(false)
			let pw = null
			try {
				pw = await writeRaw(PROTO.cmdAverageStart(), tr('ctl.note_probe_start'))
				if (!pw || !pw.ok) {
					probe = null
					log(msg('ctl.probe_write_failed', { err: errText(pw) }), 'error')
					return null
				}
				await new Promise(function (r) { clock.setTimeout(r, opts.probeMs) })
			} catch (e) {
				probe = null
				log(msg('ctl.probe_error', { err: (e && e.message ? e.message : e) }), 'error')
				return null
			}
			try { await writeRaw(PROTO.cmdAverageStop(), tr('ctl.note_probe_stop')) } catch (e) { /* 忽略 */ }
			const vals = probe ? probe.vals.slice() : []
			probe = null
			if (vals.length < 200) {
				log(msg('ctl.probe_empty', { ms: opts.probeMs, n: vals.length }), 'warn')
				return null
			}
			vals.sort(function (a, b) { return a - b })
			const med = vals[vals.length >> 1]
			return { on: med >= opts.dutOnThresholdUA, medianUA: med, n: vals.length }
		}

		function ingestProbe(iUA) {
			if (probe) probe.vals.push(iUA)
		}

		function overallStats() {
			if (recordMode === 'long') {
				const n = longStats.n
				// 时长是累加的「有效间隔」，缺口那段不进来
				const dur = longStats.durSec
				const avgI = n ? longStats.sumI / n : 0
				const avgP = dur > 0 ? longStats.energyUWs / dur : 0
				return {
					n: n,
					avgI: avgI,
					avgP: avgP,
					minI: isFinite(longStats.minI) ? longStats.minI : 0,
					maxI: isFinite(longStats.maxI) ? longStats.maxI : 0,
					dur: dur,
					chargeUC: longStats.energyUAs,
					chargeUAh: longStats.energyUAs / 3600,
					// 能量按摄入时刻的电压积分（历史口径），等价于 Σ P·dt
					energyUWh: longStats.energyUWs / 3600,
					volts: longStats.energyUAs > 0 ? longStats.energyUWs / longStats.energyUAs : (voltageMv != null ? voltageMv / 1000 : 0),
					segments: longStats.gaps + 1,
					gaps: longStats.gaps,
					dropped: 0,
				}
			}
			if (!wave) return emptyStats()
			// 全局下标范围：淘汰最早块之后不能用「保留数量」当结束下标
			return wave.stats(0, wave.total())
		}

		/** 摘要：单位、口径与数据来源都写清楚 */
		function captureSummary() {
			const st = overallStats()
			const total = recordMode === 'long' ? longStats.n : (wave ? wave.total() : 0)
			// 保留量 = 总点数 - 已淘汰点数（保留量是**数量**，不能当全局结束下标用）
			const retained = recordMode === 'long' ? longStats.n : (wave ? wave.retained() : 0)
			const sampleHz = targetRateHz > 0 ? targetRateHz : deviceStreamHz
			const period = getSamplePeriodSec()
			const evicted = recordMode !== 'long' && retained < total
			const out = {
				ready: total > 0,
				sampling: !!sampling,
				mode: recordMode,
				totalSamples: total,
				retainedSamples: retained,
				// 波形模式超出预算后旧样点被淘汰 / 缺口，统计只覆盖仍保留且连续的样点
				span: evicted ? 'retained' : 'full_session',
				durationSec: st.dur,
				gaps: recordMode === 'long' ? longStats.gaps : (st.gaps || 0),
				droppedSamples: recordMode === 'long' ? 0 : (wave && typeof wave.droppedSamples === 'function' ? wave.droppedSamples() : 0),
				volts: st.volts || 0,
				sampleRateHz: sampleHz,
				samplePeriodSec: period,
				voltageMvNow: voltageMv,
				voltageChangedDuringCapture: voltageChanges > 0,
				currentUA: { avg: st.avgI, min: st.minI, max: st.maxI },
				chargeUC: st.chargeUC,
				chargeUAh: st.chargeUAh,
				// 波形模式有块级功率累加；长期模式只积分电流，不拿当前电压去凑能量
				energyUWh: recordMode === 'long' ? null : (st.n ? st.energyUWh : null),
				energySource: recordMode === 'long' ? 'unavailable' : 'stored_chunk_sums',
				storageStop: !!(wave && wave.storageStop && wave.storageStop()),
				powered: powerPayload(),
			}
			if (!out.ready) out.reason = isConnected() ? 'no_samples' : 'power_not_connected'
			return out
		}

		/**
		 * 连接已失效（意外关闭 / 宿主收回声明 / 停用）时终止会话。
		 * sampling、看门狗、busy 由调用方（界面）一起收尾；这里负责设备侧的会话状态：
		 *  - 采样立刻结束（不再写设备，也绝不把旧会话状态带进下一次连接）；
		 *  - 供电状态失效（协议没有回读，断开后不能假装知道 on/off）；
		 *  - 端口里剩下的数据标成缺口（丢了多少要能看见）。
		 */
		function abortSession(reason) {
			const wasSampling = sampling
			const pendingSamples = link && typeof link.pendingSamples === 'function' ? link.pendingSamples() : 0
			sampling = false
			stopScheduled = false
			if (wasSampling) {
				// 已收到的样点先尽量入库；剩下的如实标缺口
				let flushed = { remaining: 0, remainingBytes: 0 }
				if (link && typeof link.flushQueue === 'function') {
					try { flushed = link.flushQueue(100) } catch (e) { /* 忽略 */ }
				}
				const lost = flushed.remaining || pendingSamples
				if (lost > 0) noteGap({ reason: 'session_aborted', missedSamples: lost, bytes: flushed.remainingBytes || 0 })
			}
			// 供电状态未知：不能把上一次会话的 commanded 带过来
			power = { on: null, source: 'unknown' }
			if (acq) {
				acq.startState = 0
				acq.stopState = 0
				acq.storeEnabled = acq.start === 'off'
				acq.startLatched = acq.start === 'off'
				acq.preMin = Infinity
				acq.preMax = -Infinity
			}
			lastTMs = 0
			lastTMsValid = false
			gapPending = false
			if (wasSampling) log(msg('ctl.session_ended', { reason: reason }), 'warn')
			onChange()
			return { wasSampling: wasSampling }
		}

		/** 新建连接前调用：清掉上一次会话可能残留的采样 / 供电 / 触发状态 */
		function prepareSession() {
			sampling = false
			stopScheduled = false
			power = { on: null, source: 'unknown' }
			lastTMs = 0
			lastTMsValid = false
			gapPending = false
			if (acq) {
				acq.startState = 0
				acq.stopState = 0
				acq.storeEnabled = acq.start === 'off'
				acq.startLatched = acq.start === 'off'
				acq.preMin = Infinity
				acq.preMax = -Infinity
			}
			onChange()
		}

		/**
		 * 把一份导入的样点灌进波形（CSV 导入）。
		 * 这是一个**新会话**：先清空、按导入的时间列定采样周期、按行给电压（历史口径），
		 * 缺口标记按行位置插进波形（不跨缺口积分）。不写设备、不改源电压设置。
		 * @param {object} parsed power-import.parseCsv 的返回值
		 */
		/**
		 * 把一份导入的样点灌进波形（CSV 导入）。
		 *
		 * 规则：
		 *  - 不碰设备控制状态（源电压设置保持不变）：导入文件里的电压只写进**波形历史**，
		 *    每个样点带着它自己那行的电压；
		 *  - 文件没有电压列 → 样点电压记为未知，能量不可用（绝不拿当前设置顶替）；
		 *  - 分批写入并让出线程，等归档队列推进；仍然装不下就如实返回「不完整（实际 N/请求 M）」，
		 *    不报完整成功。
		 * @param {object} parsed power-import.parseCsv 的返回值
		 * @param {object} [o] { batchSize, yieldMs }
		 */
		async function importSeries(parsed, o) {
			o = o || {}
			if (!parsed || !parsed.ok || !parsed.rows || !parsed.rows.length) {
				return { ok: false, code: 'empty', message: tr('ctl.import_empty'), ref: msg('ctl.import_empty') }
			}
			if (sampling) await stopSampling()
			clearSessionState()
			recordMode = 'wave'
			samplePeriodSec = parsed.samplePeriodSec > 0 ? parsed.samplePeriodSec : 0.001
			// 绑定本次导入所属的会话：期间被清空 / 重新采集 / 再次导入就立即取消（N9）
			const epochOf = function () { return wave && typeof wave.epoch === 'function' ? wave.epoch() : 0 }
			const importEpoch = epochOf()
			const estimated = !!parsed.estimatedPeriod
			const gapRows = {}
			for (let i = 0; i < parsed.gaps.length; i++) gapRows[parsed.gaps[i]] = true
			const batchSize = o.batchSize > 0 ? o.batchSize : 2048
			const yieldMs = o.yieldMs > 0 ? o.yieldMs : 0
			const requested = parsed.rows.length
			let stored = 0
			let gapsApplied = 0
			const perMs = samplePeriodSec * 1000
			let storageStopped = false
			for (let i = 0; i < parsed.rows.length; i++) {
				if (gapRows[i]) {
					noteGap({ reason: 'import_gap', at: wave && wave.total ? wave.total() : i })
					gapsApplied++
				}
				const row = parsed.rows[i]
				// 电压只进波形历史（未知就是 null，绝不继承界面上的设备设置）
				const volts = row.voltageMV != null && isFinite(row.voltageMV) ? row.voltageMV / 1000 : null
				if (!wave || !wave.push(row.currentUA, volts)) {
					storageStopped = true
					break
				}
				stored++
				try {
					onSampleStored(wave.total() - 1, i * perMs)
				} catch (e) { /* 时间锚点不影响数据 */ }
				// 分批让出：否则归档队列没有机会推进，小容量存储会半途停采
				if ((i + 1) % batchSize === 0) {
					await new Promise(function (r) { clock.setTimeout(r, yieldMs) })
					if (wave && typeof wave.waitIdle === 'function') await wave.waitIdle(200)
					// 每次 await 之后校验会话：变了就停止，绝不把旧导入写进新会话
					if (epochOf() !== importEpoch) {
						log(msg('ctl.import_cancelled_log'), 'warn')
						return {
							ok: false, code: 'session_changed', cancelled: true,
							stored: stored, requested: requested, gaps: gapsApplied,
							message: tr('ctl.import_cancelled', { stored: stored, requested: requested }), ref: msg('ctl.import_cancelled', { stored: stored, requested: requested }),
						}
					}
				}
			}
			onChange()
			if (storageStopped || stored < requested) {
				log(msg('ctl.import_partial_log', { stored: stored, requested: requested }), 'warn')
				return {
					ok: false, code: 'incomplete',
					stored: stored, requested: requested, gaps: gapsApplied,
					message: tr('ctl.import_partial', { stored: stored, requested: requested }), ref: msg('ctl.import_partial', { stored: stored, requested: requested }),
				}
			}
			log(msg('ctl.imported', {
				n: stored,
				rate: samplePeriodSec > 0 ? Math.round(1 / samplePeriodSec) + ' Hz' : tr('ctl.period_unknown'),
				extra: (estimated ? tr('ctl.import_estimated') : '') +
					(gapsApplied ? tr('ctl.import_gaps', { n: gapsApplied }) : '') +
					(parsed.hasVoltage ? '' : tr('ctl.import_no_voltage')),
			}), 'success')
			return {
				ok: true, samples: stored, requested: requested, gaps: gapsApplied,
				samplePeriodSec: samplePeriodSec, estimatedPeriod: estimated,
				hasVoltage: !!parsed.hasVoltage, voltsMixed: !!parsed.voltsMixed,
			}
		}

		function acqState() {
			if (!acq) return null
			return {
				start: acq.start,
				stop: acq.stop,
				storeEnabled: acq.storeEnabled,
				startLatched: acq.startLatched,
				waiting: acq.start !== 'off' && !acq.storeEnabled,
				startState: acq.startState,
				stopState: acq.stopState,
				preMin: acq.preMin,
				preMax: acq.preMax,
			}
		}

		function state() {
			return {
				connected: isConnected(),
				gen: genOf(),
				sampling: sampling,
				powered: powerPayload(),
				voltageMv: voltageMv,
				recordMode: recordMode,
				targetRateHz: targetRateHz,
				deviceStreamHz: deviceStreamHz,
				ignoredSamples: ignoredSamples,
				samplePeriodSec: getSamplePeriodSec(),
				voltageChangesDuringCapture: voltageChanges,
				modifiersOk: modifiersOk,
				queueDepth: opDepth,
				probeActive: !!probe,
			}
		}

		return {
			// 队列与状态
			runOp: runOp,
			state: state,
			powerPayload: powerPayload,
			markPowered: markPowered,
			noteGap: noteGap,
			ingest: ingest,
			pushSamples: pushSamples,
			ingestProbe: ingestProbe,
			deviceStreamHz: function () { return deviceStreamHz },
			// 采样沿触发（start / stop）与触发电平
			setAcqTriggers: function (startMode, stopMode) {
				if (!acq || !VIEW) return null
				VIEW.setAcqStartMode(acq, startMode, sampling)
				VIEW.setAcqStopMode(acq, stopMode, sampling)
				return acqState()
			},
			setTrigLevel: function (ua) {
				trigLevelUA = ua == null || !isFinite(ua) ? null : Number(ua)
			},
			trigLevel: trigLevel,
			acqState: acqState,
			abortSession: abortSession,
			importSeries: importSeries,
			prepareSession: prepareSession,
			// 长期模式的折叠总览（minimap）
			minimapData: function () { return folding.getData() },
			foldingLength: function () { return folding.length },
			isSampling: function () { return sampling },
			setRecordMode: setRecordMode,
			setTargetRateHz: setTargetRateHz,
			setSamplePeriodSec: setSamplePeriodSec,
			getSamplePeriodSec: getSamplePeriodSec,
			readVoltageMv: readVoltageMv,
			setVoltageSource: toggleVoltageSource,
			getModifiers: function () { return modifiers },
			modifiersOk: function () { return modifiersOk },
			longStats: function () { return longStats },
			warmupLeft: function () { return warmupLeft },
			rateAdj: function () { return rateAdj },
			// 电源 / 电压
			setPower: setPower,
			setVoltage: setVoltage,
			togglePower: togglePower,
			doPowerOn: doPowerOn,
			doPowerOff: doPowerOff,
			applyVoltageMv: applyVoltageMv,
			fetchModifiers: fetchModifiers,
			appendMetadataText: appendMetadataText,
			isMetaCollecting: function () { return metaCollecting },
			probeDutPower: probeDutPower,
			// 采样
			startSampling: startSampling,
			stopSampling: stopSampling,
			startCapture: startCapture,
			stopCapture: stopCapture,
			drainSampleRx: drainSampleRx,
			clearSessionState: clearSessionState,
			captureSummary: captureSummary,
			overallStats: overallStats,
			// 内部给界面用
			consumeWarmup: function () { if (warmupLeft > 0) warmupLeft--; return warmupLeft <= 0 },
		}
	}

	const api = { createControl: createControl, emptyStats: emptyStats }
	global.PowerControl = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
