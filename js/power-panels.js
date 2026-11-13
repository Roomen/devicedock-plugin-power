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
	 * 从「真实样点」抽取区间数据：按连续段分别抽稀，段与段之间绝不拼接。
	 *
	 * 冷块先等回读（wave.walkExact 内部 await）；回读失败或已淘汰的区间记为 unusable，
	 * 绝不用块级 min/max 中点之类的近似值冒充实测。
	 *
	 * @returns {Promise<{ segments: { samples: Float32Array, lo: number, hi: number, step: number, volts: number }[],
	 *   a: number, b: number, nRaw: number, unusable: {lo:number,hi:number,kind:string}[],
	 *   missing: number, dropped: number } | null>}
	 */
	async function extractSegmentsExact(wave, a, b, opts) {
		opts = opts || {}
		const total = wave.total()
		const a0 = clampIndex(a, total)
		const b0 = clampIndex(b, total)
		if (a0 == null || b0 == null) return null
		const lo0 = Math.min(a0, b0)
		const hi0 = Math.max(a0, b0)
		const maxPts = opts.maxPts > 0 ? opts.maxPts : MAX_SAMPLES_DEFAULT
		const out = {
			segments: [],
			a: lo0,
			b: hi0,
			nRaw: hi0 - lo0 + 1,
			unusable: [],
			missing: 0,
			dropped: 0,
			gaps: 0,
			volts: 0,
			voltsMixed: false,
			aborted: false,
		}
		// 每段先收原始值（Float32Array 拼装），再按全区间统一抽稀比降采样，保证速率一致
		let rawTotal = 0
		const runs = []
		// 断点事件之后的第一个样点必须开新段：缺口是零宽的，按「下标相接」判定会把它吞掉
		let newRun = true
		const summary = await wave.walkExact(lo0, hi0 + 1, function (ev) {
			if (ev.kind === 'samples') {
				if (ev.mixedVolts) out.voltsMixed = true
				rawTotal += ev.hi - ev.lo
				const last = runs[runs.length - 1]
				// 电压不同的两段不能合并：合并会丢掉「每个样点当时的电压」
				if (!newRun && last && last.hi === ev.lo && last.mv === (ev.volts == null ? null : Math.round(ev.volts * 1000))) {
					// 同一连续段：合并数值，电压按电流大小加权
					const merged = new Float32Array(last.values.length + ev.values.length)
					merged.set(last.values)
					merged.set(ev.values, last.values.length)
					const wSum = last.weight + ev.values.length
					last.weight = wSum
					last.values = merged
					last.hi = ev.hi
				} else {
					runs.push({
						lo: ev.lo,
						hi: ev.hi,
						values: Float32Array.from(ev.values),
						volts: ev.volts == null ? null : ev.volts,
						mv: ev.volts == null ? null : Math.round(ev.volts * 1000),
						weight: ev.values.length,
					})
				}
				newRun = false
			} else if (ev.kind === 'missing') {
				out.missing += ev.hi - ev.lo
				out.unusable.push({ lo: ev.lo, hi: ev.hi, kind: 'missing' })
				newRun = true
			} else if (ev.kind === 'dropped') {
				out.dropped += ev.hi - ev.lo
				out.unusable.push({ lo: ev.lo, hi: ev.hi, kind: 'dropped' })
				newRun = true
			} else if (ev.kind === 'gap') {
				out.gaps++
				out.unusable.push({ lo: ev.lo, hi: ev.lo, kind: 'gap' })
				newRun = true
			}
		})
		if (summary && summary.aborted) {
			// 遍历期间会话变了：整份结果作废（不能让旧分析结果覆盖新会话）
			out.aborted = true
			return out
		}
		if (!rawTotal) return out
		const step = rawTotal > maxPts ? Math.ceil(rawTotal / maxPts) : 1
		let voltNum = 0
		let voltDen = 0
		for (let r = 0; r < runs.length; r++) {
			const run = runs[r]
			const n = run.values.length
			if (!n) continue
			const nOut = Math.max(1, Math.floor((n - 1) / step) + 1)
			const arr = new Float32Array(nOut)
			let j = 0
			let sum = 0
			for (let k = 0; k < n; k += step) {
				const v = run.values[k]
				arr[j++] = isFinite(v) ? v : 0
				sum += v
			}
			out.segments.push({
				samples: arr.subarray(0, j),
				lo: run.lo,
				hi: run.hi,
				step: step,
				volts: run.volts,
			})
			voltNum += sum * run.volts
			voltDen += sum
		}
		out.volts = voltDen > 0 ? voltNum / voltDen : 0
		return out
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
	 * 时长、电量、能量都来自 wave.stats 的**分段**结果（缺口两侧各自积分），
	 * 墙上时长另行给出并带上缺口占比，让用户看到差在哪。
	 */
	function measureCursors(wave, a, b, opts) {
		opts = opts || {}
		const per = opts.samplePeriodSec > 0 ? opts.samplePeriodSec : 0
		const out = {
			a: a, b: b, ready: false, samples: 0, gaps: 0, segments: 0,
			wallSec: 0, durSec: 0, gapRatio: 0,
			avgI: 0, minI: 0, maxI: 0, ppI: 0,
			chargeUC: 0, chargeUAh: 0, energyUWh: 0, volts: 0,
			iA: null, iB: null, deltaI: null, deltaSec: 0,
			dropped: 0,
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
		out.volts = st.volts
		out.dropped = st.dropped || 0
		// 端点电流只用真值：冷块未回读 / 已淘汰就留 null，界面显示 "--"
		const exact = typeof wave.iAtExact === 'function' ? wave.iAtExact : function () { return null }
		out.iA = exact(a)
		out.iB = exact(b)
		out.deltaI = out.iA != null && out.iB != null ? out.iB - out.iA : null
		out.deltaSec = out.wallSec
		out.ready = st.n > 0
		return out
	}

	/**
	 * 找区间内的上升 / 下降沿（含位置），供周期测量与游标吸附共用。
	 * **按连续段分别扫描**：状态机在段尾结束，绝不把缺口两侧配对成沿。
	 * 返回的位置都是全局样点下标。
	 */
	function findEdges(wave, a, b, opts) {
		opts = opts || {}
		const total = wave.total()
		const out = { thr: opts.thr, hyst: opts.hyst > 0 ? opts.hyst : 0, rises: [], falls: [], step: 1, segments: [] }
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
		const segs = typeof wave.segments === 'function' ? wave.segments(aa, bb + 1) : [[aa, bb + 1]]
		const span = bb - aa
		const step = span > EDGE_SEARCH_MAX ? Math.ceil(span / EDGE_SEARCH_MAX) : 1
		out.step = step
		for (let s = 0; s < segs.length; s++) {
			const sLo = segs[s][0]
			const sHi = segs[s][1] - 1
			const perSeg = { lo: sLo, hi: sHi, rises: [], falls: [] }
			let state = 0
			const v0 = wave.iAt(sLo)
			if (isFinite(v0)) {
				if (v0 >= thrHi) state = 1
				else if (v0 <= thrLo) state = -1
			}
			for (let i = sLo + step; i <= sHi; i += step) {
				const v = wave.iAt(i)
				if (!isFinite(v)) continue
				if (state <= 0 && v >= thrHi) {
					perSeg.rises.push(i)
					state = 1
				} else if (state >= 0 && v <= thrLo) {
					perSeg.falls.push(i)
					state = -1
				} else if (state === 0) {
					if (v >= thrHi) state = 1
					else if (v <= thrLo) state = -1
				}
			}
			out.segments.push(perSeg)
			for (let k = 0; k < perSeg.rises.length; k++) out.rises.push(perSeg.rises[k])
			for (let k = 0; k < perSeg.falls.length; k++) out.falls.push(perSeg.falls[k])
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
	 * 区间边沿测量：上升沿周期 / 频率 / 占空比。
	 * 每个连续段各自配对（段内相邻上升沿），段与段之间绝不配对；
	 * 周期 = 段内相邻上升沿的样点差 × 采样周期（边沿位置本来就是原始样点下标，不再乘抽稀步长）。
	 */
	function measureEdges(wave, a, b, opts) {
		opts = opts || {}
		const per = opts.samplePeriodSec > 0 ? opts.samplePeriodSec : 0
		const out = {
			thr: opts.thr, hyst: opts.hyst || 0, nRise: 0, nFall: 0,
			periodSec: null, freqHz: null, duty: null, nPeriod: 0, step: 1,
			segments: 0, worstGap: null,
		}
		const total = wave.total()
		a = clampIndex(a, total)
		b = clampIndex(b, total)
		if (a == null || b == null || b <= a || total < 3) return out
		const ed = findEdges(wave, a, b, opts)
		out.thr = ed.thr
		out.hyst = ed.hyst
		out.step = ed.step
		let nRise = 0
		let nFall = 0
		let sumP = 0
		let nP = 0
		let sumDuty = 0
		let nD = 0
		for (let s = 0; s < ed.segments.length; s++) {
			const seg = ed.segments[s]
			nRise += seg.rises.length
			nFall += seg.falls.length
			for (let k = 1; k < seg.rises.length; k++) {
				const dp = seg.rises[k] - seg.rises[k - 1]
				if (dp > 0) { sumP += dp; nP++ }
			}
			for (let k = 0; k < seg.rises.length - 1; k++) {
				const r0 = seg.rises[k]
				const r1 = seg.rises[k + 1]
				let f = null
				for (let m = 0; m < seg.falls.length; m++) {
					if (seg.falls[m] > r0 && seg.falls[m] < r1) { f = seg.falls[m]; break }
				}
				if (f != null && r1 > r0) { sumDuty += (f - r0) / (r1 - r0); nD++ }
			}
		}
		out.nRise = nRise
		out.nFall = nFall
		out.segments = ed.segments.length
		if (nP > 0 && per > 0) {
			out.periodSec = (sumP / nP) * per
			out.freqHz = out.periodSec > 0 ? 1 / out.periodSec : null
			out.nPeriod = nP
		}
		if (nD > 0) out.duty = sumDuty / nD
		return out
	}

	/**
	 * 精确分析：只走真实样点（\`wave.walkExact\`），流式处理，**不截断**。
	 *
	 * 两遍扫描：第一遍算统计 / 电量 / 能量 / 每个电压子区间；第二遍（需要时）算边沿。
	 * 每遍都是「取一块、算完、丢引用」，所以超过回读缓存容量也不会被截断或被挤掉。
	 *
	 * 不完整时（有 missing / dropped）整份结果标记 \`complete=false\`，调用方必须显示
	 * 「不完整/不可用」，不能拿部分样点的读数冒充整个区间。
	 *
	 * @param {object} wave
	 * @param {number} a 含
	 * @param {number} b 含
	 * @param {object} opts { samplePeriodSec, edges, maxSamples }
	 */
	async function analyseExact(wave, a, b, opts) {
		opts = opts || {}
		const per = opts.samplePeriodSec > 0 ? opts.samplePeriodSec : 0
		const total = wave.total()
		const a0 = clampIndex(a, total)
		const b0 = clampIndex(b, total)
		const out = {
			ok: false, aborted: false, complete: false,
			a: a0, b: b0, nRaw: a0 == null || b0 == null ? 0 : Math.abs(b0 - a0) + 1,
			samples: 0, missing: 0, dropped: 0, gaps: 0,
			basic: null, durSec: 0, chargeUC: 0, energyUWh: null,
			volts: 0, voltsUnknown: false, voltRuns: 0,
			segments: [], longest: null,
			edges: null,
		}
		if (a0 == null || b0 == null) return out
		const lo0 = Math.min(a0, b0)
		const hi0 = Math.max(a0, b0)
		if (hi0 - lo0 < 1) return out
		let n = 0
		let sumI = 0
		let sumSq = 0
		let minI = Infinity
		let maxI = -Infinity
		let intervals = 0
		let charge = 0
		let energy = 0
		let voltNum = 0
		let voltDen = 0
		let voltsUnknown = false
		let curSeg = null
		const maxKeep = opts.maxSamples > 0 ? opts.maxSamples : MAX_SAMPLES_DEFAULT
		let longest = null
		let longestN = 0
		// 「上一个样点」：只有与当前点**紧邻**时才构成一个时间间隔（左端点约定）
		let prevLi = -2
		let prevV = 0
		let prevMv = null
		const flushSeg = function () {
			if (curSeg && curSeg.hi > curSeg.lo) out.segments.push(curSeg)
			curSeg = null
			prevLi = -2
			prevV = 0
			prevMv = null
		}
		const walk1 = await wave.walkExact(lo0, hi0 + 1, function (ev) {
			if (ev.kind !== 'samples') {
				if (ev.kind === 'gap') out.gaps++
				else if (ev.kind === 'dropped') out.dropped += ev.hi - ev.lo
				else if (ev.kind === 'missing') out.missing += ev.hi - ev.lo
				flushSeg()
				return
			}
			const cnt = ev.hi - ev.lo
			const mv = ev.volts == null ? null : Math.round(ev.volts * 1000)
			if (mv == null) voltsUnknown = true
			out.voltRuns++
			const vals = ev.values
			let runSum = 0
			for (let k = 0; k < vals.length; k++) {
				const v = vals[k]
				if (!isFinite(v)) continue
				const li = ev.lo + k
				runSum += v
				sumSq += v * v
				if (v < minI) minI = v
				if (v > maxI) maxI = v
				// 时间间隔归属**前一个**样点：只有相邻才计
				if (prevLi === li - 1) {
					intervals++
					charge += prevV * per
					if (prevMv != null) energy += prevV * (prevMv / 1000) * per
				}
				prevLi = li
				prevV = v
				prevMv = mv
			}
			n += cnt
			sumI += runSum
			if (mv != null) { voltNum += runSum * (mv / 1000); voltDen += runSum }
			if (!curSeg) curSeg = { lo: ev.lo, hi: ev.hi, samples: 0 }
			else curSeg.hi = ev.hi
			curSeg.samples += cnt
			// 保留最长的一段样点（只给 FFT / 叠画用，按 maxKeep 抽稀）
			if (cnt > longestN) {
				const step = cnt > maxKeep ? Math.ceil(cnt / maxKeep) : 1
				const nOut = Math.max(1, Math.floor((cnt - 1) / step) + 1)
				const arr = new Float32Array(nOut)
				let j = 0
				for (let k = 0; k < cnt; k += step) arr[j++] = vals[k]
				longest = { lo: ev.lo, hi: ev.hi, values: arr.subarray(0, j), step: step, volts: ev.volts }
				longestN = cnt
			}
		})
		if (walk1 && walk1.aborted) { out.aborted = true; return out }
		flushSeg()
		out.samples = n
		out.voltsUnknown = voltsUnknown
		out.volts = voltDen > 0 ? voltNum / voltDen : 0
		out.basic = n ? {
			n: n, avg: sumI / n, min: isFinite(minI) ? minI : 0, max: isFinite(maxI) ? maxI : 0,
			sum: sumI, sumSq: sumSq, pp: (isFinite(maxI) ? maxI : 0) - (isFinite(minI) ? minI : 0),
			rms: Math.sqrt(sumSq / n),
		} : null
		out.longest = longest
		out.durSec = intervals * per
		out.chargeUC = charge
		out.energyUWh = voltsUnknown ? null : energy
		out.ok = n > 0
		out.complete = out.missing === 0 && out.dropped === 0 && !out.aborted
		// 第二遍：边沿 / 周期 / 占空比（段内配对，绝不跨段）
		if (opts.edges && out.ok && out.complete) {
			if (!isFinite(opts.thr) && out.basic) opts = Object.assign({}, opts, { thr: (out.basic.min + out.basic.max) * 0.5 })
			if (!(opts.hyst > 0) && out.basic) opts = Object.assign({}, opts, { hyst: Math.max(out.basic.pp * 0.02, Math.abs(opts.thr) * 0.005, 1e-9) })
			out.edges = await scanEdgesExact(wave, lo0, hi0 + 1, per, opts)
			if (out.edges && out.edges.aborted) { out.aborted = true; out.edges = null }
		}
		return out
	}

	/**
	 * 第二遍：逐连续段扫描边沿（真实的样点，不是显示缓存）。
	 * 位置是全局样点下标，周期 = dp × per（不再乘抽稀）；段与段之间绝不配对。
	 */
	async function scanEdgesExact(wave, a, b, per, opts) {
		opts = opts || {}
		const res = {
			thr: opts.thr, hyst: opts.hyst > 0 ? opts.hyst : 0, nRise: 0, nFall: 0,
			periodSec: null, freqHz: null, duty: null, nPeriod: 0, segments: 0, aborted: false,
		}
		const thr = isFinite(opts.thr) ? opts.thr : 0
		const hyst = opts.hyst > 0 ? opts.hyst : Math.max(Math.abs(opts.pp || 0) * 0.02, Math.abs(thr) * 0.005, 1e-9)
		res.thr = thr
		res.hyst = hyst
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		let state = 0
		let lastRise = null
		let pendingFall = null
		let inSegment = false
		let sumP = 0
		let nP = 0
		let sumDuty = 0
		let nD = 0
		const startSegment = function () {
			state = 0
			lastRise = null
			pendingFall = null
			inSegment = false
			res.segments++
		}
		const walk = await wave.walkExact(a, b, function (ev) {
			if (ev.kind !== 'samples') {
				// 缺口 / 淘汰 / 读不到：时间轴在这里断开，边沿状态清零
				startSegment()
				return
			}
			if (!inSegment) {
				inSegment = true
				// 段的第一个样点只用来 seed 滞回状态
				const v0 = ev.values[0]
				if (isFinite(v0)) state = v0 >= thrHi ? 1 : (v0 <= thrLo ? -1 : 0)
				for (let k = 1; k < ev.values.length; k++) {
					const v = ev.values[k]
					if (!isFinite(v)) continue
					const li = ev.lo + k
					let edge = null
					if (state <= 0 && v >= thrHi) { edge = 'rise'; state = 1 }
					else if (state >= 0 && v <= thrLo) { edge = 'fall'; state = -1 }
					else if (state === 0) state = v >= thrHi ? 1 : (v <= thrLo ? -1 : 0)
					if (!edge) continue
					if (edge === 'rise') {
						res.nRise++
						if (lastRise != null) {
							const dp = li - lastRise
							if (dp > 0) { sumP += dp; nP++ }
							if (pendingFall != null && li > lastRise) { sumDuty += (pendingFall - lastRise) / (li - lastRise); nD++ }
						}
						pendingFall = null
						lastRise = li
					} else {
						res.nFall++
						if (lastRise != null) pendingFall = li
					}
				}
				return
			}
			for (let k = 0; k < ev.values.length; k++) {
				const v = ev.values[k]
				if (!isFinite(v)) continue
				const li = ev.lo + k
				let edge = null
				if (state <= 0 && v >= thrHi) { edge = 'rise'; state = 1 }
				else if (state >= 0 && v <= thrLo) { edge = 'fall'; state = -1 }
				else if (state === 0) state = v >= thrHi ? 1 : (v <= thrLo ? -1 : 0)
				if (!edge) continue
				if (edge === 'rise') {
					res.nRise++
					if (lastRise != null) {
						const dp = li - lastRise
						if (dp > 0) { sumP += dp; nP++ }
						if (pendingFall != null && li > lastRise) { sumDuty += (pendingFall - lastRise) / (li - lastRise); nD++ }
					}
					pendingFall = null
					lastRise = li
				} else {
					res.nFall++
					if (lastRise != null) pendingFall = li
				}
			}
		})
		if (walk && walk.aborted) { res.aborted = true; return res }
		if (nP > 0 && per > 0) {
			res.periodSec = (sumP / nP) * per
			res.freqHz = res.periodSec > 0 ? 1 / res.periodSec : null
			res.nPeriod = nP
		}
		if (nD > 0) res.duty = sumDuty / nD
		return res
	}

	/**
	 * 组装一次分析。全部分析都基于**真实样点**（analyseExact）：
	 *  - 冷块先等回读；回读失败 / 已淘汰 → 整份标记不完整，读数不冒充完整区间；
	 *  - 周期与占空比只在段内配对；
	 *  - FFT 遇到多个不连续段时拒绝计算（除非显式允许只取最长段）；
	 *  - 周期叠画只取最长段。
	 * @returns {Promise<object|null>}
	 */
	async function buildPack(o) {
		o = o || {}
		const wave = o.wave
		const range = o.range
		if (!wave || !range) return null
		const per = o.samplePeriodSec > 0 ? o.samplePeriodSec : 0
		const core = await analyseExact(wave, range.a, range.b, {
			samplePeriodSec: per,
			edges: true,
			thr: o.thr,
			pp: o.pp,
			maxSamples: o.maxSamples,
		})
		if (!core || core.aborted) return core && core.aborted ? { aborted: true, source: range.source } : null
		if (!core.ok) return emptyPack(range, { a: core.a, b: core.b, nRaw: core.nRaw, gaps: core.gaps, dropped: core.dropped, missing: core.missing, unusable: [] })
		const basic = core.basic
		const thr = (core.edges && isFinite(core.edges.thr)) ? core.edges.thr : (basic ? (basic.min + basic.max) * 0.5 : 0)
		const pack = {
			source: range.source,
			a: core.a,
			b: core.b,
			step: core.longest ? core.longest.step : 1,
			nRaw: core.nRaw,
			rateHz: per > 0 ? 1 / per : 0,
			periodSec: per,
			basic: basic,
			levels: null,
			edges: core.edges || { thr: thr, hyst: 0, nRise: 0, nFall: 0, periodSec: null, freqHz: null, duty: null, nPeriod: 0, segments: 0 },
			measure: null,
			voltageV: core.volts,
			voltsUnknown: core.voltsUnknown,
			gaps: core.gaps,
			dropped: core.dropped,
			missing: core.missing,
			unusable: [],
			segments: core.segments.length,
			complete: !!core.complete,
			qCycle: null,
			fft: null,
			cycles: null,
			battery: null,
			spikes: null,
			segmentList: null,
		}
		// 游标读数与统计同口径：直接用精确扫描的结果
		const exact = function () {
			return {
				ready: core.complete && basic != null, samples: core.samples,
				gaps: core.gaps, segments: core.segments.length,
				wallSec: per > 0 ? (core.b - core.a) * per : 0,
				durSec: core.durSec,
				gapRatio: 0,
				avgI: basic ? basic.avg : 0, minI: basic ? basic.min : 0, maxI: basic ? basic.max : 0,
				ppI: basic ? basic.pp : 0,
				chargeUC: core.chargeUC, chargeUAh: core.chargeUC / 3600,
				energyUWh: core.energyUWh, volts: core.volts,
				iA: wave.iAtExact ? wave.iAtExact(core.a) : null,
				iB: wave.iAtExact ? wave.iAtExact(core.b) : null,
				dropped: core.dropped, missing: core.missing,
				complete: core.complete,
			}
		}
		pack.measure = exact()
		if (pack.measure.wallSec > 0) pack.measure.gapRatio = Math.max(0, 1 - core.durSec / pack.measure.wallSec)
		// 不完整：不拿部分样点算出「完整区间」的读数
		if (!core.complete) {
			pack.incomplete = true
			pack.unavailableReason = core.missing > 0 ? 'samples_unavailable' : (core.dropped > 0 ? 'samples_evicted' : 'incomplete')
			pack.measure.ready = false
		}
		const voltVal = core.volts > 0 ? core.volts : 0
		if (basic) {
			const all = core.longest && core.longest.values ? core.longest.values : new Float32Array(0)
			pack.levels = ANAL ? ANAL.twoLevelStats(all, thr, Math.abs(basic.pp * 0.02)) : null
		}
		pack.qCycle = (core.edges && core.edges.periodSec != null && basic && basic.n) ? basic.avg * core.edges.periodSec : null
		if (o.fft && ANAL && core.longest && core.longest.values && core.longest.values.length >= 16) {
			const discont = core.segments.length > 1
			if (discont && !o.fftLongestSegment) {
				pack.fft = { ok: false, reason: 'discontinuous', n: 0, segments: core.segments.length }
			} else {
				const fs = per > 0 ? 1 / (per * core.longest.step) : 0
				if (fs > 0) {
					const f = ANAL.fftAnalysis(core.longest.values, fs, { window: o.window || 'hann', topK: 8 })
					pack.fft = f
					pack.fft.segmentLo = core.longest.lo
					pack.fft.segmentHi = core.longest.hi
					pack.fft.partial = discont
				}
			}
		}
		if (o.cycles && ANAL && core.edges && core.edges.periodSec != null && per > 0 && core.longest) {
			const periodPts = Math.max(4, Math.round(core.edges.periodSec / (per * core.longest.step)))
			if (periodPts * 2 <= core.longest.values.length) {
				pack.cycles = ANAL.extractCycles(core.longest.values, periodPts, o.maxCycles)
				pack.cycles.segmentLo = core.longest.lo
				pack.cycles.segmentHi = core.longest.hi
			}
		}
		if (o.capacityMah > 0 && ANAL && basic && basic.n && core.energyUWh != null) {
			pack.battery = ANAL.estimateBatteryLife(basic.avg, o.capacityMah, { derate: 0.9 })
		}
		if (o.spikes && ANAL && core.longest && core.longest.values) {
			pack.spikes = ANAL.findSpikes(core.longest.values, { thr: null, minWidthPts: Math.max(1, Math.round((o.spikeMinPts || 2) / core.longest.step)), maxCount: 60 })
		}
		if (o.segments && ANAL && core.longest && core.longest.values) {
			const one = ANAL.segmentByThreshold(core.longest.values, thr, { minSegPts: Math.max(2, Math.round(2 / core.longest.step)), maxCount: 60 })
			pack.segmentList = one && one.segments ? one.segments : []
		}
		void voltVal
		return pack
	}

	function emptyPack(range, ext) {
		return {
			source: range.source, a: ext.a, b: ext.b, step: 1, nRaw: ext.nRaw, rateHz: 0, periodSec: 0,
			basic: null, levels: null,
			edges: { thr: null, hyst: 0, nRise: 0, nFall: 0, periodSec: null, freqHz: null, duty: null, nPeriod: 0, step: 1, segments: 0 },
			measure: measureCursors({ total: function () { return 0 }, stats: function () {
				return { n: 0, avgI: 0, minI: 0, maxI: 0, dur: 0, chargeUC: 0, chargeUAh: 0, energyUWh: 0, volts: 0, dropped: 0 }
			}, iAt: function () { return 0 }, gaps: function () { return [] }, segments: function () { return [] } }, 0, 0, {}),
			voltageV: 0, voltsMixed: false,
			gaps: ext.gaps, dropped: ext.dropped, missing: ext.missing, unusable: ext.unusable,
			segments: 0, qCycle: null, fft: null, cycles: null, battery: null, spikes: null, segmentList: null,
			unavailable: true,
		}
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
		rangeGaps: rangeGaps,
		extractSegmentsExact: extractSegmentsExact,
		analyseExact: analyseExact,
		scanEdgesExact: scanEdgesExact,
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
