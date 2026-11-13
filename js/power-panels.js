// 分析面板的纯计算：区间挑选、抽稀、游标读数（不跨缺口）、边沿/周期测量、FFT、电池、周期叠画。
// 只读 blu-wave 的接口（stats / iAt / segments / gaps），不碰 DOM，所以全部在 node 里可回归。
//
// 硬约束：
//  - 游标之间的时长、电量、能量必须与统计同口径：缺口切开的段各自累加，绝不跨缺口；
//    同时把「墙上时长」和「缺口占比」单独给出来，让用户知道差在哪。
//  - 抽稀只为了喂分析算法（FFT 有 nfft 上限），不能改变下游的 rateHz。
;(function (global) {
	'use strict'

	const VIEW = global.PowerView || (typeof require === 'function' ? require('./power-view.js') : null)
	const ANAL = global.PowerAnalysis || (typeof require === 'function' ? require('./power-analysis.js') : null)

	const MAX_SAMPLES_DEFAULT = 262144
	const EDGE_SEARCH_MAX = 80000

	function clampIndex(li, total) {
		if (li == null || !isFinite(li) || total < 1) return null
		return Math.max(0, Math.min(total - 1, Math.round(li)))
	}

	/**
	 * 分析区间：auto（有选择用选择，否则窗口）/ selection / window。
	 * @param {object} o { mode, total, selection, viewRange }
	 */
	function pickRange(o) {
		const total = o.total | 0
		if (total < 2) return null
		const mode = o.mode === 'selection' || o.mode === 'window' ? o.mode : 'auto'
		const sel = o.selection || null
		const vr = o.viewRange || null
		const fromSelection = function () {
			if (!sel) return null
			let a = clampIndex(sel.a, total)
			let b = clampIndex(sel.b, total)
			if (a == null || b == null) return null
			// 反向选择也要能分析：先排序再看区间长度
			if (a > b) { const t = a; a = b; b = t }
			if (b - a < 1) return null
			return { a: a, b: b, source: 'selection' }
		}
		const fromWindow = function () {
			if (!vr || vr.count < 2) return null
			return { a: vr.start, b: vr.end, source: 'window' }
		}
		if (mode === 'selection') return fromSelection()
		if (mode === 'window') return fromWindow()
		return fromSelection() || fromWindow()
	}

	/**
	 * 抽稀取区间样点（数组 + 有效速率）。
	 * @param {object} wave
	 * @param {number} a
	 * @param {number} b 含
	 * @param {object} opts { maxPts }
	 */
	function extractSamples(wave, a, b, opts) {
		opts = opts || {}
		const total = wave.total()
		a = clampIndex(a, total)
		b = clampIndex(b, total)
		if (a == null || b == null) return null
		if (a > b) { const t = a; a = b; b = t }
		const nRaw = b - a + 1
		if (nRaw < 1) return null
		const maxPts = opts.maxPts > 0 ? opts.maxPts : MAX_SAMPLES_DEFAULT
		const step = nRaw > maxPts ? Math.ceil(nRaw / maxPts) : 1
		const nOut = Math.floor((nRaw - 1) / step) + 1
		const samples = new Float32Array(nOut)
		let j = 0
		for (let li = a; li <= b; li += step) {
			const v = wave.iAt(li)
			samples[j++] = isFinite(v) ? v : 0
		}
		const basePeriod = o0(opts)
		return {
			samples: samples,
			step: step,
			a: a,
			b: b,
			nRaw: nRaw,
			periodSec: basePeriod * step,
			basePeriodSec: basePeriod,
		}
	}

	function o0(opts) {
		const p = opts && opts.samplePeriodSec > 0 ? opts.samplePeriodSec : 0
		return p
	}

	/** 区间内缺口数 / 缺口切开的段 */
	function rangeGaps(wave, a, b) {
		const gaps = typeof wave.gaps === 'function' ? wave.gaps() : []
		let n = 0
		for (let i = 0; i < gaps.length; i++) {
			const g = gaps[i]
			if (g > a && g <= b) n++
		}
		const segs = typeof wave.segments === 'function' ? wave.segments(a, b + 1) : [[a, b + 1]]
		return { count: n, segments: segs }
	}

	/**
	 * 游标读数：时长 / 均值 / 电量 / 能量 / 缺口。
	 * 时长与能量按段累加（不跨缺口），墙上时长另行给出并带上缺口占比。
	 */
	function measureCursors(wave, a, b, opts) {
		opts = opts || {}
		const per = opts.samplePeriodSec > 0 ? opts.samplePeriodSec : 0
		const out = {
			a: a, b: b, ready: false, samples: 0, gaps: 0, segments: 0,
			wallSec: 0, durSec: 0, gapRatio: 0,
			avgI: 0, minI: 0, maxI: 0, ppI: 0,
			chargeUC: 0, chargeUAh: 0, energyUWh: 0,
			iA: 0, iB: 0, deltaI: null, deltaSec: 0,
		}
		if (a == null || b == null) return out
		if (b < a) { const t = a; a = b; b = t }
		const total = wave.total()
		if (total < 1 || b > total - 1 || a < 0) return out
		const st = wave.stats(a, b + 1)
		const rg = rangeGaps(wave, a, b)
		out.a = a
		out.b = b
		out.samples = b - a + 1
		out.gaps = rg.count
		out.segments = rg.segments.length
		out.wallSec = per > 0 ? (b - a) * per : 0
		out.durSec = st.dur
		out.gapRatio = out.wallSec > 0 ? Math.max(0, 1 - out.durSec / out.wallSec) : 0
		out.avgI = st.avgI
		out.minI = st.minI
		out.maxI = st.maxI
		out.ppI = st.maxI - st.minI
		out.chargeUC = st.chargeUC
		out.chargeUAh = st.chargeUAh
		out.energyUWh = st.energyUWh
		out.iA = wave.iAt(a)
		out.iB = wave.iAt(b)
		out.deltaI = isFinite(out.iA) && isFinite(out.iB) ? out.iB - out.iA : null
		out.deltaSec = out.wallSec
		out.ready = st.n > 0
		return out
	}

	/**
	 * 找区间内的上升 / 下降沿（含位置），供周期测量与游标吸附共用。
	 * @returns {{ thr:number, hyst:number, rises:number[], falls:number[], step:number }}
	 */
	function findEdges(wave, a, b, opts) {
		opts = opts || {}
		const total = wave.total()
		const out = { thr: opts.thr, hyst: opts.hyst > 0 ? opts.hyst : 0, rises: [], falls: [], step: 1 }
		const aa = clampIndex(a, total)
		const bb = clampIndex(b, total)
		if (aa == null || bb == null || bb <= aa || total < 3) return out
		let thr = opts.thr
		let hyst = opts.hyst
		if (!isFinite(thr) || !(hyst > 0)) {
			const st = wave.stats(aa, bb + 1)
			if (!isFinite(thr)) thr = (st.minI + st.maxI) * 0.5
			if (!(hyst > 0)) hyst = Math.max(Math.abs(st.maxI - st.minI) * 0.02, Math.abs(thr) * 0.005, 1e-9)
		}
		out.thr = thr
		out.hyst = hyst
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		const span = bb - aa
		const step = span > EDGE_SEARCH_MAX ? Math.ceil(span / EDGE_SEARCH_MAX) : 1
		out.step = step
		let state = 0
		const v0 = wave.iAt(aa)
		if (isFinite(v0)) {
			if (v0 >= thrHi) state = 1
			else if (v0 <= thrLo) state = -1
		}
		for (let i = aa + step; i <= bb; i += step) {
			const v = wave.iAt(i)
			if (!isFinite(v)) continue
			if (state <= 0 && v >= thrHi) {
				out.rises.push(i)
				state = 1
			} else if (state >= 0 && v <= thrLo) {
				out.falls.push(i)
				state = -1
			} else if (state === 0) {
				if (v >= thrHi) state = 1
				else if (v <= thrLo) state = -1
			}
		}
		return out
	}

	/** 离 want 最近的沿（上升 / 下降都算），超出 maxDist 返回 null */
	function nearestEdge(wave, a, b, want, maxDist, opts) {
		const ed = findEdges(wave, a, b, opts)
		let best = null
		let bestD = maxDist > 0 ? maxDist : Infinity
		const all = ed.rises.concat(ed.falls)
		for (let i = 0; i < all.length; i++) {
			const d = Math.abs(all[i] - want)
			if (d <= bestD) { bestD = d; best = all[i] }
		}
		return best == null ? null : { index: best, dist: bestD, thr: ed.thr }
	}

	/**
	 * 区间边沿测量：上升沿周期 / 频率 / 占空比（与游标统计同样的抽稀上限）。
	 */
	function measureEdges(wave, a, b, opts) {
		opts = opts || {}
		const per = opts.samplePeriodSec > 0 ? opts.samplePeriodSec : 0
		const out = { thr: opts.thr, hyst: opts.hyst || 0, nRise: 0, nFall: 0, periodSec: null, freqHz: null, duty: null, nPeriod: 0, step: 1 }
		const total = wave.total()
		a = clampIndex(a, total)
		b = clampIndex(b, total)
		if (a == null || b == null || b <= a || total < 3) return out
		const ed = findEdges(wave, a, b, opts)
		const thr = ed.thr
		const hyst = ed.hyst
		out.thr = thr
		out.hyst = hyst
		out.step = ed.step
		const rises = ed.rises
		const falls = ed.falls
		out.nRise = rises.length
		out.nFall = falls.length
		const periodSec = per * ed.step
		if (rises.length >= 2 && periodSec > 0) {
			let sumP = 0
			let nP = 0
			for (let k = 1; k < rises.length; k++) {
				const dp = rises[k] - rises[k - 1]
				if (dp > 0) { sumP += dp; nP++ }
			}
			if (nP > 0) {
				out.periodSec = (sumP / nP) * periodSec
				out.freqHz = out.periodSec > 0 ? 1 / out.periodSec : null
				out.nPeriod = nP
				if (falls.length && rises.length >= 2) {
					let sumDuty = 0
					let nD = 0
					for (let k = 0; k < rises.length - 1; k++) {
						const r0 = rises[k]
						const r1 = rises[k + 1]
						let f = null
						for (let j = 0; j < falls.length; j++) {
							if (falls[j] > r0 && falls[j] < r1) { f = falls[j]; break }
						}
						if (f != null && r1 > r0) { sumDuty += (f - r0) / (r1 - r0); nD++ }
					}
					if (nD > 0) out.duty = sumDuty / nD
				}
			}
		}
		return out
	}

	/**
	 * 组装一次分析（读数 + 双电平 + 边沿 + 可选 FFT / 周期叠画 / 电池）。
	 * @param {object} o { wave, range, samplePeriodSec, voltageMv, capacityMah, fft, cycles, maxSamples }
	 */
	function buildPack(o) {
		o = o || {}
		const wave = o.wave
		const range = o.range
		if (!wave || !range) return null
		const per = o.samplePeriodSec > 0 ? o.samplePeriodSec : 0
		const ext = extractSamples(wave, range.a, range.b, { maxPts: o.maxSamples, samplePeriodSec: per })
		if (!ext) return null
		const measure = measureCursors(wave, ext.a, ext.b, { samplePeriodSec: per })
		const basic = ANAL ? ANAL.basicStats(ext.samples) : null
		const edges = measureEdges(wave, ext.a, ext.b, { samplePeriodSec: per })
		const thr = isFinite(edges.thr) ? edges.thr : (basic ? (basic.min + basic.max) * 0.5 : 0)
		const levels = ANAL ? ANAL.twoLevelStats(ext.samples, thr, Math.abs(basic ? basic.pp * 0.02 : 0)) : null
		const volts = o.voltageMv != null ? o.voltageMv / 1000 : 0
		// 能量按**本次分析用的源电压**换算（波形块里记的是采样当时的电压），并沿用缺口口径的时长
		if (volts > 0) {
			measure.energyUWh = measure.avgI * volts * measure.durSec / 3600
			measure.energySource = 'pack_voltage'
		}
		const pack = {
			source: range.source,
			a: ext.a,
			b: ext.b,
			step: ext.step,
			nRaw: ext.nRaw,
			rateHz: ext.periodSec > 0 ? 1 / ext.periodSec : 0,
			periodSec: ext.periodSec,
			basic: basic,
			levels: levels,
			edges: edges,
			measure: measure,
			voltageV: volts,
			// 每周期的电量（有周期才有意义）
			qCycle: edges.periodSec != null && basic && basic.n ? basic.avg * edges.periodSec : null,
			fft: null,
			cycles: null,
			battery: null,
			spikes: null,
			segments: null,
		}
		if (o.fft && ANAL && ext.samples.length >= 16 && pack.rateHz > 0) {
			pack.fft = ANAL.fftAnalysis(ext.samples, pack.rateHz, { window: o.window || 'hann', topK: 8 })
		}
		if (o.cycles && ANAL && edges.periodSec != null && per > 0) {
			const periodPts = Math.max(4, Math.round(edges.periodSec / per))
			if (periodPts * 2 <= ext.nRaw) {
				pack.cycles = ANAL.extractCycles(ext.samples, Math.max(4, Math.round(edges.periodSec / ext.periodSec)), o.maxCycles)
			}
		}
		if (o.capacityMah > 0 && ANAL && basic && basic.n) {
			pack.battery = ANAL.estimateBatteryLife(basic.avg, o.capacityMah, { derate: 0.9 })
		}
		if (o.spikes && ANAL) {
			pack.spikes = ANAL.findSpikes(ext.samples, { thr: null, minWidthPts: Math.max(1, Math.round((o.spikeMinPts || 2) / ext.step)), maxCount: 60 })
		}
		if (o.segments && ANAL) {
			pack.segments = ANAL.segmentByThreshold(ext.samples, thr, { minSegPts: Math.max(2, Math.round(2 / ext.step)), maxCount: 60 })
		}
		return pack
	}

	// ---------- 格式化（面板与游标共用一套口径） ----------
	function fmtCurrent(ua) {
		if (!isFinite(ua)) return '--'
		const a = Math.abs(ua)
		if (a >= 1e6) return (ua / 1e6).toFixed(3) + ' A'
		if (a >= 1e3) return (ua / 1e3).toFixed(3) + ' mA'
		if (a >= 1) return ua.toFixed(2) + ' µA'
		if (a === 0) return '0 µA'
		return ua.toFixed(3) + ' µA'
	}
	function fmtPower(uw) {
		if (!isFinite(uw)) return '--'
		const a = Math.abs(uw)
		if (a >= 1e6) return (uw / 1e6).toFixed(3) + ' W'
		if (a >= 1e3) return (uw / 1e3).toFixed(2) + ' mW'
		return uw.toFixed(1) + ' µW'
	}
	function fmtCharge(uc) {
		if (!isFinite(uc)) return '--'
		const a = Math.abs(uc)
		if (a >= 1e6) return (uc / 1e6).toFixed(3) + ' C'
		if (a >= 1e3) return (uc / 1e3).toFixed(3) + ' mC'
		return uc.toFixed(2) + ' µC'
	}
	function fmtEnergy(uwh) {
		if (!isFinite(uwh)) return '--'
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
	function fmtFreq(hz) {
		if (hz == null || !isFinite(hz) || hz <= 0) return '--'
		if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz'
		if (hz >= 1e3) return (hz / 1e3).toFixed(3) + ' kHz'
		if (hz >= 1) return hz.toFixed(3) + ' Hz'
		if (hz >= 1e-3) return (hz * 1e3).toFixed(3) + ' mHz'
		return hz.toExponential(2) + ' Hz'
	}
	function fmtPercent(x) {
		if (!isFinite(x)) return '--'
		return (x * 100).toFixed(1) + '%'
	}

	const api = {
		MAX_SAMPLES_DEFAULT: MAX_SAMPLES_DEFAULT,
		pickRange: pickRange,
		extractSamples: extractSamples,
		rangeGaps: rangeGaps,
		measureCursors: measureCursors,
		measureEdges: measureEdges,
		findEdges: findEdges,
		nearestEdge: nearestEdge,
		buildPack: buildPack,
		fmtCurrent: fmtCurrent,
		fmtPower: fmtPower,
		fmtCharge: fmtCharge,
		fmtEnergy: fmtEnergy,
		fmtDuration: fmtDuration,
		fmtFreq: fmtFreq,
		fmtPercent: fmtPercent,
	}
	global.PowerPanels = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
