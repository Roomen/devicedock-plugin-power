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
		let warmupLeft = 0
		let acqStoreEnabled = true
		let firstStoredMs = 0
		let sessionT0Ms = 0
		let lastTMs = 0
		let gapPending = false
		let metaCollecting = false
		let metaBuf = ''
		let probe = null
		let opChain = Promise.resolve()
		let opDepth = 0
		const longStats = { n: 0, sumI: 0, minI: Infinity, maxI: -Infinity, energyUAs: 0, t0: 0, tLast: 0 }

		// ---- 串行队列：界面操作排队，后台（failFast）不排在界面操作后面 ----
		function runOp(fn, o) {
			o = o || {}
			if (o.failFast && opDepth > 0) {
				return Promise.resolve({ ok: false, code: 'power_busy', message: '功耗仪正在执行另一项操作，请稍后重试' })
			}
			if (opDepth >= opts.maxQueueDepth) {
				return Promise.resolve({ ok: false, code: 'power_busy', message: '功耗仪操作队列已满，请稍后重试' })
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
			longStats.t0 = 0
			longStats.tLast = 0
		}

		// ---- 缺口：时间轴断开，能量不许跨缺口积分 ----
		function noteGap(info) {
			const idx = wave && typeof wave.total === 'function' ? wave.total() : 0
			if (wave && typeof wave.noteGap === 'function') wave.noteGap(idx)
			gapPending = true
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
					if (ingest(outs[k].tMs, outs[k].iUA, s)) stored++
				}
			}
			return stored
		}

		function ingest(tMs, iUA, info) {
			if (!isFinite(iUA)) return false
			if (!firstStoredMs) {
				firstStoredMs = tMs
				sessionT0Ms = tMs
			}
			const tSec = (tMs - sessionT0Ms) / 1000
			const prev = lastTMs
			let dt = 0
			if (prev && !gapPending) dt = Math.max(0, (tMs - prev) / 1000)
			gapPending = false
			lastTMs = tMs

			if (recordMode === 'long') {
				if (!longStats.t0) longStats.t0 = tSec
				longStats.tLast = tSec
				longStats.n++
				longStats.sumI += iUA
				if (iUA < longStats.minI) longStats.minI = iUA
				if (iUA > longStats.maxI) longStats.maxI = iUA
				longStats.energyUAs += iUA * dt
				return true
			}
			if (!wave) return false
			if (!wave.push(iUA)) return false
			// 时间锚点这类界面钩子抛错不能打断入库
			try {
				onSampleStored(wave.total() - 1, tMs)
			} catch (e) {
				log('样点时间锚点更新失败：' + (e && e.message ? e.message : e), 'warn')
			}
			return true
		}

		// ---- 写 ----
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
				log('请先设定源电压 mV', 'error')
				return { ok: false, stale: false }
			}
			const clamped = Math.max(PROTO.VDD_LOW_MV, Math.min(PROTO.VDD_HIGH_MV, Math.round(mv)))
			if (!isConnected()) {
				toggleVoltageSource(clamped)
				log('电压已设为 ' + clamped + ' mV（打开设备后写入）')
				return { ok: false, stale: false }
			}
			if (guardStep(guard)) return { ok: false, stale: false }
			const w = await writeRaw(PROTO.cmdRegulatorSet(clamped), 'REGULATOR ' + clamped + ' mV')
			if (!w.ok) {
				if (!w.stale) log('设定电压失败：设备未确认写入，保持上一次有效电压', 'error')
				onChange()
				return { ok: false, stale: !!w.stale }
			}
			if (voltageMv !== clamped && sampling) voltageChanges++
			toggleVoltageSource(clamped)
			log('设定电压 ' + clamped + ' mV', 'success')
			return { ok: true, stale: false }
		}

		async function doPowerOn(guard) {
			if (!isConnected()) return { ok: false, code: 'power_not_connected', message: '功耗仪未连接' }
			const mv = readVoltageMv()
			if (mv == null || !isFinite(mv) || mv < PROTO.VDD_LOW_MV) {
				log('请先设定源电压 mV（打开设备后会从设备读取）', 'error')
				return { ok: false, code: 'voltage_unknown', message: '尚未设定源电压' }
			}
			const gen = genOf()
			const v = await applyVoltageMv(mv, guard)
			if (!v.ok) {
				if (v.stale) return { ok: false, code: 'disconnected', message: '写电压时连接已变化，未上电', executed: 'unknown', powered: powerPayload() }
				log('DUT 上电已中止：源电压写入失败', 'error')
				return { ok: false, code: 'voltage_write_failed', message: '源电压写入失败，未上电', voltageMv: voltageMv, powered: powerPayload() }
			}
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: '请求已取消，未上电', executed: false, powered: powerPayload() }
			if (!stillSameConn(gen)) {
				return { ok: false, code: 'disconnected', message: '电压写入后设备已变化，未上电', executed: false, powered: powerPayload() }
			}
			const w = await writeRaw(PROTO.cmdDutPower(true), 'DUT 上电')
			if (!w.ok) {
				// 连接已经变了：这次结果不属于新连接，不能改它的供电状态
				if (w.stale) return { ok: false, code: 'disconnected', message: '上电过程中连接已变化，结果未知', executed: 'unknown', powered: powerPayload() }
				// 同一连接写失败：不知道设备收没收到，标未知
				markPowered(null, 'unknown')
				log('DUT 上电写入失败：状态未知', 'error')
				return { ok: false, code: 'power_write_failed', message: '上电命令写入失败，设备状态未知', executed: 'unknown', powered: powerPayload() }
			}
			markPowered(true, 'commanded')
			log('DUT 已上电（命令已写入，设备无回执）', 'success')
			return { ok: true, changed: true, powered: powerPayload(), voltageMv: voltageMv }
		}

		async function doPowerOff(guard) {
			if (!isConnected()) return { ok: false, code: 'power_not_connected', message: '功耗仪未连接' }
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: '请求已取消，未执行', executed: false, powered: powerPayload() }
			const gen = genOf()
			const w = await writeRaw(PROTO.cmdDutPower(false), 'DUT 下电')
			if (!w.ok) {
				if (w.stale) return { ok: false, code: 'disconnected', message: '下电过程中连接已变化，结果未知', executed: 'unknown', powered: powerPayload() }
				markPowered(null, 'unknown')
				log('DUT 下电写入失败：状态未知', 'error')
				return { ok: false, code: 'power_write_failed', message: '下电命令写入失败，设备状态未知', executed: 'unknown', powered: powerPayload() }
			}
			markPowered(false, 'commanded')
			log('DUT 已下电（命令已写入，设备无回执）')
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
			await writeRaw(PROTO.cmdMeta(), 'GET_META_DATA')
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
				log('设备参数读取完成' +
					(modifiers.deviceSn ? ' · SN ' + modifiers.deviceSn : '') +
					(saved ? ' · VDD ' + saved + ' mV' : '') +
					(modifiers.Calibrated != null ? ' · Calibrated=' + modifiers.Calibrated : ''), 'success')
				if (saved >= PROTO.VDD_LOW_MV && saved <= PROTO.VDD_HIGH_MV) toggleVoltageSource(Math.round(saved))
				else {
					log('设备未返回 VDD，请手动设定源电压', 'warn')
					toggleVoltageSource(null)
				}
				return true
			}
			// 设备内置默认 R 表；读失败仍可用默认修正，不阻断
			modifiers = PROTO.defaultModifiers()
			modifiersOk = false
			metaBuf = ''
			log('设备参数读取超时，使用默认 R/O 表', 'warn')
			onChange()
			return false
		}

		// ---- 采样 ----
		function clearSessionState() {
			if (wave) wave.reset()
			firstStoredMs = 0
			sessionT0Ms = 0
			lastTMs = 0
			gapPending = false
			resetLongStats()
			voltageChanges = 0
			deviceStreamHz = 0
			rawStreamCount = 0
			rawStreamFirstMs = 0
			peakRateHz = 0
		}

		async function drainSampleRx(ms) {
			link.setDrop(true)
			link.resetParser(false)
			const wait = Math.max(0, ms == null ? opts.rxDrainMs : ms)
			if (wait > 0) await new Promise(function (r) { clock.setTimeout(r, wait) })
			link.resetParser(false)
		}

		async function startSampling(guard) {
			if (!isConnected()) return { ok: false, code: 'power_not_connected', message: '功耗仪未连接' }
			if (sampling) return { ok: true, changed: false, sampling: true }
			const mv = readVoltageMv()
			if (!isFinite(mv) || mv == null || mv < PROTO.VDD_LOW_MV) {
				log('请先设定源电压 mV（设备要求先设电压再开采样）', 'error')
				return { ok: false, code: 'voltage_unknown', message: '尚未设定源电压' }
			}
			// 先 STOP → 排空残留 → 再 START
			link.setDrop(true)
			const gen0 = genOf()
			await writeRaw(PROTO.cmdAverageStop(), 'AVERAGE_STOP')
			await drainSampleRx(opts.rxDrainMs)
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: '请求已取消，未开始采样', executed: false }
			if (!stillSameConn(gen0)) {
				return { ok: false, code: 'disconnected', message: '设备已变化，未开始采样', executed: false }
			}

			const baseHz = deviceStreamHz > 1000 ? deviceStreamHz : PROTO.NOMINAL_BASE_HZ
			clearSessionState()
			// 先按标称速率起步，实测会在 pushSamples 里修正
			deviceStreamHz = baseHz
			if (recordMode === 'wave' && store) {
				try {
					await store.init()
				} catch (e) {
					log('初始化波形存储失败：' + (e && e.message ? e.message : e), 'warn')
				}
			}
			// 存储初始化等 await 之后重新确认：取消 / 断开 / 换设备都不能继续
			if (guardStep(guard)) return { ok: false, code: 'aborted', message: '请求已取消，未开始采样', executed: false }
			if (!stillSameConn(gen0)) {
				return { ok: false, code: 'disconnected', message: '设备已变化，未开始采样', executed: false }
			}

			link.resetParser(true)
			if (link.setConverterModifiers) link.setConverterModifiers(modifiers)
			rateAdj = new PROTO.RateAdjuster(targetRateHz, baseHz)
			samplePeriodSec = targetRateHz > 0 ? 1 / targetRateHz : samplePeriodSec
			warmupLeft = Math.max(0, Math.min(opts.warmupMaxSamples, Math.round(targetRateHz * opts.warmupSec)))
			metaCollecting = false
			metaBuf = ''
			acqStoreEnabled = true
			sampling = true
			onChange()

			const startW = await writeRaw(PROTO.cmdAverageStart(), 'AVERAGE_START')
			if (!startW.ok) {
				if (startW.stale) {
					return { ok: false, code: 'disconnected', message: '开始采样过程中连接已变化，结果未知', executed: 'unknown' }
				}
				sampling = false
				link.setDrop(true)
				log('开始采样失败：START 写入失败', 'error')
				onChange()
				return { ok: false, code: 'capture_start_failed', message: 'START 写入失败，未开始采样' }
			}
			// START 已下发后再接收样点（此前 drop 挡住 STOP 尾包与竞态）
			link.setDrop(false)
			const warmMs = targetRateHz > 0 ? Math.round(warmupLeft / targetRateHz * 1000) : 0
			log('采样已开始 · 目标 ' + targetRateHz + ' Hz · ' + (recordMode === 'long' ? '长期统计' : '波形') +
				' · 预热约 ' + warmMs + ' ms（' + warmupLeft + ' 点）' + (modifiersOk ? '' : ' · 默认修正参数'), 'success')
			return { ok: true, changed: true, sampling: true }
		}

		async function stopSampling(guard) {
			if (!sampling) return { ok: true, changed: false, sampling: false }
			const gen0 = genOf()
			sampling = false
			link.setDrop(true)
			acqStoreEnabled = true
			onChange()
			let stopW = { ok: true, stale: false }
			try {
				stopW = await writeRaw(PROTO.cmdAverageStop(), 'AVERAGE_STOP')
			} catch (e) {
				stopW = { ok: false, stale: false }
			}
			link.resetParser(false)
			const stopped = !!(wave && wave.storageStop && wave.storageStop())
			log(stopped ? '已停止采样（存储限制）' : '已停止采样')
			if (!stopW.ok) log('STOP 写入失败：本地已停止入库，设备可能仍在采样', 'warn')
			onChange()
			if (stopW.ok) return { ok: true, changed: true, sampling: false }
			if (stopW.stale) return { ok: false, code: 'disconnected', message: '停止采样过程中连接已变化，结果未知', executed: 'unknown', sampling: false }
			return { ok: false, code: 'stop_write_failed', message: 'STOP 写入失败，设备可能仍在采样', sampling: false }
		}

		// ---- 对外（界面 / 测试）----
		function setPower(on, guard) {
			const want = !!on
			return runOp(async function () {
				const g = await guardStart(guard)
				if (g) return g
				if (!isConnected()) return { ok: false, code: 'power_not_connected', message: '功耗仪未连接' }
				const gen = genOf()
				// 只有「上次命令」的状态才能跳过；实测 / 未知都不足以代替一次显式命令
				if (power.source === 'commanded' && power.on === want) {
					return { ok: true, changed: false, powered: powerPayload() }
				}
				const r = want ? await doPowerOn(guard) : await doPowerOff(guard)
				if (!stillSameConn(gen) && r && r.ok) {
					return { ok: false, code: 'disconnected', message: '操作期间设备断开，结果未知', executed: 'unknown', powered: powerPayload() }
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
					return { ok: false, code: 'power_not_connected', message: '功耗仪未连接' }
				}
				if (!isFinite(requested) || requested < PROTO.VDD_LOW_MV || requested > PROTO.VDD_HIGH_MV) {
					return { ok: false, code: 'out_of_range', message: '电压必须在 ' + PROTO.VDD_LOW_MV + '..' + PROTO.VDD_HIGH_MV + ' mV' }
				}
				const gen = genOf()
				const applied = await applyVoltageMv(requested, guard)
				if (!stillSameConn(gen) || applied.stale) {
					return { ok: false, code: 'disconnected', message: '操作期间设备断开，结果未知', executed: 'unknown' }
				}
				if (!applied.ok) return { ok: false, code: 'voltage_write_failed', message: '电压写入失败，未生效', voltageMv: voltageMv, requestedMv: requested }
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
			if (!isConnected()) return Promise.resolve({ ok: false, code: 'power_not_connected', message: '功耗仪未连接' })
			return setPower(power.on !== true)
		}

		/** DUT 是否带电：协议没有回读命令，只能短采一段看中位数 */
		async function probeDutPower() {
			if (!isConnected() || sampling || metaCollecting) return null
			probe = { vals: [] }
			link.setDrop(false)
			link.resetParser(false)
			try {
				await writeRaw(PROTO.cmdAverageStart(), 'AVERAGE_START · DUT 供电探测')
				await new Promise(function (r) { clock.setTimeout(r, opts.probeMs) })
			} catch (e) {
				probe = null
				return null
			}
			try { await writeRaw(PROTO.cmdAverageStop(), 'AVERAGE_STOP · DUT 供电探测') } catch (e) { /* 忽略 */ }
			const vals = probe ? probe.vals.slice() : []
			probe = null
			if (vals.length < 200) return null
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
				const dur = Math.max(0, longStats.tLast - longStats.t0)
				const avgI = n ? longStats.sumI / n : 0
				const v = voltageMv != null ? voltageMv / 1000 : 0
				const st = {
					n: n,
					avgI: avgI,
					avgP: avgI * v,
					minI: isFinite(longStats.minI) ? longStats.minI : 0,
					maxI: isFinite(longStats.maxI) ? longStats.maxI : 0,
					dur: dur,
					gaps: 0,
				}
				st.chargeUC = n ? longStats.energyUAs : 0
				st.chargeUAh = st.chargeUC / 3600
				st.energyUWh = n ? avgI * v * dur / 3600 : 0
				return st
			}
			if (!wave) return emptyStats()
			return wave.stats(0, wave.retained())
		}

		/** 摘要：单位、口径与数据来源都写清楚 */
		function captureSummary() {
			const st = overallStats()
			const total = recordMode === 'long' ? longStats.n : (wave ? wave.total() : 0)
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
				gaps: recordMode === 'long' ? 0 : (wave && wave.gaps ? wave.gaps().length : 0),
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
