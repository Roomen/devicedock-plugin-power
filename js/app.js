// 功耗分析插件的界面接线：所有能力都走宿主 RPC（device.read / serial.claim / app / log）。
// 设备字符串（口名 / 产品名 / 序列号 / metadata 文本）一律 textContent，不拼 HTML。
// 几何与映射全部来自 js/power-view.js，统计来自 js/power-panels.js —— 这里只负责画和收事件。
;(function () {
	'use strict'

	const sdk = window.DeviceDockPlugin
	const PROTO = window.PowerProtocol
	const View = window.PowerView
	const Panels = window.PowerPanels
	const WaveMod = window.PowerWave
	const StoreMod = window.PowerMemoryStore
	const Claim = window.PowerClaim
	const ControlMod = window.PowerControl
	const ExportMod = window.PowerExport
	const ImportMod = window.PowerImport
	const I18N = window.PowerI18n
	const tr = I18N.t
	// 惰性消息：日志 / 状态条存它，切语言时状态条按新语言重绘
	const M = I18N.msg

	const $ = function (id) { return document.getElementById(id) }
	const MIB = 1024 * 1024
	const fmt = Panels
	const C = View.C

	const DEFAULT_SETTINGS = {
		recordMode: 'wave',
		rateHz: 1000,
		voltageMv: 3300,
		// 热区（未压缩）预算与冷区原始当量上限，都可在界面里改
		ramMiB: 32,
		capMiB: 512,
		viewSec: 10,
		yMode: 'linear',
		showEnvelope: true,
		showBand: true,
		trigPre: 0.25,
		anSource: 'auto',
		capacityMah: 2000,
	}
	let settings = Object.assign({}, DEFAULT_SETTINGS)
	let saveTimer = 0
	let control = null
	let wave = null
	let store = null
	let link = null
	let exportSvc = null
	let busyId = null
	let logLines = 0
	let drawQueued = false
	let rafId = 0
	let readoutTimer = 0
	let viewStatsCache = null
	let laneTrack = null
	let stall = null
	// 本轮采样开始时的链路计数基线（看门狗用它区分「无应答」与「解析失败」）
	let captureBase = null
	let diagOpen = false
	// 采样 chip 的告警（开始失败 / 无应答 / 解析失败 / 中断）。界面每 400 ms 重绘一次，
	// 告警必须记在状态里，否则重绘会立刻把它刷回 capturing / idle。
	let sampleAlert = null
	// 最近一次列口结果（已按 BLU 筛选）；hidden 是被筛掉的口数（空态提示用）
	let lastPorts = { ports: [], hidden: 0 }
	// 连接后的初始化（读设备参数 + 供电探测）进行中：完成前 Start 不可用
	let connectInit = null

	// ---- 视图与显示状态（会话级，不落盘的部分只影响本次看波形） ----
	const view = { xZoom: 1, xOffset: 0, live: true, yMode: 'linear', yZoom: 1, yPan: 0, cursorA: null, cursorB: null }
	const show = { envelope: true, band: true, cycles: false, fft: false, battery: false }
	const trigUI = { mode: 'off', levelAuto: true, levelUA: null, preFrac: 0.25 }
	const trig = View.createScopeTrigger()
	let trigScanFrom = null
	let trigUserOverride = false
	const analysis = { source: 'auto', pack: null, key: '', timer: 0 }
	let edgeCache = { key: '', edges: null }
	let drag = null
	let plotRect = { x: 0, y: 0, w: 1, h: 1 }
	let marginLeft = 56

	// ---------- 小工具 ----------
	function fmtCount(n) {
		return (n || 0).toLocaleString('en-US')
	}
	function setText(id, text) {
		const el = $(id)
		if (el) el.textContent = text
	}
	function fmtBytes(n) {
		const a = Math.abs(n || 0)
		if (a >= MIB) return (n / MIB).toFixed(1) + ' MiB'
		if (a >= 1024) return (n / 1024).toFixed(1) + ' KiB'
		return (n || 0) + ' B'
	}
	function fmtTime(sec) {
		if (!isFinite(sec)) return '—'
		if (Math.abs(sec) >= 60) return fmt.fmtDuration(Math.abs(sec))
		return sec.toFixed(3) + ' s'
	}

	// 宿主日志（能力 log）：只在关键节点写
	function hostLog(text) {
		try {
			sdk.log.write(text).catch(function () { /* 宿主日志不可用不影响功能 */ })
		} catch (e) { /* 忽略 */ }
	}

	function log(message, level) {
		const list = $('log')
		if (!list) return
		const li = document.createElement('li')
		const t = document.createElement('span')
		t.className = 't'
		const d = new Date()
		t.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + ' '
		li.appendChild(t)
		li.appendChild(document.createTextNode(String(message)))
		if (level) li.dataset.level = level
		list.appendChild(li)
		logLines++
		while (list.childNodes.length > 300) list.removeChild(list.firstChild)
		list.scrollTop = list.scrollHeight
		setText('log-meta', tr('ui.log_lines', { n: logLines }))
		// 日志区在页面下方，常常看不到：错误 / 警告 / 成功同步到顶部状态条，失败不能静默
		if (level === 'error' || level === 'warn' || level === 'success') setStatus(message, level)
	}

	// 状态条保存消息本身（惰性消息带键与参数），不是翻译后的文本：语言切换时重绘
	let statusMsg = null
	function setStatus(message, level) {
		const el = $('status-line')
		if (!el) return
		statusMsg = message
		el.textContent = String(message)
		el.dataset.level = level || ''
		el.hidden = false
	}

	// ---------- 语言 ----------
	// 契约：宿主推 app.locale { locale }；SDK 有 onLocale 就订阅，没有或尚未收到就按 navigator.language。
	// 切换时就地重绘：静态文案走 data-i18n，运行时文案由各 render 函数按新语言重拼；
	// 已写进日志区的行保持写入时的语言（历史记录不改写）。
	let lastTheme = null
	const hintFns = {}

	/** 控制层操作的失败原因：优先惰性消息（切语言可重绘），再退到文本 / 错误码；cause 是底层写入错误（例如超时） */
	function opWhy(r) {
		const why = (r && (r.ref || r.message || r.code)) || M('ui.unknown_reason')
		return r && r.cause ? I18N.join([why, r.cause]) : why
	}

	/** 同 reasonText，但返回惰性消息：用作日志 / 状态条参数，切语言时跟着换 */
	function reasonMsg(code) {
		const key = 'ui.reason_' + code
		return I18N.has(key) ? M(key) : String(code)
	}

	function reasonText(code) {
		const key = 'ui.reason_' + code
		return I18N.has(key) ? tr(key) : String(code)
	}

	/** 提示行：存一个按当前语言出文案的函数，切语言时重跑 */
	function setHintFn(id, fn) {
		hintFns[id] = fn
		const el = $(id)
		if (!el) return
		// 动态提示接管后，静态 data-i18n 不能再把它刷回初始文案
		if (typeof el.removeAttribute === 'function') el.removeAttribute('data-i18n')
		el.textContent = fn()
	}

	function renderThemeChip(th) {
		if (th) lastTheme = th
		const name = (lastTheme && lastTheme.theme) === 'dark' ? 'dark' : 'light'
		setText('chip-theme', tr('ui.chip_theme', { theme: tr('ui.theme_' + name) }))
	}

	function relocalize() {
		I18N.apply(document)
		// 状态条：按保存的消息（键 + 参数）用新语言重绘
		if (statusMsg != null) {
			const sl = $('status-line')
			if (sl) sl.textContent = String(statusMsg)
		}
		Object.keys(hintFns).forEach(function (id) {
			const el = $(id)
			if (el) el.textContent = hintFns[id]()
		})
		if (link) renderPortOptions($('port').value)
		renderConnState()
		renderThemeChip(null)
		setText('log-meta', tr('ui.log_lines', { n: logLines }))
		const maxBtn = $('btn-max')
		if (maxBtn) maxBtn.textContent = tr(document.body && document.body.dataset && document.body.dataset.max === '1' ? 'ui.btn_restore' : 'ui.btn_maximize')
		renderSessionPanel()
		updateStoragePanel()
		updateGapChip()
		updateTriggerChip(control ? control.trigLevel() : 0)
		renderCursorPanel()
		renderAnalysisPanel(analysis.pack)
		renderDiagnostics()
		scheduleDraw()
	}

	function initLocale() {
		// 先按 navigator 定一个初值，界面第一帧就是对的语言；宿主推送到了再覆盖
		I18N.setLocale(I18N.fallbackLocale(typeof navigator !== 'undefined' ? navigator : null))
		if (typeof sdk.onLocale === 'function') {
			sdk.onLocale(function (loc) { if (loc) I18N.setLocale(loc) })
		} else if (typeof sdk.on === 'function') {
			// 旧 SDK 没有 onLocale，但会把未知事件原样转给 on()：宿主新版推 app.locale 时同样能收到
			sdk.on('app.locale', function (p) { if (p && p.locale) I18N.setLocale(p.locale) })
		}
		if (typeof sdk.getLocale === 'function') {
			const cur = sdk.getLocale()
			if (cur) I18N.setLocale(cur)
		}
		I18N.apply(document)
		I18N.onChange(relocalize)
	}

	// ---------- 诊断 ----------
	function fmtAgo(at) {
		if (!at) return tr('ui.ago_never')
		const ms = Date.now() - at
		return ms < 1000 ? tr('ui.ago_ms', { n: ms }) : tr('ui.ago_s', { n: (ms / 1000).toFixed(1) })
	}

	function renderDiagnostics() {
		if (!diagOpen || !link) return
		const st = link.stats()
		setText('diag-tx', tr('ui.diag_tx', { writes: st.txWrites, bytes: fmtCount(st.txBytes), failed: st.txFailures, ago: fmtAgo(st.lastTxAt) }))
		setText('diag-rx', tr('ui.diag_rx', { batches: st.events, bytes: fmtCount(st.bytes), ago: fmtAgo(st.lastRxAt) }))
		setText('diag-decode', tr('ui.diag_decode', { samples: fmtCount(st.samples), drained: fmtCount(st.drainedBytes), errors: st.decodeErrors, gaps: st.parserGaps }))
		setText('diag-link', tr('ui.diag_link', {
			state: tr(link.isOpen() ? 'ui.link_open' : 'ui.link_closed'),
			claim: link.claimId() || '—',
			gen: link.streamGen(),
			mode: tr(link.isDropping() ? 'ui.link_dropping' : 'ui.link_receiving'),
		}))
		setText('diag-error', st.lastError ? new Date(st.lastError.at).toLocaleTimeString() + ' ' + String(st.lastError.ref || st.lastError.message) : tr('ui.none'))
	}

	function toggleDiagnostics() {
		diagOpen = !diagOpen
		const panel = $('diag')
		if (panel) panel.hidden = !diagOpen
		$('btn-diag').setAttribute('aria-pressed', String(diagOpen))
		renderDiagnostics()
	}

	// ---------- 设置 ----------
	function normalizeSettings(raw) {
		const out = Object.assign({}, DEFAULT_SETTINGS)
		if (!raw || typeof raw !== 'object') return out
		if (raw.recordMode === 'long' || raw.recordMode === 'wave') out.recordMode = raw.recordMode
		const rate = Number(raw.rateHz)
		if (rate === 1000 || rate === 10000 || rate === 100000) out.rateHz = rate
		const mv = Number(raw.voltageMv)
		if (isFinite(mv) && mv >= PROTO.VDD_LOW_MV && mv <= PROTO.VDD_HIGH_MV) out.voltageMv = Math.round(mv)
		const ram = Number(raw.ramMiB)
		if (isFinite(ram) && ram >= 8 && ram <= 1024) out.ramMiB = Math.round(ram)
		const cap = Number(raw.capMiB)
		if (isFinite(cap) && cap >= 16 && cap <= 4096) out.capMiB = Math.round(cap)
		const vs = Number(raw.viewSec)
		if (isFinite(vs) && vs > 0) out.viewSec = vs
		if (raw.yMode === 'linear' || raw.yMode === 'log' || raw.yMode === 'symlog') out.yMode = raw.yMode
		if (typeof raw.showEnvelope === 'boolean') out.showEnvelope = raw.showEnvelope
		if (typeof raw.showBand === 'boolean') out.showBand = raw.showBand
		const pre = Number(raw.trigPre)
		if (pre === 0.1 || pre === 0.25 || pre === 0.5) out.trigPre = pre
		if (raw.anSource === 'auto' || raw.anSource === 'selection' || raw.anSource === 'window') out.anSource = raw.anSource
		const cap2 = Number(raw.capacityMah)
		if (isFinite(cap2) && cap2 > 0) out.capacityMah = cap2
		return out
	}

	function saveSettingsSoon() {
		if (saveTimer) clearTimeout(saveTimer)
		saveTimer = setTimeout(function () {
			saveTimer = 0
			sdk.app.storageSet('settings', settings).catch(function (e) {
				log(M('app.save_settings_failed', { err: (e && e.message ? e.message : e) }), 'warn')
			})
		}, 400)
	}

	function syncViewFromSettings() {
		view.yMode = settings.yMode
		show.envelope = settings.showEnvelope
		show.band = settings.showBand
		trigUI.preFrac = settings.trigPre
		analysis.source = settings.anSource
	}

	// ---------- 管线 ----------
	function createPipeline() {
		store = StoreMod.createMemoryWaveStore({
			capRawBytes: settings.capMiB * MIB,
			onEvict: function () { scheduleDraw() },
			onUse: function () { updateStoragePanel() },
		})
		wave = WaveMod.createWave({
			store: store,
			chunkSize: 65536,
			ramCapSamples: Math.max(65536, Math.round((settings.ramMiB * MIB) / 4)),
			metaBudgetBytes: settings.ramMiB * MIB + 32 * MIB,
			voltage: function () {
				const st = control ? control.state() : null
				return st && st.voltageMv != null ? st.voltageMv / 1000 : null
			},
			samplePeriod: function () { return control ? control.getSamplePeriodSec() : 0 },
			log: log,
			scheduleUI: scheduleDraw,
			onStorageStop: function (reason) {
				log(reason, 'error')
				if (control && control.isSampling()) stopCapture('storage')
			},
		})

		link = Claim.createClaimLink({
			host: sdk,
			// 与原实现一致（USB CDC 虚拟串口，波特率只是占位，但保持同一取值）
			baudRate: 1000000,
			createParser: function () {
				const mods = control ? control.getModifiers() : PROTO.defaultModifiers()
				return new PROTO.SampleParser(new PROTO.Converter(mods))
			},
			onSamples: onSamples,
			onGap: function (info) {
				if (control) control.noteGap(info)
				updateGapChip()
				if (info.reason === 'overflow' || info.reason === 'closing') {
					log(M('app.host_dropped', { bytes: info.bytes, reason: info.reason }), 'warn')
					hostLog('host dropped ' + info.bytes + ' bytes (' + info.reason + '), marked as a gap')
				}
			},
			onState: function (st) {
				renderConnState()
				handleLinkState(st)
			},
			onLog: log,
			onBytes: function (bytes) {
				if (!control || !control.isMetaCollecting()) return false
				let text = ''
				for (let i = 0; i < bytes.length; i++) {
					const c = bytes[i]
					text += (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) ? String.fromCharCode(c) : ' '
				}
				control.appendMetadataText(text)
				return true
			},
		})
		link.attach()

		// 宿主 SDK 在 claim.rx 回调抛错时仍会 ack（视为已消费），并把错误交给这个处理器。
		// 我们的回调自己接住一切异常，所以走到这里说明是插件自身的 bug：两个日志都写一遍。
		if (typeof sdk.setClaimErrorHandler === 'function') {
			sdk.setClaimErrorHandler(function (err, info) {
				const where = info && info.claimId ? ' (claim ' + info.claimId + ' gen ' + info.gen + ' seq ' + info.seq + ')' : ''
				log(M('app.rx_handler_threw', { where: where, err: err && err.message ? err.message : err }), 'error')
				hostLog('claim.rx handler threw' + where + ': ' + (err && err.message ? err.message : err))
			})
		}

		control = ControlMod.createControl({
			link: link,
			wave: wave,
			store: store,
			settings: {
				recordMode: settings.recordMode,
				targetRateHz: settings.rateHz,
				voltageMv: settings.voltageMv,
			},
			log: log,
			onChange: function () {
				// START 超时的「结果未知」收尾完成：撤掉提示，放开 Start
				if (sampleAlert && sampleAlert.key === 'ui.alert_start_unknown' && control && !control.isStartUnknown()) {
					sampleAlert = null
					updateSampleButton()
				}
				renderConnState()
				renderSessionPanel()
			},
			// 任何途径结束采样（含停止沿自动停）都在这里收尾：停看门狗、释放更新屏障、清告警
			onSamplingEnd: function (info) {
				if (stall) stall.stop()
				releaseBusy()
				sampleAlert = null
				updateSampleButton()
				if (info && info.reason === 'acq_stop') hostLog('capture stop edge hit; local acquisition ended, device STOP requested')
			},
			onSampleStored: function (index, tMs) {
				if (laneTrack) laneTrack.note(index, tMs)
			},
		})

		exportSvc = ExportMod.createExportService({
			wave: wave,
			control: control,
			saveFile: function (opts) { return sdk.app.saveFile(opts) },
			log: log,
		})
	}

	if (window.PowerSerialLane && typeof window.PowerSerialLane.createAnchorTrack === 'function') {
		// 锚点只用于「事件 ↔ 样点下标」的对齐；数组有硬上限，且每次新采集会话重置
		laneTrack = window.PowerSerialLane.createAnchorTrack({ intervalMs: 200, gapMs: 20, maxAnchors: 20000 })
	}

	// ---------- 数据到达 ----------
	function onSamples(list, at, meta) {
		if (!control) return
		control.pushSamples(list, at, meta)
		if (stall) stall.note()
		scanTriggers()
		scheduleDraw()
	}

	/**
	 * 显示触发扫描：只扫上一批之后的新点。命中后退出 Live 并把触发点钉在 pre 位置。
	 * 用户主动平移 / 缩放后暂停钉住（trigUserOverride），直到下一次新沿。
	 */
	function scanTriggers() {
		if (trigUI.mode === 'off' || !wave || !control || control.state().recordMode !== 'wave') return
		const total = wave.total()
		if (total < 8) return
		const from = trigScanFrom == null ? Math.max(1, total - 20000) : Math.max(1, trigScanFrom + 1)
		trigScanFrom = total - 1
		if (from >= total) return
		const win = Math.min(total, 4000)
		const st = wave.stats(total - win, total)
		const thr = trigUI.levelAuto ? View.autoTrigLevel({ min: st.minI, max: st.maxI }) : trigUI.levelUA
		const hyst = View.trigHysteresis({ min: st.minI, max: st.maxI }, thr)
		const res = View.scanScopeTrigger(trig, {
			mode: trigUI.mode,
			total: total,
			from: from,
			to: total - 1,
			sampleAt: function (i) { return wave.iAt(i) },
			thr: thr,
			hyst: hyst,
			viewPts: View.viewPoints(total, view.xZoom),
		})
		updateTriggerChip(thr)
		if (res.fired != null) {
			view.live = false
			trigUserOverride = false
		}
	}

	function updateTriggerChip(thr) {
		const chip = $('chip-trigger')
		if (!chip) return
		if (trigUI.mode === 'off') {
			chip.dataset.state = 'off'
			chip.textContent = tr('ui.chip_trigger_off')
			return
		}
		const lvl = trigUI.levelAuto ? fmt.fmtCurrent(thr == null ? 0 : thr) : fmt.fmtCurrent(trigUI.levelUA)
		chip.dataset.state = trig.lockLi == null ? 'warn' : 'busy'
		chip.textContent = tr('ui.chip_trigger', { mode: tr('ui.edge_' + trigUI.mode), level: lvl })
	}

	// ---------- 端口 ----------
	async function refreshPorts() {
		const sel = $('port')
		try {
			// 只列 BLU 设备：这是唯一能连接的设备类型，没有匹配时给明确空态，绝不退回列全部口
			lastPorts = Claim.filterAnalyzerPorts(await link.listPorts())
			renderPortOptions(sel.value)
		} catch (e) {
			log(M('app.list_ports_failed', { err: e && e.message ? e.message : e }), 'error')
		}
	}

	/** 按最近一次列口结果画下拉（语言切换时也走这里，不重新列口） */
	function renderPortOptions(current) {
		const sel = $('port')
		const ports = lastPorts.ports
		sel.textContent = ''
		if (!ports.length) {
			const opt = document.createElement('option')
			opt.value = ''
			opt.textContent = tr('ui.ports_none_found', { hidden: lastPorts.hidden ? tr('ui.ports_hidden', { n: lastPorts.hidden }) : '' })
			sel.appendChild(opt)
			sel.disabled = true
			if (!(link && link.isOpen())) setText('chip-port', tr('ui.chip_port_none'))
			return
		}
		sel.disabled = !!(link && (link.isOpen() || link.isOpening()))
		ports.forEach(function (p) {
			const opt = document.createElement('option')
			opt.value = p.key || ''
			const name = p.alias || p.productName || p.portName || p.key || tr('ui.port_fallback_name')
			const detail = [p.portName && p.portName !== name ? p.portName : '', p.serialNumber || ''].filter(Boolean).join(' · ')
			opt.textContent = detail ? name + '  (' + detail + ')' : name
			if (p.busy) opt.textContent += '  ' + tr('ui.port_busy', { who: p.busy })
			sel.appendChild(opt)
		})
		if (current) {
			for (let i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === current) { sel.selectedIndex = i; break }
			}
		}
		setText('chip-port', sel.options[sel.selectedIndex] ? tr('ui.chip_port', { label: sel.options[sel.selectedIndex].textContent }) : tr('ui.chip_port_none'))
	}

	function renderConnState() {
		const open = link && link.isOpen()
		const opening = link && link.isOpening()
		const btn = $('btn-connect')
		btn.textContent = tr(open ? 'ui.btn_disconnect' : (opening ? 'ui.btn_opening' : 'ui.btn_connect'))
		btn.disabled = !!opening
		// 没有 BLU 口时下拉保持禁用（空态提示），不能被连接态刷新重新启用
		$('port').disabled = !!open || !!opening || !lastPorts.ports.length
		$('btn-refresh').disabled = !!open || !!opening
		$('chip-port').dataset.state = open ? 'on' : 'off'
		if (open) {
			const sel = $('port')
			const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : (link.portKey() || '')
			setText('chip-port', tr('ui.chip_port', { label: label }))
		}
		setText('session-meta', tr(open ? 'ui.session_connected' : 'ui.session_disconnected'))
		$('btn-power').disabled = !open
		// 初始化（读参数 + 探测）完成前不放开 Start：探测的 STOP 不能落在用户 START 之后
		// START 结果未知（超时后宿主仍可能写出）收尾完成前同样不放开 Start
		$('btn-sample').disabled = !open || !!connectInit || !!(control && control.isStartUnknown && control.isStartUnknown() && !control.isSampling())
		$('btn-apply-voltage').disabled = !open
	}

	// 「是我们自己关的」标记：只有非主动关闭才按意外断开处理
	let closingByUs = false
	let linkWasOpen = false
	/**
	 * 意外关闭 / 宿主收回声明：统一终止会话。
	 * 采样、看门狗、更新屏障与供电状态都不能留到下一次连接。
	 */
	function handleLinkState(st) {
		const isOpen = !!(st && st.open)
		if (linkWasOpen && !isOpen && !closingByUs) {
			const wasSampling = control ? control.isSampling() : false
			sampleAlert = null
			if (control) control.abortSession(M('app.reason_disconnected'))
			releaseBusy()
			if (stall) stall.stop()
			View.resetScopeTrigger(trig)
			trigScanFrom = null
			updateSampleButton()
			renderSessionPanel()
			log(M('app.disconnected_unexpected'), 'warn')
			hostLog('serial session terminated after an unexpected disconnect')
			void wasSampling
		}
		linkWasOpen = isOpen
	}

	async function toggleConnect() {
		const btn = $('btn-connect')
		btn.disabled = true
		try {
			if (link.isOpen()) {
				closingByUs = true
				try {
					if (control.isSampling()) {
						const sr = await control.stopCapture()
						if (!sr || !sr.ok) log(M('app.disconnect_stop_failed', { why: opWhy(sr) }), 'error')
					}
					await link.close()
				} finally {
					closingByUs = false
				}
				releaseBusy()
				if (stall) stall.stop()
				setSampleAlert(null)
				log(M('app.released'))
				hostLog('released the analyzer port')
			} else {
				const key = $('port').value
				if (!key) {
					log(M('app.choose_port'), 'warn')
					return
				}
				await link.open(key)
				// 新连接不得继承旧会话状态（采样 / 供电 / 触发）
				control.prepareSession()
				linkWasOpen = true
				const sel = $('port')
				const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : key
				log(M('app.claimed'), 'success')
				hostLog('claimed ' + label + ' exclusively')
				connectInit = (async function () {
					// 两步都经操作队列：返回 {ok:false}（忙 / 队列满）时不能当成功用，要上状态条
					const ok = await control.fetchModifiers()
					if (ok && typeof ok === 'object' && ok.ok === false) {
						log(M('app.meta_skipped', { why: opWhy(ok) }), 'error')
					} else if (ok) {
						const mv = control.readVoltageMv()
						if (mv != null) $('voltage').value = String(mv)
					}
					const probe = await control.probeDutPower()
					if (probe && probe.ok === false) {
						log(M('app.probe_skipped', { why: opWhy(probe) }), 'error')
					} else if (probe) {
						control.markPowered(probe.on, 'probed')
						log(M('app.probe_result', { state: M(probe.on ? 'app.probe_on' : 'app.probe_off'), median: probe.medianUA.toFixed(2), n: probe.n }))
					}
				})()
				renderConnState()
				try {
					await connectInit
				} finally {
					connectInit = null
				}
			}
		} catch (e) {
			log(M('app.port_op_failed', { err: (e && e.message ? e.message : e) }), 'error')
		} finally {
			btn.disabled = false
			renderConnState()
			renderSessionPanel()
			scheduleDraw()
		}
	}

	// ---------- 采样 ----------
	async function acquireBusy() {
		if (busyId) return busyId
		try {
			const res = await sdk.app.busyAcquire('Power capture')
			busyId = res && res.busyId ? res.busyId : null
		} catch (e) {
			log(M('app.busy_failed', { err: (e && e.message ? e.message : e) }), 'warn')
			busyId = null
		}
		return busyId
	}

	function releaseBusy() {
		if (!busyId) return
		const id = busyId
		busyId = null
		sdk.app.busyRelease(id).catch(function () {})
	}

	async function startCapture() {
		if (!link.isOpen()) {
			log(M('app.start_not_connected'), 'error')
			return
		}
		// 连接初始化还没完：等它结束再开始（按钮已禁用，这里兜底；控制层的操作队列也保证不交错）
		if (connectInit) {
			try { await connectInit } catch (e) { /* 初始化失败已记日志 */ }
			if (!link.isOpen()) return
		}
		// 上一次 START 超时、结果未知的收尾还没完成（按钮已禁用，快捷键等入口在这里兜底）：不开始，也不改提示
		if (control.isStartUnknown()) {
			log(M('ctl.start_blocked_unknown'), 'warn')
			return
		}
		let failed = ''
		sampleAlert = null
		setStatus(M('app.starting'), '')
		await acquireBusy()
		try {
			const r = await control.startCapture()
			if (r && r.ok) {
				const st = control.state()
				hostLog('capture started at ' + fmtCount(st.targetRateHz) + ' Hz (' + (st.recordMode === 'wave' ? 'waveform' : 'long stats') + ')')
				// 新一轮采集：锚点、触发扫描与视图都从零开始（锚点不能跨会话累积）
				if (laneTrack) laneTrack.reset()
				View.resetScopeTrigger(trig)
				trigScanFrom = null
				trigUserOverride = false
				view.live = true
				view.xOffset = 0
				const ls = link.stats()
				captureBase = { bytes: ls.bytes, samples: ls.samples }
				if (stall) stall.start()
				const typed = Math.round(Number($('voltage').value))
				if (isFinite(typed) && st.voltageMv != null && typed !== st.voltageMv) {
					log(M('app.voltage_not_applied', { typed: typed, mv: st.voltageMv }), 'warn')
				}
			}
			if (r && r.code === 'capture_start_unknown') {
				// 结果未知不是「启动失败」：控制层已把未知原因与收尾说明写上状态条，这里不再盖成错误
				failed = r.ref || r.message
				hostLog('capture start outcome unknown (START timed out); settling')
				releaseBusy()
			} else if (!r || !r.ok) {
				failed = M('app.start_failed', { why: (r && (r.ref || r.message || r.code)) || M('ui.unknown_reason') })
				log(failed, 'error')
				releaseBusy()
			}
		} catch (e) {
			releaseBusy()
			failed = M('app.start_error', { err: (e && e.message ? e.message : e) })
			log(failed, 'error')
		}
		if (failed) sampleAlert = control.isStartUnknown() ? { state: 'warn', key: 'ui.alert_start_unknown' } : { state: 'error', key: 'ui.alert_start_failed' }
		renderSessionPanel()
		updateSampleButton()
		renderDiagnostics()
		scheduleDraw()
		startDrawLoop()
	}

	async function stopCapture(reason) {
		sampleAlert = null
		let stopConfirmed = false
		try {
			const r = await control.stopCapture()
			stopConfirmed = !!(r && r.ok)
			if (!stopConfirmed) log(M('app.stop_result', { why: opWhy(r) }), 'error')
		} catch (e) {
			log(M('app.stop_error', { err: (e && e.message ? e.message : e) }), 'error')
		} finally {
			releaseBusy()
			if (stall) stall.stop()
			if (reason === 'storage') log(M(stopConfirmed ? 'app.stopped_storage' : 'app.storage_stop_unconfirmed'), 'warn')
			const s = control.captureSummary()
			hostLog((stopConfirmed ? 'capture stopped: ' : 'capture stop unconfirmed: ') + fmtCount(s.totalSamples) + ' samples, ' + s.gaps + ' gap(s)')
			renderSessionPanel()
			updateSampleButton()
			scheduleDraw()
		}
	}

	function updateSampleButton() {
		const sampling = control && control.isSampling()
		const btn = $('btn-sample')
		btn.textContent = tr(sampling ? 'ui.btn_stop' : 'ui.btn_start')
		btn.dataset.primary = sampling ? '0' : '1'
		const chip = $('chip-sampling')
		if (control && control.isStartUnknown() && !sampling) {
			chip.dataset.state = 'warn'
			chip.textContent = tr('ui.alert_start_unknown')
			return
		}
		if (sampleAlert) {
			chip.dataset.state = sampleAlert.state
			chip.textContent = tr(sampleAlert.key)
			return
		}
		chip.dataset.state = sampling ? 'busy' : 'off'
		chip.textContent = tr(sampling ? 'ui.chip_capturing' : 'ui.chip_idle')
	}

	// 告警存的是文案键，语言切换后重绘出新语言
	function setSampleAlert(state, key) {
		sampleAlert = state ? { state: state, key: key } : null
		updateSampleButton()
	}

	// ---------- 视口 ----------
	function totalSamples() {
		if (!wave) return 0
		if (control && control.state().recordMode === 'long') return 0
		return wave.total()
	}

	function currentRange() {
		const total = totalSamples()
		if (total < 2) return { start: 0, end: 0, count: 0, viewPts: 0, xOffset: 0 }
		return View.viewRange({
			total: total,
			xZoom: view.xZoom,
			xOffset: view.xOffset,
			live: view.live,
			trigLockLi: (trigUI.mode !== 'off' && !trigUserOverride) ? trig.lockLi : null,
			trigPosFrac: trigUI.preFrac,
			periodSec: control ? control.getSamplePeriodSec() : 0,
		})
	}

	function applyRangeState(r) {
		if (r && typeof r.xOffset === 'number') view.xOffset = r.xOffset
	}

	function resetView() {
		view.xZoom = 1
		view.xOffset = 0
		view.live = true
		view.yZoom = 1
		view.yPan = 0
		trigUserOverride = false
		viewStatsCache = null
		scheduleDraw()
		renderSessionPanel()
		log(M('app.view_reset'))
	}

	function markUserView() {
		view.live = false
		if (trigUI.mode !== 'off') trigUserOverride = true
	}

	// ---------- 画布 ----------
	function cssVar(name, fallback) {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name)
		return (v && v.trim()) || fallback
	}

	function canvasLayout(cv) {
		const dpr = window.devicePixelRatio || 1
		const w = Math.max(1, cv.clientWidth)
		const h = Math.max(1, cv.clientHeight)
		if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
			cv.width = Math.round(w * dpr)
			cv.height = Math.round(h * dpr)
		}
		const g = cv.getContext('2d')
		if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0)
		return { g: g, w: w, h: h }
	}

	function drawWave() {
		const cv = $('wave')
		if (!cv || !wave) return
		const lat = canvasLayout(cv)
		const g = lat.g
		if (!g) return
		const w = lat.w
		const h = lat.h
		const colBg = cssVar('--bg-sunken', '#eef1f5')
		const colGrid = cssVar('--border-light', 'rgba(17,24,39,0.07)')
		const colTrace = cssVar('--accent', '#1f5fbf')
		const colBand = cssVar('--accent-light', 'rgba(31,95,191,0.08)')
		const colText = cssVar('--text-muted', '#6b7487')
		const colGap = cssVar('--warning', '#b45309')
		const colBorder = cssVar('--border-color', 'rgba(17,24,39,0.12)')

		g.clearRect(0, 0, w, h)
		g.fillStyle = colBg
		g.fillRect(0, 0, w, h)

		marginLeft = 56
		const mTop = 6
		const mBottom = 18
		plotRect = { x: marginLeft, y: mTop, w: Math.max(1, w - marginLeft - 8), h: Math.max(1, h - mTop - mBottom) }

		const total = totalSamples()
		const longMode = control && control.state().recordMode === 'long'
		if (total < 2) {
			g.fillStyle = colText
			g.font = '12px ' + cssVar('--font-sans', 'sans-serif')
			g.textBaseline = 'middle'
			g.fillText(tr(longMode ? 'ui.canvas_long_mode' : 'ui.canvas_empty'), marginLeft + 8, h / 2)
			drawMinimap()
			return
		}
		const range = currentRange()
		applyRangeState(range)
		const span = Math.max(1, range.count - 1)
		const period = control ? control.getSamplePeriodSec() : 0
		// 视窗统计由 renderSessionPanel 每 400 ms 算一次并缓存；画布每帧只读缓存
		const stats = (viewStatsCache && viewStatsCache.start === range.start && viewStatsCache.end === range.end)
			? viewStatsCache.stats
			: wave.stats(range.start, range.end + 1)
		const yScale = View.buildYScale({
			mode: view.yMode,
			yMin: stats.minI,
			yMax: stats.maxI,
			minPositive: wave.minPositiveIn ? wave.minPositiveIn(range.start, range.end + 1) : stats.minI,
			yZoom: view.yZoom,
			yPan: view.yPan,
		})
		const xOf = function (li) { return plotRect.x + View.indexToPixel(li, range, plotRect.w) }
		const yOf = function (v) { return plotRect.y + yScale.toPixel(v, plotRect.h) }
		const clipToPlot = function () {
			g.beginPath()
			g.rect(plotRect.x, plotRect.y, plotRect.w, plotRect.h)
			g.clip()
		}

		// ---- 网格与 Y 刻度 ----
		g.strokeStyle = colGrid
		g.lineWidth = 1
		const yTicks = yScale.ticks.major.filter(function (v) { return isFinite(v) })
		const shownY = []
		for (let i = 0; i < yTicks.length; i++) {
			const y = yOf(yTicks[i])
			if (y < plotRect.y - 1 || y > plotRect.y + plotRect.h + 1) continue
			shownY.push({ v: yTicks[i], y: y })
			g.beginPath()
			g.moveTo(plotRect.x, Math.round(y) + 0.5)
			g.lineTo(plotRect.x + plotRect.w, Math.round(y) + 0.5)
			g.stroke()
		}
		// 淡线（log 的 3,4,6,7,8,9 与 symlog 外侧）
		g.strokeStyle = colGrid
		const faint = yScale.ticks.faint
		for (let i = 0; i < faint.length; i++) {
			const y = yOf(faint[i])
			if (y < plotRect.y - 1 || y > plotRect.y + plotRect.h + 1) continue
			g.beginPath()
			g.moveTo(plotRect.x, Math.round(y) + 0.5)
			g.lineTo(plotRect.x + plotRect.w, Math.round(y) + 0.5)
			g.stroke()
		}
		// 边框
		g.strokeStyle = colBorder
		g.strokeRect(plotRect.x + 0.5, plotRect.y + 0.5, plotRect.w - 1, plotRect.h - 1)

		// ---- 波形 ----
		const bs = wave.computeBucketSize(range.count, Math.max(1, Math.floor(plotRect.w)))
		wave.frameReset()
		const first = Math.floor(range.start / bs)
		const last = Math.floor(range.end / bs)
		const entries = []
		for (let bi = first; bi <= last; bi++) {
			const e = wave.bucketEntry(bi, bs, 0, range.end)
			if (!e) continue
			entries.push(e)
		}
		g.save()
		clipToPlot()
		// 包络：每个桶的 min/max 竖线（列）
		if (show.envelope) {
			g.strokeStyle = colTrace
			g.globalAlpha = 0.45
			g.lineWidth = 1
			g.beginPath()
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i]
				const x = Math.round(xOf(e.loAbs)) + 0.5
				const yTop = yOf(e.max)
				const yBot = yOf(e.min)
				g.moveTo(x, yTop)
				g.lineTo(x, Math.max(yBot, yTop + 1))
			}
			g.stroke()
			g.globalAlpha = 1
		}
		// 均值 ±1σ 带
		if (show.band) {
			g.fillStyle = colBand
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i]
				const x = xOf(e.loAbs)
				const wpx = Math.max(1, xOf(e.hiAbs) - x)
				const hi = yOf(e.mean + e.sd)
				const lo = yOf(e.mean - e.sd)
				g.fillRect(x, hi, wpx, Math.max(1, lo - hi))
			}
		}
		// 均值折线
		g.strokeStyle = colTrace
		g.lineWidth = 1.25
		g.beginPath()
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i]
			const x = xOf(e.loAbs)
			const y = yOf(e.mean)
			if (i === 0) g.moveTo(x, y)
			else g.lineTo(x, y)
		}
		g.stroke()

		// 缺口：竖线 + 顶部短刻度（缺口处数据不连续，绝不能画成连续线）
		const gaps = wave.gaps()
		g.strokeStyle = colGap
		g.lineWidth = 1
		g.beginPath()
		for (let i = 0; i < gaps.length; i++) {
			const gi = gaps[i]
			if (gi < range.start || gi > range.end) continue
			const x = Math.round(xOf(gi)) + 0.5
			g.moveTo(x, plotRect.y)
			g.lineTo(x, plotRect.y + plotRect.h)
		}
		g.stroke()
		g.fillStyle = colGap
		for (let i = 0; i < gaps.length; i++) {
			const gi = gaps[i]
			if (gi < range.start || gi > range.end) continue
			g.fillRect(Math.round(xOf(gi)) - 1, plotRect.y, 3, 4)
		}

		// 选择区（两游标之间）
		const sel = View.selection(view.cursorA, view.cursorB, total)
		if (sel) {
			const x0 = xOf(sel.a)
			const x1 = xOf(sel.b)
			g.fillStyle = colBand
			g.fillRect(x0, plotRect.y, Math.max(1, x1 - x0), plotRect.h)
		}
		g.restore()

		// 游标线
		const drawCursor = function (li, label) {
			if (li == null) return
			const x = xOf(li)
			if (x < plotRect.x - 1 || x > plotRect.x + plotRect.w + 1) return
			g.strokeStyle = colText
			g.lineWidth = 1
			g.setLineDash([4, 3])
			g.beginPath()
			g.moveTo(Math.round(x) + 0.5, plotRect.y)
			g.lineTo(Math.round(x) + 0.5, plotRect.y + plotRect.h)
			g.stroke()
			g.setLineDash([])
			g.fillStyle = colText
			g.font = '10px ' + cssVar('--font-mono', 'monospace')
			g.textBaseline = 'top'
			g.fillText(label, Math.round(x) + 3, plotRect.y + 2)
		}
		drawCursor(view.cursorA, 'A')
		drawCursor(view.cursorB, 'B')

		// 触发点标记
		if (trigUI.mode !== 'off' && trig.lockLi != null && !trigUserOverride) {
			const x = xOf(trig.lockLi)
			if (x >= plotRect.x && x <= plotRect.x + plotRect.w) {
				g.fillStyle = colTrace
				g.beginPath()
				g.moveTo(x - 4, plotRect.y)
				g.lineTo(x + 4, plotRect.y)
				g.lineTo(x, plotRect.y + 7)
				g.closePath()
				g.fill()
			}
		}

		// 框选中的橡皮筋
		if (drag && drag.kind === 'box' && drag.current != null) {
			const x0 = xOf(drag.anchor)
			const x1 = xOf(drag.current)
			g.fillStyle = colBand
			g.fillRect(Math.min(x0, x1), plotRect.y, Math.abs(x1 - x0), plotRect.h)
			g.strokeStyle = colTrace
			g.setLineDash([3, 3])
			g.strokeRect(Math.min(x0, x1) + 0.5, plotRect.y + 0.5, Math.abs(x1 - x0), plotRect.h - 1)
			g.setLineDash([])
		}

		// ---- 轴标注 ----
		g.fillStyle = colText
		g.font = '10px ' + cssVar('--font-mono', 'monospace')
		g.textAlign = 'right'
		g.textBaseline = 'middle'
		for (let i = 0; i < shownY.length; i++) {
			g.fillText(fmt.fmtCurrent(shownY[i].v), marginLeft - 6, shownY[i].y)
		}
		g.textAlign = 'left'
		g.textBaseline = 'bottom'
		g.fillText('+' + fmtTime(span * period), plotRect.x, h - 3)
		g.textAlign = 'center'
		g.fillText(fmtTime((span * period) / 2), plotRect.x + plotRect.w / 2, h - 3)
		g.textAlign = 'right'
		g.fillText('0', plotRect.x + plotRect.w, h - 3)
		g.textAlign = 'left'
		g.textBaseline = 'top'
		const modeLabel = 'Y ' + tr('ui.ymode_' + view.yMode) + (view.yZoom !== 1 ? ' ×' + view.yZoom.toFixed(1) : '') +
			' · X ' + view.xZoom.toFixed(view.xZoom < 1 ? 3 : 1) + '×' + (view.live ? ' · Live' : '') +
			(trig.lockLi != null && !trigUserOverride && trigUI.mode !== 'off' ? ' · trig ' + trigUI.mode : '')
		g.fillText(modeLabel, marginLeft + 4, plotRect.y + 2)

		// ---- 周期叠画（右下角内嵌） ----
		if (show.cycles && analysis.pack && analysis.pack.cycles && analysis.pack.cycles.cycles.length) {
			drawCycleInset(g, analysis.pack.cycles, colTrace, colBand, colText, colBorder)
		}

		drawMinimap()
	}

	function drawCycleInset(g, cycles, colTrace, colBand, colText, colBorder) {
		const n = cycles.cycles.length
		const pts = cycles.periodPts
		if (!n || !pts) return
		const w = Math.min(230, Math.max(120, plotRect.w * 0.3))
		const h = Math.min(110, Math.max(64, plotRect.h * 0.34))
		const x0 = plotRect.x + plotRect.w - w - 8
		const y0 = plotRect.y + plotRect.h - h - 8
		let lo = Infinity
		let hi = -Infinity
		for (let c = 0; c < n; c++) {
			const arr = cycles.cycles[c]
			for (let i = 0; i < arr.length; i++) {
				if (arr[i] < lo) lo = arr[i]
				if (arr[i] > hi) hi = arr[i]
			}
		}
		if (!(hi > lo)) return
		const pad = (hi - lo) * 0.1 || 1
		lo -= pad
		hi += pad
		const yOf = function (v) { return y0 + h - ((v - lo) / (hi - lo)) * h }
		const xOf = function (i) { return x0 + (i / Math.max(1, pts - 1)) * w }
		g.fillStyle = colBand
		g.fillRect(x0, y0, w, h)
		g.strokeStyle = colBorder
		g.lineWidth = 1
		g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1)
		g.strokeStyle = colTrace
		g.globalAlpha = 0.32
		for (let c = 0; c < n; c++) {
			const arr = cycles.cycles[c]
			g.beginPath()
			for (let i = 0; i < arr.length; i++) {
				const x = xOf(i)
				const y = yOf(arr[i])
				if (i === 0) g.moveTo(x, y)
				else g.lineTo(x, y)
			}
			g.stroke()
		}
		g.globalAlpha = 1
		g.strokeStyle = colTrace
		g.lineWidth = 1.5
		g.beginPath()
		const mean = cycles.mean
		for (let i = 0; i < mean.length; i++) {
			const x = xOf(i)
			const y = yOf(mean[i])
			if (i === 0) g.moveTo(x, y)
			else g.lineTo(x, y)
		}
		g.stroke()
		g.fillStyle = colText
		g.font = '10px ' + cssVar('--font-mono', 'monospace')
		g.textBaseline = 'top'
		g.textAlign = 'left'
		g.fillText(tr('ui.cycles_overlay', { n: n, pts: pts }), x0 + 4, y0 + 3)
		g.textAlign = 'right'
		g.textBaseline = 'bottom'
		g.fillText(fmt.fmtCurrent(hi) + ' / ' + fmt.fmtCurrent(lo), x0 + w - 4, y0 + h - 3)
	}

	/** 总览条：波形模式用分桶包络，长期模式用 FoldingBuffer 的点 */
	function drawMinimap() {
		const cv = $('minimap')
		if (!cv || !wave || !control) return
		const lat = canvasLayout(cv)
		const g = lat.g
		if (!g) return
		const w = lat.w
		const h = lat.h
		const colBg = cssVar('--bg-surface', '#ffffff')
		const colTrace = cssVar('--accent', '#1f5fbf')
		const colBand = cssVar('--accent-light', 'rgba(31,95,191,0.08)')
		const colText = cssVar('--text-muted', '#6b7487')
		const colBorder = cssVar('--border-color', 'rgba(17,24,39,0.12)')
		g.clearRect(0, 0, w, h)
		g.fillStyle = colBg
		g.fillRect(0, 0, w, h)
		const longMode = control.state().recordMode === 'long'
		const total = longMode ? 0 : wave.total()
		if (longMode) {
			const data = control.minimapData()
			if (data.length < 2) {
				g.fillStyle = colText
				g.font = '10px ' + cssVar('--font-sans', 'sans-serif')
				g.textBaseline = 'middle'
				g.textAlign = 'center'
				g.fillText(tr('ui.mm_no_long'), w / 2, h / 2)
				return
			}
			let xMin = data[0].x
			let xMax = data[0].x
			let yMin = data[0].y
			let yMax = data[0].y
			for (let i = 1; i < data.length; i++) {
				if (data[i].x < xMin) xMin = data[i].x
				if (data[i].x > xMax) xMax = data[i].x
				if (data[i].y < yMin) yMin = data[i].y
				if (data[i].y > yMax) yMax = data[i].y
			}
			if (!(xMax > xMin)) xMax = xMin + 1
			if (!(yMax > yMin)) yMax = yMin + 1
			g.strokeStyle = colTrace
			g.globalAlpha = 0.85
			g.lineWidth = 1
			g.beginPath()
			for (let i = 0; i < data.length; i++) {
				const x = ((data[i].x - xMin) / (xMax - xMin)) * (w - 1)
				const y = h - 2 - ((data[i].y - yMin) / (yMax - yMin)) * (h - 4)
				if (i === 0) g.moveTo(x, y)
				else g.lineTo(x, y)
			}
			g.stroke()
			g.globalAlpha = 1
			g.fillStyle = colText
			g.font = '10px ' + cssVar('--font-mono', 'monospace')
			g.textBaseline = 'top'
			g.textAlign = 'left'
			g.fillText(tr('ui.mm_long', { n: fmtCount(control.longStats().n) }), 6, 3)
			return
		}
		if (total < 2) {
			g.fillStyle = colText
			g.font = '10px ' + cssVar('--font-sans', 'sans-serif')
			g.textBaseline = 'middle'
			g.textAlign = 'center'
			g.fillText(tr('ui.mm_label'), w / 2, h / 2)
			return
		}
		const bs = wave.computeBucketSize(total, Math.max(1, Math.floor(w)))
		const lastBucket = Math.floor((total - 1) / bs)
		let lo = Infinity
		let hi = -Infinity
		const cols = []
		for (let bi = 0; bi <= lastBucket; bi++) {
			const e = wave.bucketEntry(bi, bs, 0, total - 1)
			if (!e) continue
			cols.push(e)
			if (e.min < lo) lo = e.min
			if (e.max > hi) hi = e.max
		}
		if (!cols.length || !(hi >= lo)) {
			g.fillStyle = colText
			g.textAlign = 'center'
			g.textBaseline = 'middle'
			g.font = '10px ' + cssVar('--font-sans', 'sans-serif')
			g.fillText(tr('ui.mm_label'), w / 2, h / 2)
			return
		}
		const pad = (hi - lo) * 0.08 || 1
		lo -= pad
		hi += pad
		const yOf = function (v) { return h - 2 - ((v - lo) / (hi - lo)) * (h - 4) }
		g.strokeStyle = colTrace
		g.globalAlpha = 0.8
		g.lineWidth = 1
		g.beginPath()
		for (let i = 0; i < cols.length; i++) {
			const e = cols[i]
			const x = (e.loAbs / Math.max(1, total - 1)) * (w - 1)
			g.moveTo(x, yOf(e.max))
			g.lineTo(x, yOf(e.min))
		}
		g.stroke()
		g.globalAlpha = 1
		// 视口框
		const range = currentRange()
		const rect = View.minimapViewRect({ width: w, total: total, range: range })
		g.fillStyle = colBand
		g.fillRect(rect.x0, 0, rect.w, h)
		g.strokeStyle = colTrace
		g.strokeRect(rect.x0 + 0.5, 0.5, rect.w, h - 1)
		g.fillStyle = colText
		g.font = '10px ' + cssVar('--font-mono', 'monospace')
		g.textBaseline = 'top'
		g.textAlign = 'left'
		g.fillText(tr('ui.mm_session', { n: fmtCount(total) }), 6, 3)
		g.textAlign = 'right'
		g.fillText(tr('ui.mm_cold', { bytes: fmtBytes(store.getRawUsed()) }), w - 6, 3)
		void colBorder
	}

	function scheduleDraw() {
		if (drawQueued) return
		drawQueued = true
		requestAnimationFrame(function () {
			drawQueued = false
			drawWave()
		})
	}

	function startDrawLoop() {
		if (rafId) return
		const tick = function () {
			rafId = 0
			drawWave()
			if (control && control.isSampling()) rafId = requestAnimationFrame(tick)
		}
		rafId = requestAnimationFrame(tick)
	}

	// ---------- 面板渲染 ----------
	function updateGapChip() {
		const gaps = wave ? wave.gaps().length : 0
		const dropped = wave ? wave.droppedSamples() : 0
		const chip = $('chip-gaps')
		chip.textContent = tr('ui.chip_gaps', { n: gaps })
		chip.dataset.state = gaps > 0 ? 'warn' : 'off'
		setText('st-gaps', String(gaps) + (dropped > 0 ? tr('ui.dropped_suffix', { n: fmtCount(dropped) }) : ''))
		$('st-gaps').dataset.warn = gaps > 0 ? '1' : '0'
	}

	function renderSessionPanel() {
		if (!control) return
		const st = control.state()
		const summary = control.captureSummary()
		setText('st-duration', fmt.fmtDuration(summary.durationSec))
		setText('st-rate', st.targetRateHz > 0 ? fmtCount(st.targetRateHz) + ' Hz' : '—')
		setText('st-samples', fmtCount(summary.totalSamples) + (summary.retainedSamples !== summary.totalSamples ? tr('ui.kept_suffix', { n: fmtCount(summary.retainedSamples) }) : ''))
		setText('st-energy', summary.energyUWh == null ? tr('ui.na') : fmt.fmtEnergy(summary.energyUWh))
		setText('st-charge', fmt.fmtCharge(summary.chargeUC))
		const srcKey = 'ui.source_' + st.powered.source
		const src = I18N.has(srcKey) ? tr(srcKey) : st.powered.source
		setText('st-power', st.powered.state === 'on' ? tr('ui.power_on', { source: src }) : (st.powered.state === 'off' ? tr('ui.power_off', { source: src }) : tr('ui.power_unknown')))
		$('btn-power').setAttribute('aria-pressed', String(st.powered.state === 'on'))
		$('btn-power').textContent = tr(st.powered.state === 'on' ? 'ui.btn_dut_off' : 'ui.btn_dut_on')
		updateGapChip()
		updateSampleButton()

		const acq = control.acqState()
		if (acq && acq.waiting) {
			$('chip-trigger').dataset.state = 'warn'
			$('chip-trigger').textContent = tr('ui.chip_waiting_edge', { edge: tr('ui.edge_' + acq.start) })
		}

		const total = totalSamples()
		if (total > 0) {
			const range = currentRange()
			applyRangeState(range)
			const win = wave.stats(range.start, range.end + 1)
			viewStatsCache = { start: range.start, end: range.end, stats: win }
			setText('win-start', fmtCount(range.start))
			setText('win-mean', fmt.fmtCurrent(win.avgI))
			setText('win-range', fmt.fmtCurrent(win.minI) + ' / ' + fmt.fmtCurrent(win.maxI))
			setText('ro-current', fmt.fmtCurrent(win.avgI))
			setText('ro-power', win.avgP == null ? tr('ui.na_no_voltage') : fmt.fmtPower(win.avgP))
			setText('ro-samples', fmtCount(summary.retainedSamples))
			const span = range.count > 1 ? (range.count - 1) * control.getSamplePeriodSec() : 0
			setText('scope-meta', tr('ui.scope_meta', { n: fmtCount(range.count), dur: fmt.fmtDuration(span), state: tr(view.live ? 'ui.live' : 'ui.paused') }))
		} else {
			viewStatsCache = null
			setText('win-start', '0')
			setText('win-mean', '—')
			setText('win-range', '—')
			setText('ro-current', '0 µA')
			setText('ro-power', '0 µW')
			setText('ro-samples', '0')
			setText('scope-meta', tr('ui.no_data'))
		}
		setText('ro-voltage', st.voltageMv == null ? '—' : String(st.voltageMv))
		$('scope-empty').style.display = total > 0 ? 'none' : 'flex'
		renderCursorPanel()
		refreshAnalysis(false)
	}

	function updateStoragePanel() {
		if (!store || !wave) return
		setText('store-raw', fmtBytes(store.getRawUsed()))
		setText('store-comp', fmtBytes(store.getCompressedUsed()))
		setText('store-blocks', String(store.blockCount()))
		setText('store-caps', tr('ui.store_caps', { cold: fmtBytes(store.getCapBytes()), hot: fmtBytes(wave.ramCap() * 4) }))
		setText('store-meta', tr(StoreMod.compressionSupported() ? 'ui.store_deflate' : 'ui.store_uncompressed'))
		setText('export-meta', tr('ui.export_limit', { bytes: fmtBytes(ExportMod.MAX_EXPORT_BYTES) }))
	}

	// ---------- 游标读数 ----------
	// 游标读数走精确路径（等冷块回读）：用序号丢弃过期结果
	let cursorSeq = 0
	function renderCursorPanel() {
		const total = totalSamples()
		const per = control ? control.getSamplePeriodSec() : 0
		const sel = View.selection(view.cursorA, view.cursorB, total)
		if (!sel || total < 2) {
			setText('cur-a', view.cursorA == null ? '—' : String(view.cursorA))
			setText('cur-b', view.cursorB == null ? '—' : String(view.cursorB))
			setText('cur-dt', '—')
			setText('cur-mean', '—')
			setText('cur-charge', '—')
			setText('cur-energy', '—')
			return
		}
		const seq = ++cursorSeq
		Panels.measureCursorsExact(wave, sel.a, sel.b, { samplePeriodSec: per }).then(function (m) {
			if (seq !== cursorSeq || !m || m.aborted) return
			// 端点电流只用真值：冷块未回读 / 已淘汰就显示 "—"，不拿近似值冒充实测
			setText('cur-a', sel.a + ' · ' + (m.iA == null ? '—' : fmt.fmtCurrent(m.iA)))
			setText('cur-b', sel.b + ' · ' + (m.iB == null ? '—' : fmt.fmtCurrent(m.iB)))
			if (!m.complete) {
				// 回读不完整 / 有淘汰：不显示近似读数
				const why = m.missing > 0 ? tr('ui.cur_unavailable', { n: fmtCount(m.missing) })
					: (m.dropped > 0 ? tr('ui.cur_evicted', { n: fmtCount(m.dropped) }) : tr('ui.cur_incomplete'))
				setText('cur-dt', '— (' + why + ')')
				setText('cur-mean', '—')
				setText('cur-charge', '—')
				setText('cur-energy', '—')
				$('cur-dt').dataset.warn = '1'
				return
			}
			setText('cur-dt', fmt.fmtDuration(m.wallSec) + ' / ' + fmt.fmtDuration(m.durSec) + (m.gaps ? tr('ui.gaps_suffix', { n: m.gaps }) : ''))
			setText('cur-mean', fmt.fmtCurrent(m.avgI) + ' · ' + fmt.fmtCurrent(m.minI) + ' / ' + fmt.fmtCurrent(m.maxI))
			setText('cur-charge', fmt.fmtCharge(m.chargeUC))
			setText('cur-energy', m.energyUWh == null ? tr('ui.na_no_voltage') : fmt.fmtEnergy(m.energyUWh))
			$('cur-dt').dataset.warn = (m.gaps > 0 || m.voltsUnknown) ? '1' : '0'
		}).catch(function (e) {
			if (seq !== cursorSeq) return
			log(M('app.cursor_failed', { err: (e && e.message ? e.message : e) }), 'warn')
		})
	}

	// ---------- 分析 ----------
	function analysisPackKey(range) {
		return [analysis.source, range ? range.a : '-', range ? range.b : '-', control ? control.getSamplePeriodSec() : 0,
			control ? control.state().voltageMv : '-', settings.capacityMah, show.fft, show.battery, show.cycles].join('|')
	}

	let analysisSeq = 0
	async function refreshAnalysis(force) {
		if (!wave || !control) return
		const total = totalSamples()
		const range = Panels.pickRange({
			mode: analysis.source,
			total: total,
			selection: View.selection(view.cursorA, view.cursorB, total),
			viewRange: currentRange(),
		})
		const key = analysisPackKey(range)
		if (!force && key === analysis.key && analysis.pack) return
		analysis.key = key
		if (!range) {
			analysis.pack = null
			renderAnalysisPanel(null)
			return
		}
		// 分析要等冷块回读（真实样点），因此是异步的：用序号丢弃过期的结果
		const seq = ++analysisSeq
		const pack = await Panels.buildPack({
			wave: wave,
			range: range,
			samplePeriodSec: control.getSamplePeriodSec(),
			capacityMah: settings.capacityMah,
			fft: show.fft,
			cycles: show.cycles,
			segments: true,
			spikes: true,
		})
		if (seq !== analysisSeq) return
		if (pack && pack.aborted) {
			// 会话在分析途中变了（清空 / 重新采集 / 导入）：这次结果直接作废
			analysis.pack = null
			renderAnalysisPanel(null)
			return
		}
		analysis.pack = pack
		renderAnalysisPanel(pack)
	}

	function scheduleAnalysis(force) {
		if (analysis.timer) clearTimeout(analysis.timer)
		analysis.timer = setTimeout(function () {
			analysis.timer = 0
			refreshAnalysis(!!force)
		}, 120)
	}

	function renderAnalysisPanel(pack) {
		const set = setText
		if (!pack) {
			set('an-meta', tr('ui.an_no_range'))
			;['an-avg', 'an-range', 'an-rms', 'an-levels', 'an-period', 'an-freq', 'an-qcycle', 'an-events'].forEach(function (id) { set(id, '—') })
			set('an-gaps', '0')
			set('an-fft-meta', '—')
			$('an-fft').textContent = ''
			set('an-battery', '—')
			set('an-cycles-meta', '—')
			return
		}
		const incomplete = !!pack.incomplete || pack.complete === false
		// partial：分析样本被抽稀 / 只取了最长段 / 超出容量；必须在界面上说清楚
		const partial = !!pack.partial
		const srcLabel = I18N.has('ui.an_source_' + pack.source) ? tr('ui.an_source_' + pack.source) : String(pack.source)
		const metaBits = [srcLabel, tr('ui.an_pts', { n: fmtCount(pack.nRaw) }), pack.step > 1 ? '1/' + pack.step : tr('ui.an_full'), fmt.fmtDuration(pack.periodSec * (pack.nRaw - 1))]
		if (partial) metaBits.push(tr('ui.an_partial'))
		set('an-meta', metaBits.join(' · '))
		$('an-meta').dataset.warn = (incomplete || partial) ? '1' : '0'
		if (incomplete) {
			// 有样点读不到或被淘汰：不拿部分样点冒充整个区间的读数
			const why = pack.unavailableReason === 'samples_unavailable'
				? tr('ui.an_unreadable', { n: fmtCount(pack.missing || 0) })
				: (pack.unavailableReason === 'samples_evicted'
					? tr('ui.an_evicted', { n: fmtCount(pack.dropped || 0) })
					: tr('ui.an_discontinuous'))
			;['an-avg', 'an-range', 'an-rms', 'an-levels', 'an-period', 'an-freq', 'an-qcycle', 'an-events'].forEach(function (id) { set(id, '—') })
			set('an-meta', tr('ui.an_incomplete', { source: srcLabel, why: why }))
			$('an-gaps').textContent = why
			$('an-gaps').dataset.warn = '1'
			set('an-fft-meta', tr('ui.an_unavailable_incomplete'))
			$('an-fft').textContent = ''
			set('an-battery', '—')
			set('an-cycles-meta', tr('ui.an_unavailable_incomplete'))
			return
		}
		const b = pack.basic || {}
		set('an-avg', fmt.fmtCurrent(b.avg))
		set('an-range', fmt.fmtCurrent(b.min) + ' / ' + fmt.fmtCurrent(b.max))
		set('an-rms', fmt.fmtCurrent(b.rms) + ' / ' + fmt.fmtCurrent(b.pp))
		const lv = pack.levels || {}
		set('an-levels', (lv.lowAvg != null ? fmt.fmtCurrent(lv.lowAvg) : '—') + ' / ' + (lv.highAvg != null ? fmt.fmtCurrent(lv.highAvg) : '—') +
			(lv.duty != null ? ' · ' + fmt.fmtPercent(lv.duty) : ''))
		const ed = pack.edges || {}
		set('an-period', (ed.periodSec != null ? fmt.fmtDuration(ed.periodSec) + ' · n=' + ed.nPeriod : '—') + ' / ' + (ed.duty != null ? fmt.fmtPercent(ed.duty) : '—'))
		set('an-freq', ed.freqHz != null ? fmt.fmtFreq(ed.freqHz) : '—')
		set('an-qcycle', pack.qCycle != null ? fmt.fmtCharge(pack.qCycle) : '—')
		const sp = pack.spikes ? pack.spikes.length : 0
		const sg = pack.segmentList ? pack.segmentList.length : 0
		set('an-events', tr('ui.an_events', { spikes: sp, segments: sg }))
		const msr = pack.measure || { gaps: 0, gapRatio: 0, dropped: 0 }
		set('an-gaps', String(msr.gaps) + (pack.dropped ? tr('ui.an_gaps_evicted', { n: fmtCount(pack.dropped) }) : '') +
			(pack.missing ? tr('ui.an_gaps_unavailable', { n: fmtCount(pack.missing) }) : '') +
			(msr.gaps ? tr('ui.an_gaps_ratio', { ratio: fmt.fmtPercent(msr.gapRatio) }) : ''))
		$('an-gaps').dataset.warn = (msr.gaps > 0 || pack.missing > 0 || pack.dropped > 0) ? '1' : '0'
		// FFT
		if (show.fft) {
			const f = pack.fft
			const list = $('an-fft')
			list.textContent = ''
			if (!f || f.ok === false) {
				set('an-fft-meta', f && f.reason ? reasonText(f.reason) : tr('ui.na'))
			} else {
				set('an-fft-meta', tr('ui.fft_meta', { n: fmtCount(f.nfft), bin: fmt.fmtFreq(f.binHz), window: f.window || 'hann' }))
				const peaks = (f.peaks || []).slice(0, 6)
				peaks.forEach(function (p, i) {
					const li = document.createElement('li')
					li.textContent = fmt.fmtFreq(p.freqHz) + ' · ' + fmt.fmtCurrent(p.magUA)
					if (i === 0) li.dataset.top = '1'
					list.appendChild(li)
				})
				if (!peaks.length) set('an-fft-meta', tr('ui.fft_no_peaks'))
			}
		}
		// Battery
		if (show.battery) {
			const bat = pack.battery
			set('an-battery', bat && bat.ok
				? tr('ui.battery_life', { dur: fmt.fmtDuration(bat.hours * 3600), current: fmt.fmtCurrent(bat.avgUA), cap: bat.capacityMah, derate: bat.derate })
				: (bat && bat.reason ? reasonText(bat.reason) : tr('ui.na')))
		}
		// Cycles
		if (show.cycles) {
			const cy = pack.cycles
			set('an-cycles-meta', cy && cy.nCycles ? tr('ui.cycles_overlay', { n: cy.nCycles, pts: cy.periodPts }) : tr('ui.no_period'))
		}
	}

	// ---------- 导出 ----------
	async function doExport(kind) {
		if (!wave || wave.total() === 0) {
			log(M('app.export_nothing'), 'warn')
			return
		}
		const hint = $('export-hint')
		let r
		if (kind === 'summary') {
			r = await exportSvc.exportSummary()
		} else if (kind === 'view') {
			const range = currentRange()
			r = await exportSvc.exportRange(range.start, range.end + 1, { name: 'power-window.csv' })
		} else {
			r = await exportSvc.exportRange(0, wave.total(), { name: 'power-session.csv' })
		}
		if (!r || !r.ok) {
			const msg = (r && (r.ref || r.message)) || M('app.export_failed')
			setHintFn('export-hint', function () { return String(msg) })
			hint.dataset.warn = '1'
			log(M('app.export_refused', { why: msg }), 'error')
			return
		}
		hint.dataset.warn = '0'
		setHintFn('export-hint', function () { return tr('ui.export_saved', { name: r.name, size: r.bytes ? tr('ui.size_suffix', { bytes: fmtBytes(r.bytes) }) : '' }) })
	}

	// ---------- CSV 导入（本地文件，不发网络请求） ----------
	async function importCsvFile() {
		const input = $('import-file')
		const hint = $('import-hint')
		const file = input && input.files && input.files[0]
		if (!file) {
			setHintFn('import-hint', function () { return tr('ui.choose_csv') })
			hint.dataset.warn = '1'
			return
		}
		try {
			const text = await readFileText(file)
			const parsed = ImportMod.parseCsv(text)
			const sum = ImportMod.summarize(parsed)
			if (!parsed.ok) {
				setHintFn('import-hint', function () { return ImportMod.summarize(parsed).text })
				hint.dataset.warn = '1'
				log(M('app.import_failed', { why: reasonMsg(parsed.reason) }), 'error')
				return
			}
			if (control.isSampling()) {
				const sr = await control.stopCapture()
				if ((!sr || !sr.ok) && control.isSampling()) {
					const swhy = opWhy(sr)
					setHintFn('import-hint', function () { return tr('app.import_stop_failed', { why: swhy }) })
					hint.dataset.warn = '1'
					log(M('app.import_stop_failed', { why: swhy }), 'error')
					return
				}
				if (!sr || !sr.ok) log(M('app.stop_result', { why: opWhy(sr) }), 'error')
			}
			const res = await control.importSeries(parsed)
			if (!res || !res.ok) {
				// 装不下就如实说不完整（实际 N / 请求 M），不能报完整成功
				const why = (res && (res.ref || res.message)) || M('ui.unknown')
				setHintFn('import-hint', function () { return tr('ui.import_incomplete_hint', { why: why }) })
				hint.dataset.warn = '1'
				log(M('app.import_partial', { why: why }), 'warn')
				hostLog('csv import incomplete: ' + why)
				if (res && res.stored) {
					// 已经写进去的部分照样可以看，只是要标清楚是不完整的导入
					view.live = true
					view.xOffset = 0
					view.cursorA = null
					view.cursorB = null
					renderSessionPanel()
					updateStoragePanel()
					updateGapChip()
					scheduleDraw()
				}
				return
			}
			// 导入的会话从零开始：视图、游标、触发、分析全都重置
			if (laneTrack) laneTrack.reset()
			view.live = true
			view.xOffset = 0
			view.xZoom = 1
			view.cursorA = null
			view.cursorB = null
			View.resetScopeTrigger(trig)
			trigScanFrom = null
			analysis.pack = null
			analysis.key = ''
			edgeCache = { key: '', edges: null }
			viewStatsCache = null
			// 提示按**实际结果**拼，不用解析出的行数冒充导入成功
			// 提示存成可重绘的函数：切语言时按新语言重新拼
			const skipped = parsed.skipped
			setHintFn('import-hint', function () {
				const bits = [tr('ui.import_rows', { n: res.samples, requested: res.requested })]
				bits.push(res.samplePeriodSec > 0 ? Math.round(1 / res.samplePeriodSec) + ' Hz' : tr('ui.no_time_column'))
				if (res.estimatedPeriod) bits.push(tr('ui.period_estimated'))
				if (res.gaps) bits.push(tr('ui.gaps_count', { n: res.gaps }))
				if (skipped) bits.push(tr('ui.rows_skipped', { n: skipped }))
				if (res.voltsMixed) bits.push(tr('ui.mixed_voltage_sample'))
				if (!res.hasVoltage) bits.push(tr('ui.no_voltage_energy'))
				return bits.join(' · ')
			})
			hint.dataset.warn = (!res.hasVoltage || res.estimatedPeriod) ? '1' : '0'
			void sum
			hostLog('imported ' + res.samples + ' samples from ' + file.name)
			renderSessionPanel()
			updateStoragePanel()
			updateGapChip()
			scheduleDraw()
		} catch (e) {
			const ierr = (e && e.message ? e.message : e)
			setHintFn('import-hint', function () { return tr('ui.import_failed_hint', { err: ierr }) })
			hint.dataset.warn = '1'
			log(M('app.import_error', { err: (e && e.message ? e.message : e) }), 'error')
		}
	}

	/** 读本地文件：优先 FileReader（sandbox 里 file.text() 不一定有），失败退回 text() */
	function readFileText(file) {
		if (typeof FileReader === 'function') {
			return new Promise(function (resolve, reject) {
				const fr = new FileReader()
				fr.onload = function () { resolve(String(fr.result == null ? '' : fr.result)) }
				fr.onerror = function () { reject(fr.error || new Error('read failed')) }
				fr.readAsText(file)
			})
		}
		if (typeof file.text === 'function') return file.text()
		return Promise.reject(new Error(tr('app.no_file_reader')))
	}

	// ---------- 交互 ----------
	function canvasPoint(ev) {
		const cv = $('wave')
		const rect = cv.getBoundingClientRect()
		return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
	}

	function plotX(px) {
		return px - plotRect.x
	}

	function inPlot(p) {
		return p.x >= plotRect.x && p.x <= plotRect.x + plotRect.w && p.y >= plotRect.y && p.y <= plotRect.y + plotRect.h
	}

	function indexAtPx(px) {
		const range = currentRange()
		return View.pixelToIndex(Math.max(0, Math.min(plotRect.w - 1, px)), range, plotRect.w)
	}

	function pxOfIndex(li) {
		return View.indexToPixel(li, currentRange(), plotRect.w)
	}

	/** 吸附到最近的沿（视图内），阈值按像素折算 */
	function snapIndex(li, snapPx) {
		const total = totalSamples()
		if (total < 3) return li
		const range = currentRange()
		const key = range.start + ':' + range.end
		if (edgeCache.key !== key) {
			edgeCache = {
				key: key,
				edges: Panels.findEdges(wave, range.start, range.end, { samplePeriodSec: control.getSamplePeriodSec() }),
			}
		}
		const ed = edgeCache.edges
		if (!ed) return li
		const all = ed.rises.concat(ed.falls)
		if (!all.length) return li
		const pxPerPt = plotRect.w / Math.max(1, range.count - 1)
		const maxPts = Math.max(1, (snapPx || 6) / Math.max(1e-6, pxPerPt))
		let best = li
		let bestD = maxPts
		for (let i = 0; i < all.length; i++) {
			const d = Math.abs(all[i] - li)
			if (d <= bestD) { bestD = d; best = all[i] }
		}
		return best
	}

	function bindCanvas() {
		const cv = $('wave')
		cv.addEventListener('pointerdown', function (ev) {
			if (ev.button !== 0) return
			if (totalSamples() < 2) return
			cv.focus()
			const p = canvasPoint(ev)
			const px = plotX(p.x)
			// Y 轴区域：拖动 = Y 平移
			if (p.x < plotRect.x) {
				drag = { kind: 'y', lastY: p.y }
			} else {
				const xa = view.cursorA == null ? null : pxOfIndex(view.cursorA)
				const xb = view.cursorB == null ? null : pxOfIndex(view.cursorB)
				const hit = View.cursorHit(px, xa, xb)
				if (hit) {
					drag = { kind: 'cursor', which: hit }
				} else if (ev.shiftKey || ev.altKey) {
					drag = { kind: 'box', anchor: indexAtPx(px), current: null, startX: px }
				} else {
					drag = { kind: 'pan', lastX: px, moved: 0 }
				}
			}
			try { cv.setPointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
			ev.preventDefault()
			scheduleDraw()
		})

		cv.addEventListener('pointermove', function (ev) {
			if (!drag) return
			const p = canvasPoint(ev)
			const px = plotX(p.x)
			if (drag.kind === 'pan') {
				const d = px - drag.lastX
				drag.lastX = px
				drag.moved += Math.abs(d)
				if (drag.moved > C.DRAG_THRESHOLD_PX) {
					const r = View.panByPixels({ total: totalSamples(), xZoom: view.xZoom, xOffset: view.xOffset, deltaPx: d, plotWidth: plotRect.w })
					view.xOffset = r.xOffset
					markUserView()
				}
			} else if (drag.kind === 'box') {
				drag.current = indexAtPx(px)
			} else if (drag.kind === 'cursor') {
				const li = snapIndex(indexAtPx(px), 6)
				if (drag.which === 'a') view.cursorA = li
				else view.cursorB = li
				renderCursorPanel()
			} else if (drag.kind === 'y') {
				const dy = p.y - drag.lastY
				drag.lastY = p.y
				view.yPan += (dy / Math.max(1, plotRect.h)) * (2 / view.yZoom)
				view.yPan = Math.max(-4, Math.min(4, view.yPan))
				viewStatsCache = null
			}
			scheduleDraw()
			ev.preventDefault()
		})

		function endDrag(ev) {
			if (!drag) return
			const finished = drag
			drag = null
			try { cv.releasePointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
			if (finished.kind === 'box') {
				const cur = indexAtPx(plotX(canvasPoint(ev).x))
				const sel = View.boxSelect(finished.anchor, cur, totalSamples())
				if (sel && sel.b - sel.a >= 2) {
					view.cursorA = sel.a
					view.cursorB = sel.b
					// 框选 = 放大到该区间
					const n = sel.b - sel.a + 1
					view.xZoom = View.clampXZoom(C.DEFAULT_VIEW_POINTS / n, control.getSamplePeriodSec())
					const c = View.centerOnIndex({ total: totalSamples(), xZoom: view.xZoom, index: Math.round((sel.a + sel.b) / 2) })
					view.xOffset = c.xOffset
					markUserView()
					log(M('app.box_zoom', { a: sel.a, b: sel.b, n: n }))
				}
			}
			renderCursorPanel()
			scheduleAnalysis(true)
			scheduleDraw()
		}
		cv.addEventListener('pointerup', endDrag)
		cv.addEventListener('pointercancel', function (ev) {
			drag = null
			try { cv.releasePointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
			scheduleDraw()
		})

		cv.addEventListener('wheel', function (ev) {
			if (totalSamples() < 2) return
			ev.preventDefault()
			const p = canvasPoint(ev)
			const overYAxis = p.x < plotRect.x
			const dir = ev.deltaY < 0 ? 1 : -1
			if (overYAxis || ev.shiftKey) {
				const factor = dir > 0 ? 1.25 : 0.8
				view.yZoom = Math.max(C.Y_ZOOM_MIN, Math.min(C.Y_ZOOM_MAX, view.yZoom * factor))
				viewStatsCache = null
			} else {
				const factor = dir > 0 ? 1.6 : 0.625
				const r = View.zoomAtPoint({
					total: totalSamples(),
					xZoom: view.xZoom,
					xOffset: view.xOffset,
					live: view.live,
					plotWidth: plotRect.w,
					pixel: Math.max(0, plotX(p.x)),
					factor: factor,
					periodSec: control.getSamplePeriodSec(),
				})
				view.xZoom = r.xZoom
				view.xOffset = r.xOffset
				markUserView()
			}
			scheduleDraw()
			renderSessionPanel()
		}, { passive: false })

		cv.addEventListener('dblclick', function (ev) {
			ev.preventDefault()
			resetView()
		})

		// 总览条：点击 / 拖动定位
		const mm = $('minimap')
		let mmDrag = false
		function mmSeek(ev) {
			if (totalSamples() < 2) return
			const rect = mm.getBoundingClientRect()
			const px = Math.max(0, Math.min(rect.width, ev.clientX - rect.left))
			const center = View.minimapSeekIndex({ width: rect.width, px: px, total: totalSamples() })
			const c = View.centerOnIndex({ total: totalSamples(), xZoom: view.xZoom, index: center })
			view.xOffset = c.xOffset
			markUserView()
			scheduleDraw()
			renderSessionPanel()
		}
		mm.addEventListener('pointerdown', function (ev) {
			if (ev.button !== 0) return
			mmDrag = true
			mmSeek(ev)
			ev.preventDefault()
		})
		mm.addEventListener('pointermove', function (ev) { if (mmDrag) mmSeek(ev) })
		mm.addEventListener('pointerup', function () { mmDrag = false })
		mm.addEventListener('pointercancel', function () { mmDrag = false })
	}

	function isEditableTarget(el) {
		if (!el) return false
		const tag = (el.tagName || '').toUpperCase()
		return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
	}

	function bindKeys() {
		window.addEventListener('keydown', function (ev) {
			if (isEditableTarget(ev.target)) return
			const total = totalSamples()
			const per = control ? control.getSamplePeriodSec() : 0
			const step = Math.max(1, Math.round(0.1 * View.viewPoints(total, view.xZoom)))
			const key = ev.key
			if (key === 'Escape') {
				if (drag && drag.kind === 'box') {
					drag = null
					scheduleDraw()
					ev.preventDefault()
					return
				}
				if (document.body.dataset.max === '1') {
					toggleMax()
					ev.preventDefault()
				}
				return
			}
			if (total < 2) return
			if (key === 'ArrowLeft' || key === 'ArrowRight') {
				const delta = (key === 'ArrowLeft' ? 1 : -1) * (ev.shiftKey ? 1 : step)
				const r = View.panByPixels({ total: total, xZoom: view.xZoom, xOffset: view.xOffset, deltaPx: (delta / Math.max(1, View.viewPoints(total, view.xZoom) - 1)) * Math.max(1, plotRect.w - 1), plotWidth: plotRect.w })
				view.xOffset = r.xOffset
				markUserView()
				scheduleDraw()
				renderSessionPanel()
				ev.preventDefault()
			} else if (key === '+' || key === '=') {
				zoomBy(1.6, 0.5)
				ev.preventDefault()
			} else if (key === '-' || key === '_') {
				zoomBy(1 / 1.6, 0.5)
				ev.preventDefault()
			} else if (key === 'ArrowUp' || key === 'ArrowDown') {
				if (ev.shiftKey) {
					view.yPan += key === 'ArrowUp' ? 0.2 : -0.2
				} else {
					view.yZoom = Math.max(C.Y_ZOOM_MIN, Math.min(C.Y_ZOOM_MAX, view.yZoom * (key === 'ArrowUp' ? 1.25 : 0.8)))
				}
				viewStatsCache = null
				scheduleDraw()
				ev.preventDefault()
			} else if (key === '0') {
				resetView()
				ev.preventDefault()
			} else if (key === 'f' || key === 'F') {
				toggleMax()
				ev.preventDefault()
			} else if (key === '[') {
				const range = currentRange()
				view.cursorA = snapIndex(Math.round((range.start + range.end) / 2), 0)
				renderCursorPanel()
				scheduleAnalysis(true)
				scheduleDraw()
				ev.preventDefault()
			} else if (key === ']') {
				const range = currentRange()
				view.cursorB = snapIndex(Math.round((range.start + range.end) / 2), 0)
				if (view.cursorA == null) view.cursorA = Math.max(0, (view.cursorB || 0) - Math.max(1, Math.round(step / 4)))
				renderCursorPanel()
				scheduleAnalysis(true)
				scheduleDraw()
				ev.preventDefault()
			} else if (key === '\\') {
				view.cursorA = null
				view.cursorB = null
				renderCursorPanel()
				scheduleDraw()
				ev.preventDefault()
			}
			void per
		})
	}

	function zoomBy(factor, anchorFrac) {
		const total = totalSamples()
		if (total < 2) return
		const r = View.zoomAtPoint({
			total: total,
			xZoom: view.xZoom,
			xOffset: view.xOffset,
			live: view.live,
			plotWidth: plotRect.w,
			pixel: Math.round(Math.max(0, Math.min(plotRect.w - 1, (anchorFrac == null ? 0.5 : anchorFrac) * plotRect.w))),
			factor: factor,
			periodSec: control.getSamplePeriodSec(),
		})
		view.xZoom = r.xZoom
		view.xOffset = r.xOffset
		markUserView()
		scheduleDraw()
		renderSessionPanel()
	}

	// ---------- 最大化 / 全屏 ----------
	function setMaxUi(on) {
		document.body.dataset.max = on ? '1' : '0'
		const btn = $('btn-max')
		btn.setAttribute('aria-pressed', String(on))
		btn.textContent = tr(on ? 'ui.btn_restore' : 'ui.btn_maximize')
		scheduleDraw()
	}

	function toggleMax() {
		const on = document.body.dataset.max !== '1'
		setMaxUi(on)
		// 优先用 Fullscreen API；不可用（或被拒）就只在面板内最大化
		try {
			if (on && document.documentElement.requestFullscreen) {
				const p = document.documentElement.requestFullscreen()
				if (p && p.catch) p.catch(function () { /* 面板内最大化已经生效 */ })
			} else if (!on && document.fullscreenElement && document.exitFullscreen) {
				const p = document.exitFullscreen()
				if (p && p.catch) p.catch(function () { /* 忽略 */ })
			}
		} catch (e) { /* 忽略 */ }
	}

	function bindFullscreenSync() {
		document.addEventListener('fullscreenchange', function () {
			if (!document.fullscreenElement && document.body.dataset.max === '1') setMaxUi(false)
		})
	}

	// ---------- 设置 / 控件 ----------
	function bindUi() {
		$('btn-refresh').addEventListener('click', function () { refreshPorts() })
		$('btn-connect').addEventListener('click', function () { toggleConnect() })
		$('port').addEventListener('change', function () {
			const sel = $('port')
			setText('chip-port', sel.options[sel.selectedIndex] ? tr('ui.chip_port', { label: sel.options[sel.selectedIndex].textContent }) : tr('ui.chip_port_none'))
		})
		$('btn-diag').addEventListener('click', toggleDiagnostics)
		$('btn-sample').addEventListener('click', function () {
			if (control.isSampling()) stopCapture()
			else startCapture()
		})
		$('btn-clear').addEventListener('click', function () {
			if (control.isSampling()) stopCapture('clear')
			control.clearSessionState()
			if (laneTrack) laneTrack.reset()
			viewStatsCache = null
			view.cursorA = null
			view.cursorB = null
			View.resetScopeTrigger(trig)
			trigScanFrom = null
			analysis.pack = null
			analysis.key = ''
			edgeCache = { key: '', edges: null }
			updateGapChip()
			renderSessionPanel()
			updateStoragePanel()
			scheduleDraw()
			log(M('app.cleared'))
		})
		$('btn-apply-voltage').addEventListener('click', async function () {
			const mv = Math.round(Number($('voltage').value))
			const r = await control.setVoltage(mv)
			if (r && r.ok) {
				settings.voltageMv = control.readVoltageMv()
				saveSettingsSoon()
				log(M('app.voltage_applied', { mv: settings.voltageMv }), 'success')
			} else {
				log(M('app.voltage_failed', { why: opWhy(r) }), 'error')
			}
			renderSessionPanel()
			renderDiagnostics()
		})
		$('btn-power').addEventListener('click', async function () {
			const want = control.state().powered.state !== 'on'
			const r = await control.setPower(want)
			if (!r || !r.ok) log(M('app.power_failed', { why: opWhy(r) }), 'error')
			renderSessionPanel()
		})
		$('btn-mode-wave').addEventListener('click', function () { setMode('wave') })
		$('btn-mode-long').addEventListener('click', function () { setMode('long') })
		$('rate').addEventListener('change', function () {
			settings.rateHz = Number($('rate').value) || 1000
			control.setTargetRateHz(settings.rateHz)
			saveSettingsSoon()
			renderSessionPanel()
			log(M('app.rate_set', { hz: fmtCount(settings.rateHz) }))
		})
		$('view').addEventListener('change', function () {
			settings.viewSec = Number($('view').value) || 10
			// 窗口时长 → 缩放：新视口点数由时长与采样周期决定
			const per = control.getSamplePeriodSec()
			if (per > 0) view.xZoom = View.clampXZoom(C.DEFAULT_VIEW_POINTS / Math.max(4, Math.round(settings.viewSec / per)), per)
			settings.yMode = view.yMode
			saveSettingsSoon()
			scheduleDraw()
			renderSessionPanel()
		})
		$('btn-apply-cap').addEventListener('click', function () {
			const mib = Math.round(Number($('cap').value))
			if (!isFinite(mib) || mib < 16) {
				log(M('app.cap_min'), 'warn')
				return
			}
			settings.capMiB = mib
			store.setCapBytes(mib * MIB)
			saveSettingsSoon()
			updateStoragePanel()
			log(M('app.cap_set', { mib: mib }))
		})
		$('btn-export-view').addEventListener('click', function () { doExport('view') })
		$('btn-export-all').addEventListener('click', function () { doExport('all') })
		$('btn-export-summary').addEventListener('click', function () { doExport('summary') })
		$('import-file').addEventListener('change', function () { importCsvFile() })
		$('btn-import').addEventListener('click', function () { importCsvFile() })

		// Y 轴模式
		$('btn-ylin').addEventListener('click', function () { setYMode('linear') })
		$('btn-ylog').addEventListener('click', function () { setYMode('log') })
		$('btn-ysym').addEventListener('click', function () { setYMode('symlog') })
		// 显示开关
		$('btn-env').addEventListener('click', function () {
			show.envelope = !show.envelope
			settings.showEnvelope = show.envelope
			$('btn-env').setAttribute('aria-pressed', String(show.envelope))
			saveSettingsSoon()
			scheduleDraw()
		})
		$('btn-band').addEventListener('click', function () {
			show.band = !show.band
			settings.showBand = show.band
			$('btn-band').setAttribute('aria-pressed', String(show.band))
			saveSettingsSoon()
			scheduleDraw()
		})
		// 显示触发
		$('trig-mode').addEventListener('change', function () {
			trigUI.mode = $('trig-mode').value
			View.resetScopeTrigger(trig)
			trigScanFrom = null
			trigUserOverride = false
			updateTriggerChip(control ? control.trigLevel() : 0)
			scheduleDraw()
			log(M('app.trig_mode', { mode: M('ui.edge_' + trigUI.mode) }))
		})
		$('trig-level').addEventListener('change', function () {
			const raw = String($('trig-level').value || '').trim()
			if (!raw) {
				trigUI.levelAuto = true
				trigUI.levelUA = null
				control.setTrigLevel(null)
			} else {
				const n = Number(raw)
				if (!isFinite(n)) {
					log(M('app.trig_level_nan'), 'warn')
					return
				}
				trigUI.levelAuto = false
				trigUI.levelUA = n
				control.setTrigLevel(n)
			}
			View.resetScopeTrigger(trig)
			trigScanFrom = null
			updateTriggerChip(control.trigLevel())
			scheduleDraw()
		})
		$('trig-pre').addEventListener('change', function () {
			trigUI.preFrac = Number($('trig-pre').value) || 0.25
			settings.trigPre = trigUI.preFrac
			saveSettingsSoon()
			scheduleDraw()
		})
		// 采样沿触发
		$('acq-start').addEventListener('change', function () {
			control.setAcqTriggers($('acq-start').value, $('acq-stop').value)
			log(M('app.acq_start_set', { edge: M('ui.edge_' + $('acq-start').value), when: M(control.isSampling() ? 'app.acq_now' : 'app.acq_next') }))
			renderSessionPanel()
		})
		$('acq-stop').addEventListener('change', function () {
			control.setAcqTriggers($('acq-start').value, $('acq-stop').value)
			log(M('app.acq_stop_set', { edge: M('ui.edge_' + $('acq-stop').value) }))
			renderSessionPanel()
		})
		$('btn-reset').addEventListener('click', function () { resetView() })
		$('btn-max').addEventListener('click', function () { toggleMax() })
		// 分析
		$('an-source').addEventListener('change', function () {
			analysis.source = $('an-source').value
			settings.anSource = analysis.source
			saveSettingsSoon()
			scheduleAnalysis(true)
		})
		$('btn-an-refresh').addEventListener('click', function () { scheduleAnalysis(true) })
		$('btn-fft').addEventListener('click', function () {
			show.fft = !show.fft
			$('btn-fft').setAttribute('aria-pressed', String(show.fft))
			$('an-fft-block').hidden = !show.fft
			scheduleAnalysis(true)
			scheduleDraw()
		})
		$('btn-battery').addEventListener('click', function () {
			show.battery = !show.battery
			$('btn-battery').setAttribute('aria-pressed', String(show.battery))
			$('an-battery-block').hidden = !show.battery
			scheduleAnalysis(true)
		})
		$('btn-cycles').addEventListener('click', function () {
			show.cycles = !show.cycles
			$('btn-cycles').setAttribute('aria-pressed', String(show.cycles))
			$('an-cycles-block').hidden = !show.cycles
			scheduleAnalysis(true)
			scheduleDraw()
		})
		$('an-capacity').addEventListener('change', function () {
			const v = Number($('an-capacity').value)
			if (isFinite(v) && v > 0) {
				settings.capacityMah = v
				saveSettingsSoon()
				scheduleAnalysis(true)
			}
		})

		bindCanvas()
		bindKeys()
		bindFullscreenSync()
		window.addEventListener('resize', scheduleDraw)
	}

	function setYMode(mode) {
		view.yMode = mode === 'log' || mode === 'symlog' ? mode : 'linear'
		settings.yMode = view.yMode
		$('btn-ylin').setAttribute('aria-pressed', String(view.yMode === 'linear'))
		$('btn-ylog').setAttribute('aria-pressed', String(view.yMode === 'log'))
		$('btn-ysym').setAttribute('aria-pressed', String(view.yMode === 'symlog'))
		saveSettingsSoon()
		scheduleDraw()
		log(M('app.y_mode', { mode: M('ui.ymode_' + view.yMode), extra: view.yMode === 'log' ? M('app.y_log_note') : '' }))
	}

	function setMode(mode) {
		settings.recordMode = mode === 'long' ? 'long' : 'wave'
		control.setRecordMode(settings.recordMode)
		$('btn-mode-wave').setAttribute('aria-pressed', String(settings.recordMode === 'wave'))
		$('btn-mode-long').setAttribute('aria-pressed', String(settings.recordMode === 'long'))
		saveSettingsSoon()
		renderSessionPanel()
		scheduleDraw()
		log(M('app.record_mode', { mode: M(settings.recordMode === 'wave' ? 'app.record_wave' : 'app.record_long') }))
	}

	// ---------- 启动 ----------
	async function boot() {
		initLocale()
		createPipeline()
		bindUi()

		// 停滞看门狗：长时间没有新样点就提示 + 标缺口（不自动重连）
		// 必须注入定时器：createStallWatch 没有 setInterval 时不会自己巡检，看门狗形同虚设
		stall = View.createStallWatch({
			intervalMs: 500,
			thresholdMs: 2500,
			setInterval: function (fn, ms) { return setInterval(fn, ms) },
			clearInterval: function (t) { clearInterval(t) },
			onStall: function (info) {
				const idle = Math.round(info.idleMs)
				const ls = link ? link.stats() : { bytes: 0, samples: 0 }
				const base = captureBase || { bytes: 0, samples: 0 }
				const d = View.describeStall({ idleMs: idle, rxBytes: ls.bytes - base.bytes, samples: ls.samples - base.samples })
				if (d.kind === 'stall') {
					if (control) control.noteGap({ reason: 'stall', idleMs: idle })
					updateGapChip()
					$('gaps-hint').dataset.warn = '1'
					setSampleAlert('warn', 'ui.alert_stalled')
				} else {
					// 从来没收到过样点：不是缺口，是设备无应答 / 解析失败
					setSampleAlert('error', d.kind === 'no_response' ? 'ui.alert_no_response' : 'ui.alert_decode_failed')
				}
				log(d.ref || d.message, d.level)
				hostLog('capture watchdog: ' + d.kind + ' after ' + idle + ' ms (rx ' + (ls.bytes - base.bytes) + ' B since start)')
				renderDiagnostics()
			},
			onResume: function () {
				log(M('app.resumed'), 'success')
				$('gaps-hint').dataset.warn = '0'
				setSampleAlert(null)
			},
		})

		sdk.on('theme-change', function (th) {
			renderThemeChip(th)
			scheduleDraw()
		})
		sdk.on('theme', function (th) {
			renderThemeChip(th)
		})

		try {
			const saved = await sdk.app.storageGet('settings')
			settings = normalizeSettings(saved)
		} catch (e) {
			log(M('app.settings_read_failed', { err: (e && e.message ? e.message : e) }), 'warn')
		}
		syncViewFromSettings()
		$('rate').value = String(settings.rateHz)
		$('voltage').value = settings.voltageMv == null ? '' : String(settings.voltageMv)
		$('cap').value = String(settings.capMiB)
		$('view').value = String(settings.viewSec)
		$('trig-pre').value = String(settings.trigPre)
		$('an-source').value = settings.anSource
		$('an-capacity').value = String(settings.capacityMah)
		$('btn-env').setAttribute('aria-pressed', String(show.envelope))
		$('btn-band').setAttribute('aria-pressed', String(show.band))
		setYModeInternal()
		control.setTargetRateHz(settings.rateHz)
		control.setVoltageSource(settings.voltageMv)
		if (settings.recordMode === 'long') {
			settings.recordMode = 'wave'
			setMode('long')
		}
		store.setCapBytes(settings.capMiB * MIB)
		wave.setRamCap(Math.max(65536, Math.round((settings.ramMiB * MIB) / 4)))

		renderThemeChip(sdk.getTheme())

		await refreshPorts()
		renderConnState()
		renderSessionPanel()
		updateStoragePanel()
		updateGapChip()
		updateTriggerChip(0)
		scheduleDraw()
		log(M('app.ready'))
		readoutTimer = setInterval(function () {
			renderSessionPanel()
			updateStoragePanel()
			renderDiagnostics()
		}, 400)
	}

	function setYModeInternal() {
		view.yMode = settings.yMode
		$('btn-ylin').setAttribute('aria-pressed', String(view.yMode === 'linear'))
		$('btn-ylog').setAttribute('aria-pressed', String(view.yMode === 'log'))
		$('btn-ysym').setAttribute('aria-pressed', String(view.yMode === 'symlog'))
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () { boot() })
	} else {
		boot()
	}
})()
