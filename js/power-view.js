// 波形视图的纯逻辑：视口换算（缩放 / 平移 / 跟手）、Y 轴映射（linear / log / symlog）、
// 游标与框选、示波器式显示触发、采样沿触发、停滞看门狗、总览条布局。
// 不碰 DOM、不碰 canvas：界面只拿这里算出来的数字去画，所以全部可在 node 里回归。
//
// 几条来自原实现的硬约束（都是踩过的坑）：
//  - xZoom 的缩放下限按时长算（最宽约 MAX_VIEW_DURATION_SEC），不是固定倍数；
//    放大上限是硬常量，否则 4 个点也允许「放大」到亚样点。
//  - 缩放要钉住鼠标下的那个样点（zoomAtPoint），否则滚轮会带着波形跑。
//  - Log 的 floor 默认 1 nA、钳在 [0.1 nA, 1 µA] 并做滞回，否则 Live 噪声会让台阶乱跳。
//  - 触发扫描区间超长只扫尾部，且必须用扫窗前一点重 seed 状态，否则会报假沿。
//  - 沿触发的 waiting 阶段只累计 pre-range（供 Auto 电平），且 unknown 状态只 seed 不产生沿。
;(function (global) {
	'use strict'
	const I18N = global.PowerI18n || (typeof require === 'function' ? require('./power-i18n.js') : null)
	const tr = I18N.t

	const C = {
		DEFAULT_VIEW_POINTS: 2000,
		MIN_VIEW_POINTS: 4,
		MAX_VIEW_DURATION_SEC: 120,
		X_ZOOM_MIN_HARD: 1e-6,
		X_ZOOM_MAX: 2000,
		Y_ZOOM_MIN: 0.1,
		Y_ZOOM_MAX: 100,
		LOG_FLOOR_DEFAULT_UA: 1e-3, // 1 nA
		LOG_FLOOR_MIN_UA: 1e-4, // 0.1 nA
		LOG_FLOOR_MAX_UA: 1, // 1 µA
		SYMLOG_LINTHRESH_DEFAULT_UA: 1, // 1 µA
		SCOPE_TRIG_POS_FRAC: 0.25,
		SCOPE_TRIG_SCAN_MAX: 80000,
		SCOPE_TRIG_HOLDOFF_MIN_PTS: 16,
		CURSOR_HIT_PX: 8,
		EDGE_SEARCH_MAX: 80000,
		ANALYSIS_MAX_SAMPLES: 262144,
		DRAG_THRESHOLD_PX: 4,
	}

	function clamp(v, lo, hi) {
		return v < lo ? lo : (v > hi ? hi : v)
	}

	// ---------- X 轴：视口宽度与缩放 ----------
	/** 当前采样周期下允许的最小 xZoom（视口最宽 ≈ MAX_VIEW_DURATION_SEC） */
	function xZoomMin(periodSec, opts) {
		opts = opts || {}
		const def = opts.defaultPoints || C.DEFAULT_VIEW_POINTS
		const maxDur = opts.maxDurationSec || C.MAX_VIEW_DURATION_SEC
		const period = periodSec > 0 ? periodSec : 1 / 1000
		const maxPts = Math.max(def, Math.ceil(maxDur / period))
		return Math.max(opts.minHard || C.X_ZOOM_MIN_HARD, def / maxPts)
	}

	function clampXZoom(z, periodSec, opts) {
		if (!isFinite(z) || z <= 0) z = 1
		return clamp(z, xZoomMin(periodSec, opts), C.X_ZOOM_MAX)
	}

	/** xZoom → 视口样点数（不超过总点数） */
	function viewPoints(total, xZoom, opts) {
		opts = opts || {}
		const def = opts.defaultPoints || C.DEFAULT_VIEW_POINTS
		const n = Math.max(2, total | 0)
		const z = isFinite(xZoom) && xZoom > 0 ? xZoom : 1
		const pts = Math.max(C.MIN_VIEW_POINTS, Math.round(def / z))
		return Math.min(n, pts)
	}

	/**
	 * 当前视口 [start, end]（闭区间，含两端）。
	 * @param {object} s { total, xZoom, xOffset, live, trigLockLi, periodSec }
	 */
	function viewRange(s) {
		const n = s.total | 0
		if (n < 2) return { start: 0, end: 0, count: 0 }
		const viewPts = viewPoints(n, s.xZoom)
		// 示波器显示触发：把触发点钉在视口固定水平位置
		if (s.trigLockLi != null && isFinite(s.trigLockLi)) {
			const pre = Math.max(0, Math.min(viewPts - 1, Math.round(viewPts * (s.trigPosFrac == null ? C.SCOPE_TRIG_POS_FRAC : s.trigPosFrac))))
			let start = Math.round(s.trigLockLi) - pre
			let end = start + viewPts - 1
			if (start < 0) {
				start = 0
				end = Math.min(n - 1, viewPts - 1)
			}
			if (end >= n) {
				end = n - 1
				start = Math.max(0, end - viewPts + 1)
			}
			if (end < start) end = start
			return { start: start, end: end, count: end - start + 1, viewPts: viewPts, xOffset: Math.max(0, n - 1 - end), trigLocked: true }
		}
		if (s.live) {
			const end = n - 1
			const start = Math.max(0, end - viewPts + 1)
			return { start: start, end: end, count: end - start + 1, viewPts: viewPts, xOffset: 0 }
		}
		let end = n - 1 - Math.max(0, Math.round(s.xOffset || 0))
		let start = end - viewPts + 1
		if (start < 0) {
			start = 0
			end = Math.min(n - 1, start + viewPts - 1)
		}
		if (end >= n) end = n - 1
		if (end < 0) end = 0
		return { start: start, end: end, count: end - start + 1, viewPts: viewPts, xOffset: Math.max(0, n - 1 - end) }
	}

	/** 视口内把逻辑下标换算成像素（plot 区宽度 pw） */
	function indexToPixel(li, range, pw) {
		const span = Math.max(1, range.count - 1)
		return ((li - range.start) / span) * (pw - 1)
	}

	/** 像素 → 逻辑下标（四舍五入并夹在视口内） */
	function pixelToIndex(px, range, pw) {
		if (!(pw > 1)) return range.start
		const span = Math.max(1, range.count - 1)
		const li = range.start + (px / (pw - 1)) * span
		return clamp(Math.round(li), range.start, range.end)
	}

	/**
	 * 以 pixel 处为锚缩放：锚点样点在屏幕上不动。
	 * @returns {{ xZoom:number, xOffset:number }}
	 */
	function zoomAtPoint(s) {
		const n = s.total | 0
		if (n < 2) return { xZoom: s.xZoom, xOffset: 0 }
		const before = viewRange(s)
		const t = s.plotWidth > 1 ? clamp((s.pixel || 0) / (s.plotWidth - 1), 0, 1) : 0.5
		const anchor = before.start + t * Math.max(1, before.count - 1)
		const factor = s.factor > 0 ? s.factor : 1
		// factor > 1 = 放大（视口变窄）
		const newZoom = clampXZoom((s.xZoom || 1) * factor, s.periodSec)
		const newPts = viewPoints(n, newZoom)
		let start = Math.round(anchor - t * Math.max(1, newPts - 1))
		start = clamp(start, 0, Math.max(0, n - newPts))
		return { xZoom: newZoom, xOffset: Math.max(0, n - newPts - start) }
	}

	/** 拖拽平移：内容跟着指针走，xOffset 随之增减（px 右移 = 看更旧的） */
	function panByPixels(s) {
		const n = s.total | 0
		if (n < 2) return { xOffset: 0 }
		const viewPts = viewPoints(n, s.xZoom)
		const pw = s.plotWidth > 1 ? s.plotWidth : 1
		const dPts = ((s.deltaPx || 0) / (pw - 1)) * Math.max(1, viewPts - 1)
		const maxOffset = Math.max(0, n - viewPts)
		return { xOffset: clamp((s.xOffset || 0) + dPts, 0, maxOffset) }
	}

	/** 跟手平移：让逻辑下标 li 落在像素 px 处 */
	function panSoIndexAtPixel(s) {
		const n = s.total | 0
		if (n < 2) return { xOffset: 0 }
		const viewPts = viewPoints(n, s.xZoom)
		const pw = s.plotWidth > 1 ? s.plotWidth : 1
		const t = clamp((s.pixel || 0) / (pw - 1), 0, 1)
		const start = clamp(Math.round(s.index - t * Math.max(1, viewPts - 1)), 0, Math.max(0, n - viewPts))
		return { xOffset: Math.max(0, n - viewPts - start) }
	}

	/** 跳到某下标并居中（保留当前缩放） */
	function centerOnIndex(s) {
		const n = s.total | 0
		if (n < 2) return { xOffset: 0 }
		const viewPts = viewPoints(n, s.xZoom)
		const start = clamp(Math.round(s.index - viewPts / 2), 0, Math.max(0, n - viewPts))
		return { xOffset: Math.max(0, n - viewPts - start) }
	}

	// ---------- Y 轴：linear / log / symlog ----------
	/** 按窗口最小正值自适应 log floor（µA），钳在 [0.1 nA, 1 µA] 并做轻度滞回 */
	function adaptLogFloor(minPositive, cur) {
		const c = cur > 0 ? cur : C.LOG_FLOOR_DEFAULT_UA
		if (!(minPositive > 0) || !isFinite(minPositive)) return c
		let f = minPositive * 0.5
		const exp = Math.floor(Math.log10(f))
		f = Math.pow(10, exp)
		f = clamp(f, C.LOG_FLOOR_MIN_UA, C.LOG_FLOOR_MAX_UA)
		// 抬高 floor 需要最小正值明显更高，否则保持（防噪声台阶跳）
		if (f > c && minPositive < c * 8) return c
		return f
	}

	function logMap(v, floor) {
		const f = floor > 0 ? floor : C.LOG_FLOOR_DEFAULT_UA
		if (!isFinite(v) || v <= f) return Math.log10(f)
		return Math.log10(v)
	}

	function logUnmap(lv, floor) {
		const f = floor > 0 ? floor : C.LOG_FLOOR_DEFAULT_UA
		if (!isFinite(lv)) return f
		return Math.pow(10, lv)
	}

	function asinh(x) {
		// ln(x + sqrt(x²+1))，x 很大时退回 ln(2x) 防溢出
		if (x < 0) return -asinh(-x)
		if (x > 1e8) return Math.log(2 * x)
		return Math.log(x + Math.sqrt(x * x + 1))
	}
	function sinh(x) {
		if (x < 0) return -sinh(-x)
		if (x > 700) return Math.exp(x) / 2
		return (Math.exp(x) - Math.exp(-x)) / 2
	}

	function symlogMap(v, th) {
		const t = th > 0 ? th : C.SYMLOG_LINTHRESH_DEFAULT_UA
		if (!isFinite(v)) return 0
		return asinh(v / t)
	}

	function symlogUnmap(mv, th) {
		const t = th > 0 ? th : C.SYMLOG_LINTHRESH_DEFAULT_UA
		if (!isFinite(mv)) return 0
		return t * sinh(mv)
	}

	function mapValue(v, mode, params) {
		params = params || {}
		if (mode === 'log') return logMap(v, params.floor)
		if (mode === 'symlog') return symlogMap(v, params.linthresh)
		return v
	}

	function unmapValue(mv, mode, params) {
		params = params || {}
		if (mode === 'log') return logUnmap(mv, params.floor)
		if (mode === 'symlog') return symlogUnmap(mv, params.linthresh)
		return mv
	}

	/** Log 自动量程：decade snap + 半 decade 边距（映射域即 log10） */
	function autoLogRange(yMinRaw, yMaxRaw, minPositive, curFloor) {
		const floor = adaptLogFloor(minPositive, curFloor)
		let loLin = (minPositive > 0 && isFinite(minPositive)) ? minPositive : floor
		let hiLin = isFinite(yMaxRaw) ? yMaxRaw : floor * 10
		if (!(hiLin > 0) || !isFinite(hiLin)) hiLin = floor * 10
		loLin = Math.max(floor, loLin)
		hiLin = Math.max(hiLin, loLin * 1.01)
		let mapMin = Math.floor(Math.log10(loLin))
		let mapMax = Math.ceil(Math.log10(hiLin))
		if (mapMax - mapMin < 1) mapMax = mapMin + 1
		const loM = Math.log10(loLin)
		const hiM = Math.log10(hiLin)
		if (loM - mapMin < 0.15) mapMin -= 0.5
		if (mapMax - hiM < 0.15) mapMax += 0.5
		if (mapMax <= mapMin) mapMax = mapMin + 1
		return { mapMin: mapMin, mapMax: mapMax, floor: floor }
	}

	/** Symlog 自动量程：linthresh 带滞回（Live 边界不抖），8% 边距并保证跨过线性区 */
	function autoSymlogRange(yMinRaw, yMaxRaw, curTh, locked) {
		let th
		const cur = curTh > 0 ? curTh : C.SYMLOG_LINTHRESH_DEFAULT_UA
		if (locked && curTh > 0) {
			th = curTh
		} else {
			const span = Math.max(Math.abs(yMinRaw || 0), Math.abs(yMaxRaw || 0), 1e-9)
			if (span < C.SYMLOG_LINTHRESH_DEFAULT_UA * 0.2) {
				const proposed = Math.max(C.LOG_FLOOR_DEFAULT_UA, niceNumber(span / 2))
				th = proposed < cur * 0.5 ? proposed : cur
			} else if (span > cur * 4 && cur < C.SYMLOG_LINTHRESH_DEFAULT_UA) {
				th = C.SYMLOG_LINTHRESH_DEFAULT_UA
			} else {
				th = cur
			}
		}
		let lo = isFinite(yMinRaw) ? yMinRaw : -th
		let hi = isFinite(yMaxRaw) ? yMaxRaw : th
		if (hi < lo) { const t = lo; lo = hi; hi = t }
		const pad = (hi - lo) * 0.08 || th * 0.2
		lo -= pad
		hi += pad
		if (hi - lo < th * 0.5) {
			const mid = (hi + lo) / 2
			lo = mid - th * 0.25
			hi = mid + th * 0.25
		}
		return { mapMin: symlogMap(lo, th), mapMax: symlogMap(hi, th), linthresh: th }
	}

	/** 1/2/5 × 10ⁿ 的「好看」步长 */
	function niceNumber(x) {
		if (!(x > 0) || !isFinite(x)) return 0
		const exp = Math.floor(Math.log10(x))
		const base = Math.pow(10, exp)
		const f = x / base
		const m = f <= 1 ? 1 : (f <= 2 ? 2 : (f <= 5 ? 5 : 10))
		return m * base
	}

	/** 线性自动量程：8% 边距，退化时给一个 1 µA 的窗口 */
	function autoLinearRange(yMin, yMax) {
		let lo = isFinite(yMin) ? yMin : 0
		let hi = isFinite(yMax) ? yMax : 1
		if (!(hi > lo)) {
			const mid = isFinite(lo) ? lo : 0
			lo = mid - 0.5
			hi = mid + 0.5
		}
		const pad = (hi - lo) * 0.08
		return { mapMin: lo - pad, mapMax: hi + pad }
	}

	/**
	 * 组装一次绘制的 Y 映射。yZoom > 1 = 放大（映射域窗口变窄）；
	 * yPan 以「半个窗口」为单位，正值把窗口中心抬高（看更大的电流）。
	 * @returns {{ mode, mapMin, mapMax, params, toFraction(v), fromFraction(f), toPixel(v,h), ticks }}
	 */
	function buildYScale(o) {
		o = o || {}
		const mode = (o.mode === 'log' || o.mode === 'symlog') ? o.mode : 'linear'
		const yZoom = clamp(isFinite(o.yZoom) && o.yZoom > 0 ? o.yZoom : 1, C.Y_ZOOM_MIN, C.Y_ZOOM_MAX)
		const yPan = isFinite(o.yPan) ? o.yPan : 0
		let params = {}
		let base
		if (mode === 'log') {
			base = autoLogRange(o.yMin, o.yMax, o.minPositive, o.floor)
			params.floor = base.floor
		} else if (mode === 'symlog') {
			base = autoSymlogRange(o.yMin, o.yMax, o.linthresh, o.locked)
			params.linthresh = base.linthresh
		} else {
			base = autoLinearRange(o.yMin, o.yMax)
		}
		const span = Math.max(1e-12, base.mapMax - base.mapMin)
		const half = (span / yZoom) / 2
		const mid = (base.mapMin + base.mapMax) / 2 + yPan * (span / 2)
		let mapMin = mid - half
		let mapMax = mid + half
		if (mode === 'log') {
			// log 下不允许越过 floor
			const floorM = Math.log10(params.floor)
			if (mapMin < floorM) {
				const d = floorM - mapMin
				mapMin = floorM
				mapMax += d
			}
		}
		if (mapMax - mapMin < 1e-12) mapMax = mapMin + 1e-12
		const mapMinFinal = mapMin
		const mapMaxFinal = mapMax
		function toFraction(v) {
			const mv = mapValue(v, mode, params)
			return (mv - mapMinFinal) / (mapMaxFinal - mapMinFinal)
		}
		function fromFraction(f) {
			return unmapValue(mapMinFinal + f * (mapMaxFinal - mapMinFinal), mode, params)
		}
		let ticks
		if (mode === 'log') ticks = buildLogTicks(fromFraction(0), fromFraction(1), params.floor)
		else if (mode === 'symlog') ticks = buildSymlogTicks(fromFraction(0), fromFraction(1), params.linthresh)
		else ticks = linearTicks(fromFraction(0), fromFraction(1))
		return {
			mode: mode,
			params: params,
			mapMin: mapMinFinal,
			mapMax: mapMaxFinal,
			yZoom: yZoom,
			yPan: yPan,
			toFraction: toFraction,
			fromFraction: fromFraction,
			toPixel: function (v, h) { return h - toFraction(v) * h },
			fromPixel: function (py, h) { return fromFraction(1 - (h > 0 ? py / h : 0)) },
			ticks: ticks,
		}
	}

	/** 线性刻度：4 条 nice 步长的主刻度 */
	function linearTicks(linMin, linMax) {
		const lo = Math.min(linMin, linMax)
		const hi = Math.max(linMin, linMax)
		const step = niceNumber((hi - lo) / 4) || (hi - lo) / 4 || 1
		const major = []
		const start = Math.ceil(lo / step) * step
		for (let v = start; v <= hi + step * 1e-9; v += step) major.push(Math.abs(v) < step * 1e-9 ? 0 : v)
		return { major: major, minor: [], faint: [] }
	}

	/** Log 刻度：decade 主刻度 + 2/5 次刻度 + 3,4,6,7,8,9 淡线 */
	function buildLogTicks(linMin, linMax, floor) {
		const f = floor > 0 ? floor : C.LOG_FLOOR_DEFAULT_UA
		const lo = Math.max(f, Math.min(linMin, linMax))
		const hi = Math.max(lo * 1.0001, Math.max(linMin, linMax))
		const exp0 = Math.floor(Math.log10(lo))
		const exp1 = Math.ceil(Math.log10(hi))
		const major = []
		const minor = []
		const faint = []
		for (let e = exp0; e <= exp1; e++) {
			const base = Math.pow(10, e)
			if (base >= lo * 0.999 && base <= hi * 1.001) major.push(base)
			for (let m = 2; m <= 9; m++) {
				const v = m * base
				if (v < lo * 0.999 || v > hi * 1.001) continue
				if (m === 2 || m === 5) minor.push(v)
				else faint.push(v)
			}
		}
		return { major: major, minor: minor, faint: faint }
	}

	/** Symlog 刻度：0 附近线性步长 + 外侧 decade */
	function buildSymlogTicks(linMin, linMax, linthresh) {
		const th = linthresh > 0 ? linthresh : C.SYMLOG_LINTHRESH_DEFAULT_UA
		const lo = Math.min(linMin, linMax)
		const hi = Math.max(linMin, linMax)
		const major = []
		const minor = []
		const faint = []
		const linLo = Math.max(lo, -th)
		const linHi = Math.min(hi, th)
		if (linHi > linLo) {
			const step = niceNumber((linHi - linLo) / 4) || th / 2
			const g0 = Math.floor(linLo / step) * step
			for (let v = g0; v <= linHi + step * 0.01; v += step) {
				if (v >= lo - step * 0.01 && v <= hi + step * 0.01) major.push(Math.abs(v) < step * 1e-9 ? 0 : v)
			}
		}
		function outer(sign) {
			const a0 = Math.max(th, sign > 0 ? Math.max(th, lo) : Math.max(th, -hi))
			const a1 = sign > 0 ? Math.max(a0, hi) : Math.max(a0, -lo)
			if (!(a1 > th * 0.5)) return
			const t = buildLogTicks(Math.max(th, a0), a1, th)
			for (let i = 0; i < t.major.length; i++) major.push(sign * t.major[i])
			for (let i = 0; i < t.minor.length; i++) minor.push(sign * t.minor[i])
			for (let i = 0; i < t.faint.length; i++) faint.push(sign * t.faint[i])
		}
		if (hi > th) outer(1)
		if (lo < -th) outer(-1)
		function uniq(arr) {
			arr.sort(function (a, b) { return a - b })
			const out = []
			for (let i = 0; i < arr.length; i++) {
				if (!out.length || Math.abs(arr[i] - out[out.length - 1]) > 1e-15 * Math.max(1, Math.abs(arr[i]))) out.push(arr[i])
			}
			return out
		}
		return { major: uniq(major), minor: uniq(minor), faint: uniq(faint) }
	}

	// ---------- 游标与框选 ----------
	function clampIndex(li, total) {
		if (li == null || !isFinite(li) || total < 1) return null
		return clamp(Math.round(li), 0, total - 1)
	}

	function selection(cursorA, cursorB, total) {
		const a = clampIndex(cursorA, total)
		const b = clampIndex(cursorB, total)
		if (a == null || b == null) return null
		return a <= b ? { a: a, b: b } : { a: b, b: a }
	}

	/** 命中测试：返回靠近哪条游标 */
	function cursorHit(px, xa, xb, hitPx) {
		const h = hitPx > 0 ? hitPx : C.CURSOR_HIT_PX
		const da = xa == null ? Infinity : Math.abs(px - xa)
		const db = xb == null ? Infinity : Math.abs(px - xb)
		if (da <= h && da <= db) return 'a'
		if (db <= h) return 'b'
		return null
	}

	/** 框选：从起点拖到当前点的下标（含两端） */
	function boxSelect(anchorLi, currentLi, total) {
		return selection(anchorLi, currentLi, total)
	}

	// ---------- 示波器式显示触发 ----------
	function createScopeTrigger() {
		return { state: 0, lockLi: null, lastLi: null, periodPts: null }
	}

	function scopeHoldoffPts(periodPts, viewPts) {
		if (periodPts != null && periodPts > 4) return Math.max(C.SCOPE_TRIG_HOLDOFF_MIN_PTS, Math.floor(periodPts * 0.55))
		return Math.max(C.SCOPE_TRIG_HOLDOFF_MIN_PTS, Math.floor((viewPts || 100) * 0.05))
	}

	/**
	 * 在 [from,to] 扫沿（sampleAt(i) 取电流 µA）。
	 * 超长区间只扫尾部，并用扫窗前一点重 seed，避免假沿。
	 * @returns {{ fired:number|null, lockLi:number|null, periodPts:number|null, truncated:boolean, state:number }}
	 */
	function scanScopeTrigger(trig, o) {
		const mode = o.mode || 'off'
		if (mode === 'off') return { fired: null, lockLi: trig.lockLi, periodPts: trig.periodPts, truncated: false, state: trig.state }
		const n = o.total | 0
		if (n < 3) return { fired: null, lockLi: trig.lockLi, periodPts: trig.periodPts, truncated: false, state: trig.state }
		let from = Math.max(1, o.from | 0)
		let to = Math.min(n - 1, o.to | 0)
		if (to < from) return { fired: null, lockLi: trig.lockLi, periodPts: trig.periodPts, truncated: false, state: trig.state }
		let truncated = false
		const scanMax = o.scanMax || C.SCOPE_TRIG_SCAN_MAX
		if (to - from + 1 > scanMax) {
			from = to - scanMax + 1
			truncated = true
		}
		const thr = o.thr
		const hyst = o.hyst > 0 ? o.hyst : Math.max(Math.abs(thr) * 0.01, 1e-9)
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		let state = truncated ? 0 : trig.state
		const sampleAt = o.sampleAt
		if (state === 0) {
			const v0 = sampleAt(Math.max(0, from - 1))
			if (isFinite(v0)) {
				if (v0 >= thrHi) state = 1
				else if (v0 <= thrLo) state = -1
			}
		}
		const holdoff = o.holdoff > 0 ? o.holdoff : scopeHoldoffPts(trig.periodPts, o.viewPts)
		let fired = null
		for (let i = from; i <= to; i++) {
			const v = sampleAt(i)
			if (!isFinite(v)) continue
			let edge = null
			if (state <= 0 && v >= thrHi) {
				edge = 'rise'
				state = 1
			} else if (state >= 0 && v <= thrLo) {
				edge = 'fall'
				state = -1
			} else if (state === 0) {
				if (v >= thrHi) state = 1
				else if (v <= thrLo) state = -1
			}
			if (!edge) continue
			if (mode === 'rise' && edge !== 'rise') continue
			if (mode === 'fall' && edge !== 'fall') continue
			if (trig.lastLi != null && (i - trig.lastLi) < holdoff) continue
			fired = i
			// 继续扫到本批最后一个合格沿：示波器连续触发，钉住最新周期
		}
		trig.state = state
		if (fired == null) return { fired: null, lockLi: trig.lockLi, periodPts: trig.periodPts, truncated: truncated, state: state }
		if (trig.lastLi != null) {
			const dp = fired - trig.lastLi
			if (dp > 4) trig.periodPts = trig.periodPts == null ? dp : (trig.periodPts * 0.65 + dp * 0.35)
		}
		trig.lastLi = fired
		trig.lockLi = fired
		return { fired: fired, lockLi: fired, periodPts: trig.periodPts, truncated: truncated, state: state }
	}

	function resetScopeTrigger(trig) {
		trig.state = 0
		trig.lockLi = null
		trig.lastLi = null
		trig.periodPts = null
	}

	/** 自动触发电平：近期窗口 min/max 中点 */
	function autoTrigLevel(rangeMinMax) {
		if (!rangeMinMax) return 0
		return (rangeMinMax.min + rangeMinMax.max) * 0.5
	}

	/** 触发滞回：窗口 span 的 3%（至少 1%） */
	function trigHysteresis(rangeMinMax, thr) {
		if (rangeMinMax) {
			const span = Math.abs(rangeMinMax.max - rangeMinMax.min)
			return Math.max(span * 0.03, Math.abs(thr) * 0.01, 1e-9)
		}
		return Math.max(Math.abs(thr) * 0.05, 1e-9)
	}

	// ---------- 采样沿触发 ----------
	function createAcqTrigger() {
		return {
			start: 'off',
			stop: 'off',
			startState: 0,
			stopState: 0,
			storeEnabled: true,
			startLatched: false,
			preMin: Infinity,
			preMax: -Infinity,
		}
	}

	function acqTriggeredEdgeLevel(iUA, trg) {
		// 冷启动退化：还没有缓冲时用电平本身做种子
		if (isFinite(trg.preMin) && trg.preMax > trg.preMin) return (trg.preMin + trg.preMax) * 0.5
		return isFinite(iUA) ? iUA : 0
	}

	/**
	 * 逐点喂入采样沿状态机。
	 * @param {object} trg createAcqTrigger() 的状态
	 * @param {object} o { iUA, kind:'start'|'stop', thr, hyst, seedOnly }
	 * @returns {boolean} 本点是否产生匹配边沿
	 */
	function feedAcqEdge(trg, o) {
		const iUA = o.iUA
		if (!isFinite(iUA)) return false
		const mode = o.kind === 'stop' ? trg.stop : trg.start
		if (mode === 'off') return false
		// 等待入库阶段累计 pre-range（供 Auto 电平）
		if (!trg.storeEnabled) {
			if (iUA < trg.preMin) trg.preMin = iUA
			if (iUA > trg.preMax) trg.preMax = iUA
		}
		const thr = isFinite(o.thr) ? o.thr : acqTriggeredEdgeLevel(iUA, trg)
		let hyst
		if (o.hyst > 0) hyst = o.hyst
		else if (isFinite(trg.preMin) && trg.preMax > trg.preMin) hyst = Math.max((trg.preMax - trg.preMin) * 0.05, Math.abs(thr) * 0.02, 1e-6)
		else hyst = Math.max(Math.abs(thr) * 0.05, Math.abs(iUA) * 0.03, 1e-6)
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		let state = o.kind === 'stop' ? trg.stopState : trg.startState
		let edge = null
		// unknown 只 seed、不产生沿：避免启动瞬间「已在高电平」的假触发
		if (state === 0) {
			if (iUA >= thrHi) state = 1
			else if (iUA <= thrLo) state = -1
		} else if (state < 0 && iUA >= thrHi) {
			edge = 'rise'
			state = 1
		} else if (state > 0 && iUA <= thrLo) {
			edge = 'fall'
			state = -1
		}
		if (o.kind === 'stop') trg.stopState = state
		else trg.startState = state
		if (o.seedOnly) return false
		if (!edge) return false
		if (mode === 'rise' && edge !== 'rise') return false
		if (mode === 'fall' && edge !== 'fall') return false
		// 配了启动沿但还没命中启动：忽略停沿
		if (o.kind === 'stop' && trg.start !== 'off' && !trg.startLatched) return false
		return true
	}

	/** 改启动沿模式：未采样时复位等待态；等沿中改回 off 要立刻开闸 */
	function setAcqStartMode(trg, mode, sampling) {
		const next = (mode === 'rise' || mode === 'fall' || mode === 'either') ? mode : 'off'
		trg.start = next
		if (!sampling) {
			trg.storeEnabled = true
			trg.startState = 0
		} else if (next === 'off' && !trg.storeEnabled) {
			trg.storeEnabled = true
			trg.startLatched = true
			trg.stopState = 0
		}
		return trg
	}

	function setAcqStopMode(trg, mode, sampling) {
		trg.stop = (mode === 'rise' || mode === 'fall' || mode === 'either') ? mode : 'off'
		if (sampling) trg.stopState = 0
		return trg
	}

	// ---------- 停滞看门狗 ----------
	/**
	 * 长时间没有新样点 → 提示并标缺口，不自动重连。
	 * @param {object} o { now, setInterval, clearInterval, intervalMs, thresholdMs, onStall, onResume }
	 */
	function createStallWatch(o) {
		o = o || {}
		const now = typeof o.now === 'function' ? o.now : function () { return Date.now() }
		const setIv = typeof o.setInterval === 'function' ? o.setInterval : null
		const clearIv = typeof o.clearInterval === 'function' ? o.clearInterval : null
		const intervalMs = o.intervalMs > 0 ? o.intervalMs : 500
		const thresholdMs = o.thresholdMs > 0 ? o.thresholdMs : 2000
		let last = 0
		let timer = 0
		let stalled = false
		let active = false
		const api = {
			start: function () {
				api.stop()
				active = true
				stalled = false
				last = now()
				if (setIv) {
					timer = setIv(function () { api.check() }, intervalMs)
					if (timer && typeof timer.unref === 'function') timer.unref()
				}
				return api
			},
			stop: function () {
				active = false
				stalled = false
				if (timer && clearIv) clearIv(timer)
				timer = 0
				return api
			},
			note: function () {
				last = now()
				if (stalled) {
					stalled = false
					if (typeof o.onResume === 'function') o.onResume()
				}
				return api
			},
			check: function (atMs) {
				if (!active) return { stalled: false, idleMs: 0 }
				const t = typeof atMs === 'number' ? atMs : now()
				const idle = t - last
				if (idle > thresholdMs && !stalled) {
					stalled = true
					if (typeof o.onStall === 'function') o.onStall({ idleMs: idle })
				}
				return { stalled: stalled, idleMs: idle }
			},
			status: function () {
				return { active: active, stalled: stalled, idleMs: active ? now() - last : 0 }
			},
		}
		return api
	}

	/**
	 * 看门狗命中时判断是哪一种「没数据」：设备完全无应答 / 收到字节但解不出样点 / 有过数据后中断。
	 * 三种原因处理方式不同，界面必须说清楚，不能都叫「中断」。
	 * @param {{ idleMs: number, rxBytes: number, samples: number }} o 采样开始以来的增量
	 */
	function describeStall(o) {
		o = o || {}
		const sec = ((Number(o.idleMs) || 0) / 1000).toFixed(1)
		const rx = Math.max(0, Number(o.rxBytes) || 0)
		const n = Math.max(0, Number(o.samples) || 0)
		if (rx === 0) {
			return { kind: 'no_response', level: 'error', message: tr('view.no_response', { sec: sec }) }
		}
		if (n === 0) {
			return { kind: 'undecodable', level: 'error', message: tr('view.undecodable', { bytes: rx }) }
		}
		return { kind: 'stall', level: 'warn', message: tr('view.stall', { sec: sec }) }
	}

	// ---------- 总览条（minimap） ----------
	/** 总览条里视口框的像素区间 */
	function minimapViewRect(o) {
		const w = Math.max(1, o.width || 1)
		const total = Math.max(1, o.total || 1)
		const range = o.range || { start: 0, end: total - 1 }
		const x0 = (range.start / Math.max(1, total - 1)) * w
		const x1 = (range.end / Math.max(1, total - 1)) * w
		return { x0: x0, x1: x1, w: Math.max(2, x1 - x0) }
	}

	/** 总览条点击 → 以该位置为中心的下标 */
	function minimapSeekIndex(o) {
		const w = Math.max(1, o.width || 1)
		const total = Math.max(1, o.total || 1)
		const t = clamp((o.px || 0) / w, 0, 1)
		return Math.round(t * (total - 1))
	}

	const api = {
		C: C,
		clamp: clamp,
		xZoomMin: xZoomMin,
		clampXZoom: clampXZoom,
		viewPoints: viewPoints,
		viewRange: viewRange,
		indexToPixel: indexToPixel,
		pixelToIndex: pixelToIndex,
		zoomAtPoint: zoomAtPoint,
		panByPixels: panByPixels,
		panSoIndexAtPixel: panSoIndexAtPixel,
		centerOnIndex: centerOnIndex,
		adaptLogFloor: adaptLogFloor,
		logMap: logMap,
		logUnmap: logUnmap,
		symlogMap: symlogMap,
		symlogUnmap: symlogUnmap,
		mapValue: mapValue,
		unmapValue: unmapValue,
		autoLogRange: autoLogRange,
		autoSymlogRange: autoSymlogRange,
		autoLinearRange: autoLinearRange,
		niceNumber: niceNumber,
		buildYScale: buildYScale,
		buildLogTicks: buildLogTicks,
		buildSymlogTicks: buildSymlogTicks,
		linearTicks: linearTicks,
		clampIndex: clampIndex,
		selection: selection,
		cursorHit: cursorHit,
		boxSelect: boxSelect,
		createScopeTrigger: createScopeTrigger,
		scanScopeTrigger: scanScopeTrigger,
		resetScopeTrigger: resetScopeTrigger,
		scopeHoldoffPts: scopeHoldoffPts,
		autoTrigLevel: autoTrigLevel,
		trigHysteresis: trigHysteresis,
		createAcqTrigger: createAcqTrigger,
		feedAcqEdge: feedAcqEdge,
		acqTriggeredEdgeLevel: acqTriggeredEdgeLevel,
		setAcqStartMode: setAcqStartMode,
		setAcqStopMode: setAcqStopMode,
		createStallWatch: createStallWatch,
		describeStall: describeStall,
		minimapViewRect: minimapViewRect,
		minimapSeekIndex: minimapSeekIndex,
	}
	global.PowerView = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
