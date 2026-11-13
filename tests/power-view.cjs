'use strict'
// 视图纯逻辑回归（js/power-view.js）：视口换算、缩放锚点、平移跟手、Y 轴映射（log/symlog）、
// 游标命中、示波器触发扫描、采样沿状态机、停滞看门狗、总览条布局。
const assert = require('node:assert/strict')
const V = require('../js/power-view.js')

const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps)

// ---- X：缩放上下限 ----
{
	// 1e-5 s/点（100 kHz）：最宽 120 s → 12e6 点，defaultPoints 2000 → 下限 2000/12e6
	const min = V.xZoomMin(1e-5)
	assert.ok(near(min, 2000 / 12e6), 'xZoomMin = ' + min)
	assert.ok(V.xZoomMin(1e-5) < V.xZoomMin(1e-3), '采样率越低（周期越大）允许缩得越小')
	assert.equal(V.clampXZoom(1e9, 1e-5), V.C.X_ZOOM_MAX, '放大上限是硬常量')
	assert.equal(V.clampXZoom(0, 1e-5), 1, '非法缩放退回 1')
	assert.equal(V.clampXZoom(1e-9, 1e-5), min, '缩小下限按时长算')
}

// ---- X：视口样点数与范围 ----
{
	assert.equal(V.viewPoints(100000, 1), 2000, 'xZoom=1 → 默认 2000 点')
	assert.equal(V.viewPoints(100, 1), 100, '不超过总点数')
	assert.equal(V.viewPoints(100000, 1000), 4, '最少 4 点')
	const live = V.viewRange({ total: 10000, xZoom: 1, xOffset: 123, live: true })
	assert.deepEqual([live.start, live.end, live.count], [8000, 9999, 2000], 'Live 时右端永远是最新样点')
	assert.equal(live.xOffset, 0)
	const paused = V.viewRange({ total: 10000, xZoom: 1, xOffset: 500 })
	assert.deepEqual([paused.start, paused.end], [7500, 9499], '暂停时按 xOffset 从最新往左')
	const clampStart = V.viewRange({ total: 10000, xZoom: 1000, xOffset: 99999 })
	assert.ok(clampStart.end <= 9999 && clampStart.start >= 0)
}

// ---- X：缩放钉住鼠标下的样点 ----
{
	const s = { total: 100000, xZoom: 1, xOffset: 0, plotWidth: 601, pixel: 300, factor: 2, periodSec: 1e-5 }
	const before = V.viewRange(s)
	const anchorIdx = before.start + (300 / 600) * (before.count - 1)
	const z = V.zoomAtPoint(s)
	const after = V.viewRange({ total: s.total, xZoom: z.xZoom, xOffset: z.xOffset })
	const afterIdx = after.start + (300 / 600) * (after.count - 1)
	assert.ok(near(anchorIdx, afterIdx, 1.01), '锚点样点应留在同一像素：' + anchorIdx + ' vs ' + afterIdx)
	assert.ok(after.count < before.count, '放大后视口变窄')
	// 缩小
	const z2 = V.zoomAtPoint({ total: s.total, xZoom: z.xZoom, xOffset: z.xOffset, plotWidth: 601, pixel: 300, factor: 0.5, periodSec: 1e-5 })
	assert.ok(z2.xZoom < z.xZoom)
	// 缩到上限时被夹住，不产生负 offset
	const z3 = V.zoomAtPoint({ total: 5000, xZoom: 1, xOffset: 0, plotWidth: 601, pixel: 0, factor: 1e-9, periodSec: 1e-5 })
	assert.ok(z3.xOffset >= 0 && z3.xZoom >= V.xZoomMin(1e-5))
}

// ---- X：拖拽平移 / 跟手 ----
{
	const s = { total: 10000, xZoom: 1, xOffset: 1000, plotWidth: 601 }
	assert.equal(V.panByPixels(Object.assign({}, s, { deltaPx: 0 })).xOffset, 1000)
	// 指针右移 = 看更旧的 = xOffset 增大
	const right = V.panByPixels(Object.assign({}, s, { deltaPx: 300 }))
	assert.ok(right.xOffset > 1000, '右移看更旧：' + right.xOffset)
	const left = V.panByPixels(Object.assign({}, s, { deltaPx: -300 }))
	assert.ok(left.xOffset < 1000)
	// 边界夹紧：xOffset ∈ [0, total-viewPts]
	assert.equal(V.panByPixels(Object.assign({}, s, { xOffset: 0, deltaPx: 99999 })).xOffset, 10000 - 2000, '一直往旧拖夹在最旧端')
	assert.equal(V.panByPixels(Object.assign({}, s, { xOffset: 99999, deltaPx: -99999 })).xOffset, 0, '一直往新拖夹在最新端')
	// 跟手：让某下标落在像素处
	const f = V.panSoIndexAtPixel({ total: 10000, xZoom: 1, index: 5000, pixel: 0, plotWidth: 601 })
	const r = V.viewRange({ total: 10000, xZoom: 1, xOffset: f.xOffset })
	assert.equal(r.start, 5000, '下标落在左边界')
	const c = V.centerOnIndex({ total: 10000, xZoom: 2, index: 5000 })
	const rc = V.viewRange({ total: 10000, xZoom: 2, xOffset: c.xOffset })
	assert.ok(rc.start <= 5000 && rc.end >= 5000, '居中后区间包含该点')
}

// ---- 像素 ↔ 下标 ----
{
	const range = { start: 1000, end: 1999, count: 1000 }
	assert.equal(V.indexToPixel(1000, range, 101), 0)
	assert.equal(V.indexToPixel(1999, range, 101), 100)
	assert.equal(V.pixelToIndex(0, range, 101), 1000)
	assert.equal(V.pixelToIndex(100, range, 101), 1999)
	assert.equal(V.pixelToIndex(-50, range, 101), 1000, '越界夹紧')
	assert.equal(V.pixelToIndex(9999, range, 101), 1999)
}

// ---- Y：log 映射与 floor ----
{
	assert.equal(V.adaptLogFloor(0.5, undefined), 0.1, 'min+ 0.5 µA → floor 0.1 µA')
	assert.equal(V.adaptLogFloor(5e-3, undefined), 1e-3, 'min+ 5 nA → floor 1 nA')
	assert.equal(V.adaptLogFloor(0, 1e-3), 1e-3, '无正最小值时保持当前 floor')
	assert.equal(V.adaptLogFloor(1e-9, 1e-3), 1e-4, 'floor 下限 0.1 nA')
	assert.equal(V.adaptLogFloor(1e6, 0.5), 1, 'floor 上限 1 µA（不跟到线性区）')
	assert.equal(V.adaptLogFloor(0.004, 1e-3), 1e-3, '小幅变大不抬高 floor（滞回）')
	assert.ok(V.adaptLogFloor(0.2, 1e-3) > 1e-3, '明显更大时才抬高')
	// 映射：floor 以下夹到 floor，不返回 -Infinity
	const f = 1e-3
	assert.ok(near(V.logMap(f, f), -3))
	assert.equal(V.logMap(0, f), Math.log10(f), '0 与负数都夹到 floor')
	assert.equal(V.logMap(-5, f), Math.log10(f))
	assert.ok(near(V.logUnmap(V.logMap(1234, f), f), 1234, 1e-6))
	// 1 nA 下限可分辨：100 nA 与 1 µA 在 log 下相差 1 decade
	assert.ok(near(V.logMap(1e-1, f) - V.logMap(1e-2, f), 1))
}

// ---- Y：symlog 近 0 线性、大值压缩、负值可画 ----
{
	const th = 1
	assert.ok(near(V.symlogMap(0, th), 0))
	assert.ok(Math.abs(V.symlogMap(0.1, th) - 0.0998) < 1e-3, '近 0 近似线性')
	assert.ok(V.symlogMap(1e6, th) < 15, '大电流被压缩')
	assert.ok(near(V.symlogUnmap(V.symlogMap(12345, th), th), 12345, 1e-3), '可逆')
	assert.ok(V.symlogMap(-500, th) < 0, '负值也能画')
	assert.ok(near(V.symlogUnmap(V.symlogMap(-500, th), th), -500, 1e-3))
}

// ---- Y：自动量程 ----
{
	const lg = V.autoLogRange(0.2, 4000, 0.2)
	assert.ok(lg.mapMin <= Math.log10(0.2) && lg.mapMax >= Math.log10(4000), 'log 量程包住数据')
	assert.ok(Number.isInteger(lg.mapMin * 2) || Number.isInteger(lg.mapMin), 'decade / 半 decade 对齐')
	const sym = V.autoSymlogRange(-30, 300)
	assert.ok(sym.mapMax > V.symlogMap(300, sym.linthresh) * 0.9)
	assert.ok(sym.linthresh > 0)
	// 小信号时 linthresh 收紧，但不会回到 0
	const small = V.autoSymlogRange(-0.02, 0.02)
	assert.ok(small.linthresh > 0 && small.linthresh <= 1)
	const lin = V.autoLinearRange(10, 20)
	assert.ok(lin.mapMin < 10 && lin.mapMax > 20, '线性量程有边距')
}

// ---- Y：绘制映射（缩放 / 平移 / 刻度）----
{
	const sc = V.buildYScale({ mode: 'linear', yMin: 0, yMax: 100 })
	// 自动量程有 8% 边距：数据端点不贴边，但方向与单调性必须正确
	assert.ok(sc.toPixel(0, 300) > sc.toPixel(100, 300), '小值在下、大值在上')
	assert.ok(near(sc.toPixel(sc.fromFraction(0), 300), 300, 1e-6), '映射下界贴底')
	assert.ok(near(sc.toPixel(sc.fromFraction(1), 300), 0, 1e-6), '映射上界贴顶')
	assert.ok(sc.toPixel(50, 300) > sc.toPixel(100, 300) && sc.toPixel(50, 300) < sc.toPixel(0, 300))
	assert.ok(near(sc.fromPixel(sc.toPixel(37, 300), 300), 37, 1e-6), '像素可逆')
	assert.ok(sc.ticks.major.length >= 3, '线性有主刻度')

	// Y 放大：可见区间变窄
	const z2 = V.buildYScale({ mode: 'linear', yMin: 0, yMax: 100, yZoom: 2 })
	assert.ok(near(z2.fromFraction(1) - z2.fromFraction(0), (sc.fromFraction(1) - sc.fromFraction(0)) / 2, 1e-6))
	// Y 平移：正值把窗口中心抬高（看更大的电流）
	const p2 = V.buildYScale({ mode: 'linear', yMin: 0, yMax: 100, yPan: 0.5 })
	assert.ok(p2.fromFraction(0.5) > 50, '正值 yPan 看更大的电流：' + p2.fromFraction(0.5))
	const p3 = V.buildYScale({ mode: 'linear', yMin: 0, yMax: 100, yPan: -0.5 })
	assert.ok(p3.fromFraction(0.5) < 50)
	// log 下不允许越过 floor
	const lg = V.buildYScale({ mode: 'log', yMin: 0.001, yMax: 1, yPan: -5 })
	assert.ok(lg.fromFraction(0) >= lg.params.floor * 0.999, 'log 下界不低于 floor')
	const lt = V.buildLogTicks(1e-3, 1e3, 1e-3)
	assert.ok(lt.major.length >= 6, 'decade 主刻度：' + lt.major.length)
	assert.ok(lt.minor.some((v) => near(v, 2e-3)), '2 在次刻度里')
	assert.ok(lt.faint.some((v) => near(v, 3e-3)), '3 在淡线里')
	const st = V.buildSymlogTicks(-1000, 1000, 1)
	assert.ok(st.major.some((v) => v === 0), 'symlog 必须有 0 刻度')
	assert.ok(st.major[0] < 0 && st.major[st.major.length - 1] > 0)
}

// ---- 游标命中与框选 ----
{
	assert.equal(V.cursorHit(100, 104, 300), 'a')
	assert.equal(V.cursorHit(295, 100, 300), 'b')
	assert.equal(V.cursorHit(200, 100, 300), null)
	assert.equal(V.cursorHit(100, null, null), null)
	assert.deepEqual(V.selection(500, 100, 10000), { a: 100, b: 500 }, '总是 a<=b')
	assert.equal(V.selection(null, 5, 100), null)
	assert.deepEqual(V.selection(-50, 99999, 1000), { a: 0, b: 999 }, '夹在数据范围内')
	assert.deepEqual(V.boxSelect(300, 100, 10000), { a: 100, b: 300 })
}

// ---- 示波器式显示触发 ----
{
	// 方波：每 100 点一个上升沿（低 50 高 50）
	const total = 2000
	const sampleAt = (i) => ((i % 100) < 50 ? 0 : 100)
	// 一次扫一大段：钉住「本批最后一个」合格沿（示波器连续触发）
	const trig = V.createScopeTrigger()
	const res = V.scanScopeTrigger(trig, {
		mode: 'rise', total: total, from: 1, to: total - 1, sampleAt: sampleAt,
		thr: 50, hyst: 5, viewPts: 200,
	})
	assert.ok(res.fired != null, '应命中上升沿')
	assert.equal(res.fired % 100, 50, '上升沿在 50 的倍数上：' + res.fired)
	assert.ok(res.fired > total - 100, '钉住的是最新那个沿：' + res.fired)
	assert.equal(trig.lockLi, res.fired)
	// 分批扫描：holdoff 内不重复触发，跨批保住滞回状态并记住周期
	const t2 = V.createScopeTrigger()
	const a1 = V.scanScopeTrigger(t2, { mode: 'rise', total: total, from: 1, to: 350, sampleAt: sampleAt, thr: 50, hyst: 5, viewPts: 200 })
	assert.equal(a1.fired, 350)
	const a2 = V.scanScopeTrigger(t2, { mode: 'rise', total: total, from: 351, to: 380, sampleAt: sampleAt, thr: 50, hyst: 5, viewPts: 200 })
	assert.equal(a2.fired, null, 'holdoff 内不该重复触发')
	const a3 = V.scanScopeTrigger(t2, { mode: 'rise', total: total, from: 381, to: 500, sampleAt: sampleAt, thr: 50, hyst: 5, viewPts: 200 })
	assert.equal(a3.fired, 450, '跨批后钉住本批的上升沿')
	// 真实使用里是每批（约 16 ms）扫一次：周期估计按相邻沿之差收敛
	const t3 = V.createScopeTrigger()
	let cursor = 1
	for (let batch = 0; batch < 12; batch++) {
		const to = Math.min(total - 1, cursor + 49)
		V.scanScopeTrigger(t3, { mode: 'rise', total: total, from: cursor, to: to, sampleAt: sampleAt, thr: 50, hyst: 5, viewPts: 200 })
		cursor = to + 1
	}
	assert.ok(t3.periodPts != null && Math.abs(t3.periodPts - 100) < 1, '按批扫描时周期 ≈100：' + t3.periodPts)
	assert.ok(t3.lockLi != null && t3.lockLi % 100 === 50, '触发点落在上升沿：' + t3.lockLi)

	// 下降沿模式只认下降沿
	const tf = V.createScopeTrigger()
	const fall = V.scanScopeTrigger(tf, { mode: 'fall', total: total, from: 1, to: total - 1, sampleAt: sampleAt, thr: 50, hyst: 5, viewPts: 200 })
	assert.equal(fall.fired % 100, 0, '下降沿在 100 的倍数上：' + fall.fired)

	// 永远不越过的电平：不触发
	const none = V.scanScopeTrigger(V.createScopeTrigger(), { mode: 'rise', total: total, from: 1, to: total - 1, sampleAt: sampleAt, thr: 1e6, hyst: 1, viewPts: 200 })
	assert.equal(none.fired, null)

	// 超长区间只扫尾部，并用扫窗前一点重 seed（否则会报假沿）
	const long = 200000
	const at2 = (i) => (i >= long - 500 ? 100 : 0)
	const tl = V.createScopeTrigger()
	const rl = V.scanScopeTrigger(tl, { mode: 'rise', total: long, from: 1, to: long - 1, sampleAt: at2, thr: 50, hyst: 5, viewPts: 200 })
	assert.equal(rl.truncated, true, '超长区间应被截断')
	assert.equal(rl.fired, long - 500, '尾部第一个上升沿：' + rl.fired)

	// off 模式不动状态
	const toff = V.createScopeTrigger()
	toff.lockLi = 42
	assert.equal(V.scanScopeTrigger(toff, { mode: 'off', total: 100, from: 1, to: 99, sampleAt: () => 0 }).fired, null)
	assert.equal(toff.lockLi, 42)

	// 视口钉住：触发点在 pre 比例处
	const range = V.viewRange({ total: 5000, xZoom: 1000, trigLockLi: 3000, trigPosFrac: 0.25 })
	assert.equal(range.start + Math.round((range.count - 1) * 0.25), 3000, '触发点落在 25% 处')
	assert.equal(range.trigLocked, true)
}

// ---- 采样沿触发 ----
{
	const trg = V.createAcqTrigger()
	trg.start = 'rise'
	trg.storeEnabled = false
	trg.startState = 0
	const feed = (v, kind, extra) => V.feedAcqEdge(trg, Object.assign({ iUA: v, kind: kind || 'start', thr: 50 }, extra || {}))
	// 先低后高：只有上升沿开闸；unknown 只 seed 不产生沿
	assert.equal(feed(10), false, 'unknown 只 seed，不产生沿')
	assert.equal(feed(100), true, '上升沿命中')
	assert.equal(trg.preMin, 10, 'waiting 阶段累计 pre-range')
	assert.equal(trg.preMax, 100)
	// 未命中时不算豁口：连续同电平不重复触发
	assert.equal(feed(120), false)
	trg.storeEnabled = true
	trg.startLatched = true

	// 停沿：没命中启动沿之前忽略
	const trg2 = V.createAcqTrigger()
	trg2.stop = 'fall'
	trg2.start = 'rise'
	trg2.startLatched = false
	V.feedAcqEdge(trg2, { iUA: 100, kind: 'stop', thr: 50 })
	assert.equal(V.feedAcqEdge(trg2, { iUA: 0, kind: 'stop', thr: 50 }), false, '启动沿未命中时忽略停沿')
	trg2.startLatched = true
	assert.equal(V.feedAcqEdge(trg2, { iUA: 100, kind: 'stop', thr: 50 }), false, '回到高电平：只是 seed')
	assert.equal(V.feedAcqEdge(trg2, { iUA: 0, kind: 'stop', thr: 50 }), true, '命中启动沿后停沿生效')

	// either：rise / fall 都算
	const trg3 = V.createAcqTrigger()
	trg3.start = 'either'
	V.feedAcqEdge(trg3, { iUA: 10, thr: 50 })
	assert.equal(V.feedAcqEdge(trg3, { iUA: 100, thr: 50 }), true, 'either 认上升沿')
	const trg4 = V.createAcqTrigger()
	trg4.start = 'either'
	V.feedAcqEdge(trg4, { iUA: 100, thr: 50 })
	assert.equal(V.feedAcqEdge(trg4, { iUA: 10, thr: 50 }), true, 'either 认下降沿')

	// seedOnly：预热只更新状态、绝不触发
	const trg5 = V.createAcqTrigger()
	trg5.start = 'rise'
	assert.equal(V.feedAcqEdge(trg5, { iUA: 0, thr: 50 }), false)
	assert.equal(V.feedAcqEdge(trg5, { iUA: 100, thr: 50, seedOnly: true }), false)
	assert.equal(trg5.startState, 1)

	// 显式滞回：窄噪声不来回触发
	const trg9 = V.createAcqTrigger()
	trg9.start = 'either'
	V.feedAcqEdge(trg9, { iUA: 0, thr: 50, hyst: 10 })
	assert.equal(V.feedAcqEdge(trg9, { iUA: 55, thr: 50, hyst: 10 }), false, '没过 +hyst 不算沿')
	assert.equal(V.feedAcqEdge(trg9, { iUA: 61, thr: 50, hyst: 10 }), true)
	assert.equal(V.feedAcqEdge(trg9, { iUA: 45, thr: 50, hyst: 10 }), false, '没过 -hyst 不算沿')
	assert.equal(V.feedAcqEdge(trg9, { iUA: 39, thr: 50, hyst: 10 }), true)

	// 改回 off：等沿中立刻开闸
	const trg6 = V.createAcqTrigger()
	trg6.start = 'rise'
	trg6.storeEnabled = false
	V.setAcqStartMode(trg6, 'off', true)
	assert.equal(trg6.storeEnabled, true, '取消沿门控立即入库')
	assert.equal(trg6.startLatched, true)
	// 未采样时改模式会复位等待态
	const trg7 = V.createAcqTrigger()
	trg7.start = 'rise'
	trg7.storeEnabled = false
	V.setAcqStartMode(trg7, 'fall', false)
	assert.equal(trg7.storeEnabled, true)
	assert.equal(trg7.startState, 0)
	// 停沿：采样中改模式复位 stopState
	const trg8 = V.createAcqTrigger()
	trg8.stopState = 1
	V.setAcqStopMode(trg8, 'fall', true)
	assert.equal(trg8.stopState, 0)
	assert.equal(trg8.stop, 'fall')
	// 非法模式一律当 off
	V.setAcqStartMode(trg8, 'bogus', false)
	assert.equal(trg8.start, 'off')
}

// ---- 停滞看门狗 ----
{
	let t = 1000
	const stalls = []
	const resumes = []
	let ivFn = null
	const w = V.createStallWatch({
		now: () => t,
		setInterval: (fn) => { ivFn = fn; return 1 },
		clearInterval: () => { ivFn = null },
		intervalMs: 500,
		thresholdMs: 2000,
		onStall: (info) => stalls.push(info),
		onResume: () => resumes.push(t),
	})
	w.start()
	assert.equal(w.status().active, true)
	t += 500
	assert.equal(w.check().stalled, false)
	t += 2000
	const st = w.check()
	assert.equal(st.stalled, true)
	assert.equal(stalls.length, 1, '超过阈值报一次')
	t += 5000
	w.check()
	assert.equal(stalls.length, 1, '只报一次，不刷屏')
	w.note()
	assert.equal(resumes.length, 1, '恢复时通知一次')
	assert.equal(w.status().stalled, false)
	w.stop()
	assert.equal(w.status().active, false)
	assert.equal(ivFn, null, '停止时清掉定时器')
	// 未 start 时 check 不报
	const idle = V.createStallWatch({ now: () => 0, onStall: () => stalls.push({ idleMs: -1 }) })
	idle.check(1e9)
	assert.equal(stalls.length, 1, '未启动不报')
}

// ---- 总览条 ----
{
	const rect = V.minimapViewRect({ width: 400, total: 1000, range: { start: 500, end: 699 } })
	assert.ok(near(rect.x0, (500 / 999) * 400, 1e-6), '视口起点像素')
	assert.ok(near(rect.x1, (699 / 999) * 400, 1e-6), '视口终点像素')
	assert.ok(rect.w >= 2)
	assert.equal(V.minimapSeekIndex({ width: 400, px: 0, total: 1000 }), 0)
	assert.equal(V.minimapSeekIndex({ width: 400, px: 400, total: 1000 }), 999)
	assert.equal(V.minimapSeekIndex({ width: 400, px: 200, total: 1000 }), 500)
}

// ---- 看门狗命中：区分设备无应答 / 解析失败 / 中断（前两种不能报成「中断」或缺口）----
{
	const none = V.describeStall({ idleMs: 2600, rxBytes: 0, samples: 0 })
	assert.equal(none.kind, 'no_response')
	assert.equal(none.level, 'error')
	assert.match(none.message, /无应答.*2\.6 s/)
	const junk = V.describeStall({ idleMs: 2600, rxBytes: 512, samples: 0 })
	assert.equal(junk.kind, 'undecodable')
	assert.equal(junk.level, 'error')
	assert.match(junk.message, /512 字节/)
	const stall = V.describeStall({ idleMs: 3000, rxBytes: 4000, samples: 1000 })
	assert.equal(stall.kind, 'stall')
	assert.equal(stall.level, 'warn')
}

console.log('power-view: ok')
