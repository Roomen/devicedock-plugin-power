// 功耗分析插件的界面接线：所有能力都走宿主 RPC（device.read / serial.claim / app / log）。
// 设备字符串（口名 / 产品名 / 序列号 / metadata 文本）一律 textContent，不拼 HTML。
;(function () {
	'use strict'

	const sdk = window.DeviceDockPlugin
	const PROTO = window.PowerProtocol
	const WaveMod = window.PowerWave
	const StoreMod = window.PowerMemoryStore
	const Claim = window.PowerClaim
	const ControlMod = window.PowerControl
	const ExportMod = window.PowerExport

	const $ = function (id) { return document.getElementById(id) }
	const MIB = 1024 * 1024
	const DEFAULT_SETTINGS = {
		recordMode: 'wave',
		rateHz: 1000,
		voltageMv: 3300,
		// 热区（未压缩）预算与冷区原始当量上限，都可在界面里改
		ramMiB: 32,
		capMiB: 512,
		viewSec: 10,
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

	// ---------- 小工具 ----------
	function fmtCurrent(ua) {
		const a = Math.abs(ua)
		if (!isFinite(ua)) return '—'
		if (a >= 1e6) return (ua / 1e6).toFixed(3) + ' A'
		if (a >= 1e3) return (ua / 1e3).toFixed(3) + ' mA'
		if (a >= 1) return ua.toFixed(2) + ' µA'
		if (a === 0) return '0 µA'
		return ua.toFixed(3) + ' µA'
	}
	function fmtPower(uw) {
		if (!isFinite(uw)) return '—'
		const a = Math.abs(uw)
		if (a >= 1e6) return (uw / 1e6).toFixed(3) + ' W'
		if (a >= 1e3) return (uw / 1e3).toFixed(2) + ' mW'
		return uw.toFixed(1) + ' µW'
	}
	function fmtCharge(uc) {
		if (!isFinite(uc)) return '—'
		const a = Math.abs(uc)
		if (a >= 1e6) return (uc / 1e6).toFixed(3) + ' C'
		if (a >= 1e3) return (uc / 1e3).toFixed(3) + ' mC'
		return uc.toFixed(2) + ' µC'
	}
	function fmtEnergy(uwh) {
		if (!isFinite(uwh)) return '—'
		const a = Math.abs(uwh)
		if (a >= 1e6) return (uwh / 1e6).toFixed(3) + ' Wh'
		if (a >= 1e3) return (uwh / 1e3).toFixed(3) + ' mWh'
		return uwh.toFixed(1) + ' µWh'
	}
	function fmtDuration(sec) {
		if (!isFinite(sec) || sec <= 0) return '0 s'
		if (sec < 1) return (sec * 1000).toFixed(0) + ' ms'
		if (sec < 60) return sec.toFixed(2) + ' s'
		const m = Math.floor(sec / 60)
		const s = sec - m * 60
		if (m < 60) return m + ' min ' + s.toFixed(0) + ' s'
		return Math.floor(m / 60) + ' h ' + (m % 60) + ' min'
	}
	function fmtBytes(n) {
		const a = Math.abs(n || 0)
		if (a >= MIB) return (n / MIB).toFixed(1) + ' MiB'
		if (a >= 1024) return (n / 1024).toFixed(1) + ' KiB'
		return (n || 0) + ' B'
	}
	function fmtCount(n) {
		return (n || 0).toLocaleString('en-US')
	}
	function setText(id, text) {
		const el = $(id)
		if (el) el.textContent = text
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
		setText('log-meta', logLines + ' lines')
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
		const view = Number(raw.viewSec)
		if (isFinite(view) && view > 0) out.viewSec = view
		return out
	}

	function saveSettingsSoon() {
		if (saveTimer) clearTimeout(saveTimer)
		saveTimer = setTimeout(function () {
			saveTimer = 0
			// 单值上限 64 KiB：这里只是几十字节的配置，序列化一次即可
			sdk.app.storageSet('settings', settings).catch(function (e) {
				log('保存设置失败：' + (e && e.message ? e.message : e), 'warn')
			})
		}, 400)
	}

	// ---------- 波形 / 存储 / 链路 / 控制 ----------
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
			// 块索引的元数据预算 = 热区 + 32 MiB（要装得下热区预留的那一份）；超了才是停采
			metaBudgetBytes: settings.ramMiB * MIB + 32 * MIB,
			voltage: function () {
				const st = control ? control.state() : null
				return st && st.voltageMv != null ? st.voltageMv / 1000 : 0
			},
			samplePeriod: function () { return control ? control.getSamplePeriodSec() : 0 },
			log: log,
			scheduleUI: scheduleDraw,
			onStorageStop: function (reason) {
				log(reason, 'error')
				// 存储触顶：停采（busy 源随之释放）
				if (control && control.isSampling()) stopCapture('storage')
			},
		})

		link = Claim.createClaimLink({
			host: sdk,
			baudRate: 115200,
			createParser: function () {
				const mods = control ? control.getModifiers() : PROTO.defaultModifiers()
				return new PROTO.SampleParser(new PROTO.Converter(mods))
			},
			onSamples: onSamples,
			onGap: function (info) {
				if (control) control.noteGap(info)
				updateGapChip()
				if (info.reason === 'overflow' || info.reason === 'closing') {
					log('宿主丢弃了 ' + info.bytes + ' 字节（' + info.reason + '），已标记缺口', 'warn')
				}
			},
			onState: function () { renderConnState() },
			onLog: log,
			// metadata（0x19）回的是文本，不能按样点解析
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
			onChange: function () { renderSessionPanel() },
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

	let laneTrack = null
	if (window.PowerSerialLane && typeof window.PowerSerialLane.createAnchorTrack === 'function') {
		laneTrack = window.PowerSerialLane.createAnchorTrack({ intervalMs: 200, gapMs: 20 })
	}

	// 样点批次（回调外异步来）：测量设备速率 → 重采样到目标速率 → 入库
	function onSamples(list, at, meta) {
		if (!control) return
		control.pushSamples(list, at, meta)
	}

	// ---------- 端口 ----------
	async function refreshPorts() {
		const sel = $('port')
		try {
			const ports = await link.listPorts()
			const current = sel.value
			sel.textContent = ''
			if (!ports.length) {
				const opt = document.createElement('option')
				opt.value = ''
				opt.textContent = 'no ports'
				sel.appendChild(opt)
				sel.disabled = true
				setText('chip-port', 'port: none')
				return
			}
			sel.disabled = false
			ports.forEach(function (p) {
				const opt = document.createElement('option')
				opt.value = p.key || ''
				const name = p.alias || p.productName || p.portName || p.key || 'serial port'
				const detail = [p.portName && p.portName !== name ? p.portName : '', p.serialNumber || ''].filter(Boolean).join(' · ')
				opt.textContent = detail ? name + '  (' + detail + ')' : name
				if (p.busy) opt.textContent += '  [busy: ' + p.busy + ']'
				sel.appendChild(opt)
			})
			if (current) {
				for (let i = 0; i < sel.options.length; i++) {
					if (sel.options[i].value === current) { sel.selectedIndex = i; break }
				}
			}
			setText('chip-port', 'port: ' + (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : 'none'))
		} catch (e) {
			log('读取串口列表失败：' + (e && e.message ? e.message : e), 'error')
		}
	}

	function renderConnState() {
		const open = link && link.isOpen()
		const opening = link && link.isOpening()
		const btn = $('btn-connect')
		btn.textContent = open ? 'Disconnect' : (opening ? 'Opening…' : 'Connect')
		btn.disabled = !!opening
		$('port').disabled = !!open || !!opening
		$('btn-refresh').disabled = !!open || !!opening
		$('chip-port').dataset.state = open ? 'on' : 'off'
		if (open) {
			const sel = $('port')
			const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : (link.portKey() || '')
			setText('chip-port', 'port: ' + label)
		}
		setText('session-meta', open ? 'connected' : 'not connected')
		$('btn-power').disabled = !open
		$('btn-sample').disabled = !open
		$('btn-apply-voltage').disabled = !open
	}

	async function toggleConnect() {
		const btn = $('btn-connect')
		btn.disabled = true
		try {
			if (link.isOpen()) {
				if (control.isSampling()) await control.stopCapture()
				await link.close()
				releaseBusy()
				log('串口已释放')
			} else {
				const key = $('port').value
				if (!key) {
					log('请先选择一个串口', 'warn')
					return
				}
				await link.open(key)
				log('已独占占用串口（mode=exclusive）', 'success')
				// 先读设备修正参数（R/O/VDD），再探测 DUT 是否带电
				const ok = await control.fetchModifiers()
				if (ok) {
					const mv = control.readVoltageMv()
					if (mv != null) $('voltage').value = String(mv)
				}
				const probe = await control.probeDutPower()
				if (probe) {
					control.markPowered(probe.on, 'probed')
					log('DUT 供电探测：' + (probe.on ? '带电' : '未带电') + '（中位数 ' + probe.medianUA.toFixed(2) + ' µA，' + probe.n + ' 点）')
				}
			}
		} catch (e) {
			log('串口操作失败：' + (e && e.message ? e.message : e), 'error')
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
			log('申请更新屏障失败：' + (e && e.message ? e.message : e), 'warn')
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
		if (!link.isOpen()) return
		// 采样期间挡住应用更新：插件正在持有串口与内存里的数据
		await acquireBusy()
		try {
			const r = await control.startCapture()
			if (!r || !r.ok) {
				log('开始采样失败：' + ((r && r.message) || '未知原因'), 'error')
				releaseBusy()
			}
		} catch (e) {
			releaseBusy()
			log('开始采样异常：' + (e && e.message ? e.message : e), 'error')
		}
		renderSessionPanel()
		updateSampleButton()
		scheduleDraw()
		startDrawLoop()
	}

	async function stopCapture(reason) {
		try {
			const r = await control.stopCapture()
			if (r && !r.ok) log('停止采样：' + (r.message || r.code), 'warn')
		} catch (e) {
			log('停止采样异常：' + (e && e.message ? e.message : e), 'error')
		} finally {
			releaseBusy()
			if (reason === 'storage') log('因存储上限已停止采样', 'warn')
			renderSessionPanel()
			updateSampleButton()
			scheduleDraw()
		}
	}

	function updateSampleButton() {
		const sampling = control && control.isSampling()
		const btn = $('btn-sample')
		btn.textContent = sampling ? 'Stop capture' : 'Start capture'
		btn.dataset.primary = sampling ? '0' : '1'
		const chip = $('chip-sampling')
		chip.dataset.state = sampling ? 'busy' : 'off'
		chip.textContent = sampling ? 'capturing' : 'idle'
	}

	// ---------- 面板渲染 ----------
	function updateGapChip() {
		const gaps = wave ? wave.gaps().length : 0
		const dropped = wave ? wave.droppedSamples() : 0
		const chip = $('chip-gaps')
		chip.textContent = 'gaps: ' + gaps
		chip.dataset.state = gaps > 0 ? 'warn' : 'off'
		setText('st-gaps', String(gaps) + (dropped > 0 ? ' · ' + fmtCount(dropped) + ' dropped' : ''))
		$('st-gaps').dataset.warn = gaps > 0 ? '1' : '0'
	}

	function renderSessionPanel() {
		if (!control) return
		const st = control.state()
		const summary = control.captureSummary()
		setText('st-duration', fmtDuration(summary.durationSec))
		setText('st-rate', st.targetRateHz > 0 ? fmtCount(st.targetRateHz) + ' Hz' : '—')
		setText('st-samples', fmtCount(summary.totalSamples) + (summary.retainedSamples !== summary.totalSamples ? ' (' + fmtCount(summary.retainedSamples) + ' kept)' : ''))
		setText('st-energy', summary.energyUWh == null ? 'n/a' : fmtEnergy(summary.energyUWh))
		setText('st-charge', fmtCharge(summary.chargeUC))
		setText('st-power', st.powered.state === 'on' ? 'on (' + st.powered.source + ')' : (st.powered.state === 'off' ? 'off (' + st.powered.source + ')' : 'unknown'))
		$('btn-power').setAttribute('aria-pressed', String(st.powered.state === 'on'))
		$('btn-power').textContent = st.powered.state === 'on' ? 'DUT off' : 'DUT on'
		updateGapChip()
		updateSampleButton()
		if (wave && wave.total() > 0) {
			const range = currentViewRange()
			const win = wave.stats(range.start, range.end + 1)
			viewStatsCache = { start: range.start, end: range.end, stats: win }
			setText('win-start', fmtCount(range.start))
			setText('win-mean', fmtCurrent(win.avgI))
			setText('win-range', fmtCurrent(win.minI) + ' / ' + fmtCurrent(win.maxI))
			setText('ro-current', fmtCurrent(win.avgI))
			setText('ro-power', fmtPower(win.avgP))
			setText('ro-samples', fmtCount(summary.retainedSamples))
			setText('scope-meta', fmtCount(range.end - range.start + 1) + ' samples · ' + fmtDuration((range.end - range.start) * control.getSamplePeriodSec()))
		} else {
			viewStatsCache = null
			setText('win-start', '0')
			setText('win-mean', '—')
			setText('win-range', '—')
			setText('ro-current', '0 µA')
			setText('ro-power', '0 µW')
			setText('ro-samples', '0')
			setText('scope-meta', 'no data')
		}
		setText('ro-voltage', st.voltageMv == null ? '—' : String(st.voltageMv))
		$('scope-empty').style.display = wave && wave.total() > 0 ? 'none' : 'flex'
	}

	function updateStoragePanel() {
		if (!store || !wave) return
		setText('store-raw', fmtBytes(store.getRawUsed()))
		setText('store-comp', fmtBytes(store.getCompressedUsed()))
		setText('store-blocks', String(store.blockCount()))
		setText('store-caps', fmtBytes(store.getCapBytes()) + ' cold · ' + fmtBytes(wave.ramCap() * 4) + ' hot')
		setText('store-meta', StoreMod.compressionSupported() ? 'deflate' : 'uncompressed')
		setText('export-meta', 'limit ' + fmtBytes(ExportMod.MAX_EXPORT_BYTES))
	}

	// ---------- 波形绘制 ----------
	function currentViewRange() {
		const total = wave ? wave.total() : 0
		if (total <= 0) return { start: 0, end: 0 }
		const end = total - 1
		const per = control ? control.getSamplePeriodSec() : 0
		const windowSamples = per > 0 ? Math.max(2, Math.round((settings.viewSec || 10) / per)) : total
		const start = Math.max(0, end - windowSamples + 1)
		return { start: start, end: end }
	}

	function cssVar(name, fallback) {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name)
		return (v && v.trim()) || fallback
	}

	function drawWave() {
		const cv = $('wave')
		if (!cv || !wave) return
		const dpr = window.devicePixelRatio || 1
		const w = Math.max(1, cv.clientWidth)
		const h = Math.max(1, cv.clientHeight)
		if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
			cv.width = Math.round(w * dpr)
			cv.height = Math.round(h * dpr)
		}
		const g = cv.getContext('2d')
		if (!g) return
		g.setTransform(dpr, 0, 0, dpr, 0, 0)
		// 颜色从 CSS 变量取：主题切换后重画即可，不留硬编码色
		const colBg = cssVar('--bg-sunken', '#eef1f5')
		const colGrid = cssVar('--border-light', 'rgba(17,24,39,0.07)')
		const colTrace = cssVar('--accent', '#1f5fbf')
		const colBand = cssVar('--accent-light', 'rgba(31,95,191,0.08)')
		const colText = cssVar('--text-muted', '#6b7487')
		const colGap = cssVar('--warning', '#b45309')

		g.clearRect(0, 0, w, h)
		g.fillStyle = colBg
		g.fillRect(0, 0, w, h)

		// 网格：4 条水平发丝线，不画竖线（避免和缺口标记抢注意力）
		g.strokeStyle = colGrid
		g.lineWidth = 1
		for (let i = 1; i < 4; i++) {
			const y = Math.round((h * i) / 4) + 0.5
			g.beginPath()
			g.moveTo(0, y)
			g.lineTo(w, y)
			g.stroke()
		}

		const total = wave.total()
		if (total <= 0) return
		const range = currentViewRange()
		const span = Math.max(1, range.end - range.start)
		// 视窗统计由 renderSessionPanel 每 400 ms 算一次并缓存，画布每帧只读缓存
		const stats = (viewStatsCache && viewStatsCache.start === range.start && viewStatsCache.end === range.end)
			? viewStatsCache.stats
			: wave.stats(range.start, range.end + 1)
		let lo = stats.minI
		let hi = stats.maxI
		if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = 0; hi = 1 }
		const padY = (hi - lo) * 0.12 || 1
		lo -= padY
		hi += padY
		const yOf = function (v) { return h - ((v - lo) / (hi - lo)) * h }
		const xOf = function (i) { return ((i - range.start) / span) * (w - 1) }

		// 每像素一桶的 min/max 包络 + 均值折线
		const bs = wave.computeBucketSize(span + 1, Math.max(1, Math.floor(w)))
		wave.frameReset()
		const first = Math.floor(range.start / bs)
		const last = Math.floor(range.end / bs)
		g.strokeStyle = colBand
		g.lineWidth = 1
		g.beginPath()
		for (let bi = first; bi <= last; bi++) {
			const e = wave.getBucketEntry(bi, bs, 0, range.end)
			if (!e) continue
			const x0 = Math.max(0, Math.min(w - 1, xOf(e.loAbs)))
			const yTop = yOf(e.max)
			const yBot = yOf(e.min)
			g.moveTo(x0 + 0.5, yTop)
			g.lineTo(x0 + 0.5, Math.max(yBot, yTop + 1))
		}
		g.stroke()

		g.strokeStyle = colTrace
		g.lineWidth = 1.25
		g.beginPath()
		let started = false
		for (let bi = first; bi <= last; bi++) {
			const e = wave.getBucketEntry(bi, bs, 0, range.end)
			if (!e) continue
			const x0 = Math.max(0, Math.min(w - 1, xOf(e.loAbs)))
			const x1 = Math.max(x0, Math.min(w - 1, xOf(e.hiAbs)))
			const yA = yOf(started ? e.first : e.first)
			if (!started) { g.moveTo(x0, yA); started = true } else g.lineTo(x0, yA)
			g.lineTo(x1, yOf(e.last))
		}
		g.stroke()

		// 缺口：竖线 + 顶部短刻度（缺口处数据不连续，不能画成连续线）
		const gaps = wave.gaps()
		g.strokeStyle = colGap
		g.lineWidth = 1
		g.beginPath()
		for (let i = 0; i < gaps.length; i++) {
			const gi = gaps[i]
			if (gi < range.start || gi > range.end) continue
			const x = Math.round(xOf(gi)) + 0.5
			g.moveTo(x, 0)
			g.lineTo(x, h)
		}
		g.stroke()
		g.fillStyle = colGap
		for (let i = 0; i < gaps.length; i++) {
			const gi = gaps[i]
			if (gi < range.start || gi > range.end) continue
			g.fillRect(Math.round(xOf(gi)) - 1, 0, 3, 4)
		}

		// 轴标注：最大 / 最小 / 零点
		g.fillStyle = colText
		g.font = '11px ' + cssVar('--font-mono', 'ui-monospace, monospace')
		g.textBaseline = 'top'
		g.fillText(fmtCurrent(hi), 6, 4)
		g.textBaseline = 'bottom'
		g.fillText(fmtCurrent(lo), 6, h - 4)
	}

	function scheduleDraw() {
		if (drawQueued) return
		drawQueued = true
		requestAnimationFrame(function () {
			drawQueued = false
			drawWave()
		})
	}

	// 采集中只重画画布；读数 / 统计走 400 ms 的定时器（统计要扫整个视窗，不能每帧算）
	function startDrawLoop() {
		if (rafId) return
		const tick = function () {
			rafId = 0
			drawWave()
			if (control && control.isSampling()) rafId = requestAnimationFrame(tick)
		}
		rafId = requestAnimationFrame(tick)
	}

	// ---------- 导出 ----------
	async function doExport(kind) {
		if (!wave || wave.total() === 0) {
			log('还没有可导出的样点', 'warn')
			return
		}
		const hint = $('export-hint')
		let r
		if (kind === 'summary') {
			r = await exportSvc.exportSummary()
		} else if (kind === 'view') {
			const range = currentViewRange()
			r = await exportSvc.exportRange(range.start, range.end + 1, { name: 'power-window.csv' })
		} else {
			r = await exportSvc.exportRange(0, wave.total(), { name: 'power-session.csv' })
		}
		if (!r || !r.ok) {
			// 超限时明确说清楚：多大、上限多少、可以怎么做，绝不静默截断
			const msg = (r && r.message) ? r.message : '导出失败'
			hint.textContent = msg
			hint.dataset.warn = '1'
			log('导出被拒绝：' + msg, 'error')
			return
		}
		hint.dataset.warn = '0'
		hint.textContent = 'Saved ' + r.name + (r.bytes ? ' (' + fmtBytes(r.bytes) + ')' : '')
	}

	// ---------- 事件绑定 ----------
	function bindUi() {
		$('btn-refresh').addEventListener('click', function () { refreshPorts() })
		$('btn-connect').addEventListener('click', function () { toggleConnect() })
		$('port').addEventListener('change', function () {
			const sel = $('port')
			const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : 'none'
			setText('chip-port', 'port: ' + label)
		})
		$('btn-sample').addEventListener('click', function () {
			if (control.isSampling()) stopCapture()
			else startCapture()
		})
		$('btn-clear').addEventListener('click', function () {
			if (control.isSampling()) stopCapture('clear')
			control.clearSessionState()
			if (laneTrack) laneTrack.reset()
			viewStatsCache = null
			updateGapChip()
			renderSessionPanel()
			updateStoragePanel()
			scheduleDraw()
			log('数据已清空')
		})
		$('btn-apply-voltage').addEventListener('click', async function () {
			const mv = Math.round(Number($('voltage').value))
			const r = await control.setVoltage(mv)
			if (r && r.ok) {
				settings.voltageMv = control.readVoltageMv()
				saveSettingsSoon()
				log('源电压已写入 ' + settings.voltageMv + ' mV', 'success')
			} else {
				log('设定电压失败：' + ((r && r.message) || '未知原因'), 'error')
			}
			renderSessionPanel()
		})
		$('btn-power').addEventListener('click', async function () {
			const want = control.state().powered.state !== 'on'
			const r = await control.setPower(want)
			if (!r || !r.ok) log('DUT 上下电失败：' + ((r && r.message) || '未知原因'), 'error')
			renderSessionPanel()
		})
		$('btn-mode-wave').addEventListener('click', function () { setMode('wave') })
		$('btn-mode-long').addEventListener('click', function () { setMode('long') })
		$('rate').addEventListener('change', function () {
			settings.rateHz = Number($('rate').value) || 1000
			control.setTargetRateHz(settings.rateHz)
			saveSettingsSoon()
			renderSessionPanel()
			log('目标采样率 ' + fmtCount(settings.rateHz) + ' Hz（下次开始采样生效）')
		})
		$('view').addEventListener('change', function () {
			settings.viewSec = Number($('view').value) || 10
			saveSettingsSoon()
			scheduleDraw()
			renderSessionPanel()
		})
		$('btn-apply-cap').addEventListener('click', function () {
			const mib = Math.round(Number($('cap').value))
			if (!isFinite(mib) || mib < 16) {
				log('冷区上限至少 16 MiB', 'warn')
				return
			}
			settings.capMiB = mib
			store.setCapBytes(mib * MIB)
			saveSettingsSoon()
			updateStoragePanel()
			log('冷区上限改为 ' + mib + ' MiB（超出按最早块淘汰并标记缺口）')
		})
		$('btn-export-view').addEventListener('click', function () { doExport('view') })
		$('btn-export-all').addEventListener('click', function () { doExport('all') })
		$('btn-export-summary').addEventListener('click', function () { doExport('summary') })

		window.addEventListener('resize', scheduleDraw)
	}

	function setMode(mode) {
		settings.recordMode = mode === 'long' ? 'long' : 'wave'
		control.setRecordMode(settings.recordMode)
		$('btn-mode-wave').setAttribute('aria-pressed', String(settings.recordMode === 'wave'))
		$('btn-mode-long').setAttribute('aria-pressed', String(settings.recordMode === 'long'))
		saveSettingsSoon()
		renderSessionPanel()
		log('记录模式：' + (settings.recordMode === 'wave' ? '波形' : '长期统计（不进波形环）'))
	}

	// ---------- 启动 ----------
	async function boot() {
		createPipeline()
		bindUi()

		// 主题：SDK 已把宿主 tokens 写到 :root；这里只负责重画画布与标识
		sdk.on('theme-change', function (t) {
			setText('chip-theme', 'theme: ' + ((t && t.theme) || 'light'))
			scheduleDraw()
		})
		sdk.on('theme', function (t) {
			setText('chip-theme', 'theme: ' + ((t && t.theme) || 'light'))
		})

		try {
			const saved = await sdk.app.storageGet('settings')
			settings = normalizeSettings(saved)
		} catch (e) {
			log('读取设置失败，使用默认值：' + (e && e.message ? e.message : e), 'warn')
		}
		// 应用到控件与管线
		$('rate').value = String(settings.rateHz)
		$('voltage').value = settings.voltageMv == null ? '' : String(settings.voltageMv)
		$('cap').value = String(settings.capMiB)
		$('view').value = String(settings.viewSec)
		control.setTargetRateHz(settings.rateHz)
		control.setVoltageSource(settings.voltageMv)
		if (settings.recordMode === 'long') setMode('long')
		store.setCapBytes(settings.capMiB * MIB)
		wave.setRamCap(Math.max(65536, Math.round((settings.ramMiB * MIB) / 4)))

		const theme = sdk.getTheme()
		setText('chip-theme', 'theme: ' + ((theme && theme.theme) || 'light'))

		await refreshPorts()
		renderConnState()
		renderSessionPanel()
		updateStoragePanel()
		updateGapChip()
		scheduleDraw()
		log('已就绪：设备串口会被独占声明（serial.claim），不影响通信调试的 S/A/B 路')
		readoutTimer = setInterval(function () {
			renderSessionPanel()
			updateStoragePanel()
		}, 400)
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () { boot() })
	} else {
		boot()
	}
})()
