'use strict'
// 分析面板纯计算回归（js/power-panels.js）：区间挑选、抽稀、游标读数（不跨缺口）、
// 边沿/周期测量、FFT 峰值、电池续航、周期叠画。
const assert = require('node:assert/strict')
const W = require('../js/power-wave.js')
const P = require('../js/power-panels.js')

function makeWave(opts) {
	opts = opts || {}
	const store = {
		init: async () => {},
		getDiskUsed: () => 0,
		writeChunk: async () => ({ byteSize: 0 }),
		readChunk: async () => null,
		removeChunk: async () => {},
		clearSession: async () => {},
	}
	const w = W.createWave({
		store: store,
		chunkSize: opts.chunkSize || 1024,
		ramCapSamples: opts.ramCap || 4096,
		voltage: () => opts.voltageV == null ? 3.3 : opts.voltageV,
		samplePeriod: () => opts.periodSec == null ? 0.001 : opts.periodSec,
	})
	return w
}

const tick = () => new Promise((r) => setTimeout(r, 0))

;(async function () {
	// ---- 区间挑选 ----
	{
		const total = 1000
		const sel = { a: 100, b: 200 }
		const vr = { start: 800, end: 999, count: 200 }
		assert.deepEqual(P.pickRange({ mode: 'auto', total, selection: sel, viewRange: vr }), { a: 100, b: 200, source: 'selection' })
		assert.deepEqual(P.pickRange({ mode: 'auto', total, selection: null, viewRange: vr }), { a: 800, b: 999, source: 'window' })
		assert.equal(P.pickRange({ mode: 'selection', total, selection: null, viewRange: vr }), null, 'selection 模式没有选择就是空的')
		assert.deepEqual(P.pickRange({ mode: 'window', total, selection: sel, viewRange: vr }), { a: 800, b: 999, source: 'window' })
		assert.equal(P.pickRange({ mode: 'window', total: 1, viewRange: vr }), null, '没有数据就没有区间')
		assert.equal(P.pickRange({ mode: 'selection', total, selection: { a: 50, b: 50 } }), null, '单点不算区间')
		// 反向选择自动排序、越界夹紧
		assert.deepEqual(P.pickRange({ mode: 'selection', total, selection: { a: 300, b: 150 } }), { a: 150, b: 300, source: 'selection' })
		assert.deepEqual(P.pickRange({ mode: 'selection', total, selection: { a: -5, b: 5000 } }), { a: 0, b: 999, source: 'selection' })
	}

	// ---- 抽稀 ----
	{
		const w = makeWave()
		for (let i = 0; i < 3000; i++) w.push(i)
		const ext = P.extractSamples(w, 0, 2999, { maxPts: 100, samplePeriodSec: 0.001 })
		assert.equal(ext.step, 30, '3000 点抽到 100 → 步长 30')
		assert.equal(ext.samples.length, 100)
		assert.equal(ext.samples[0], 0)
		assert.equal(ext.samples[1], 30)
		assert.equal(ext.nRaw, 3000)
		assert.ok(Math.abs(ext.periodSec - 0.03) < 1e-12, '抽稀后周期同步放大')
		const full = P.extractSamples(w, 0, 2999, { maxPts: 10000, samplePeriodSec: 0.001 })
		assert.equal(full.step, 1)
		assert.equal(full.samples.length, 3000)
		assert.equal(P.extractSamples(w, 5, 5, {}).samples.length, 1)
		assert.equal(P.extractSamples(w, 10, 5, {}).a, 5, '反向区间自动排序')
	}

	// ---- 游标读数：时长 / 均值 / 能量不跨缺口 ----
	{
		const w = makeWave({ periodSec: 1 })
		for (let i = 0; i < 40; i++) w.push(1000)
		w.noteGap(20)
		for (let i = 0; i < 40; i++) w.push(1000)
		const m = P.measureCursors(w, 0, 79, { samplePeriodSec: 1 })
		assert.equal(m.ready, true)
		assert.equal(m.samples, 80)
		assert.equal(m.gaps, 1)
		assert.equal(m.segments, 2)
		assert.equal(m.wallSec, 79, '墙上时长 79 个间隔')
		assert.equal(m.durSec, 78, '缺口切掉 1 个间隔，绝不跨缺口累加')
		assert.ok(Math.abs(m.gapRatio - 1 / 79) < 1e-9, '缺口占比：' + m.gapRatio)
		assert.equal(m.avgI, 1000)
		assert.ok(Math.abs(m.chargeUC - 78000) < 1e-6, '电量 = 均值 × 连续时长：' + m.chargeUC)
		assert.ok(Math.abs(m.energyUWh - 3.3 * 78000 / 3600) < 1e-6, '能量同口径：' + m.energyUWh)
		// 只取缺口之后的段：没有缺口
		const seg2 = P.measureCursors(w, 20, 79, { samplePeriodSec: 1 })
		assert.equal(seg2.gaps, 0)
		assert.equal(seg2.durSec, 59)
		// 单点
		const one = P.measureCursors(w, 30, 30, { samplePeriodSec: 1 })
		assert.equal(one.durSec, 0)
		assert.equal(one.samples, 1)
		assert.equal(one.gaps, 0)
		// 越界
		assert.equal(P.measureCursors(w, -10, 5, { samplePeriodSec: 1 }).ready, false)
		assert.equal(P.measureCursors(w, null, 5, { samplePeriodSec: 1 }).ready, false)
	}

	// ---- 边沿 / 周期 / 占空比 ----
	{
		const w = makeWave({ periodSec: 0.001 })
		// 方波：周期 100 点，占空比 25%（高 25 点）
		for (let i = 0; i < 2000; i++) w.push((i % 100) < 25 ? 1000 : 50)
		const edge = P.measureEdges(w, 0, 1999, { samplePeriodSec: 0.001 })
		// 2000 点 / 周期 100 = 20 段；首点从低电平起跳，扫描从 a+1 开始，所以是 19 个上升沿
		assert.equal(edge.nRise, 19, '上升沿数量：' + edge.nRise)
		assert.equal(edge.nFall, 20)
		assert.ok(Math.abs(edge.periodSec - 0.1) < 1e-9, '周期 0.1 s：' + edge.periodSec)
		assert.ok(Math.abs(edge.freqHz - 10) < 1e-6, '频率 10 Hz：' + edge.freqHz)
		assert.ok(Math.abs(edge.duty - 0.25) < 1e-6, '占空比 25%：' + edge.duty)
		assert.ok(edge.thr > 50 && edge.thr < 1000, '默认阈值取 min/max 中点：' + edge.thr)
		// 恒定电流：没有沿
		const flat = makeWave()
		for (let i = 0; i < 500; i++) flat.push(7)
		const fe = P.measureEdges(flat, 0, 499, { samplePeriodSec: 0.001 })
		assert.equal(fe.nRise, 0)
		assert.equal(fe.periodSec, null)
	}

	// ---- 沿位置与吸附 ----
	{
		const w = makeWave({ periodSec: 0.001 })
		for (let i = 0; i < 1000; i++) w.push((i % 100) < 50 ? 1000 : 100)
		const ed = P.findEdges(w, 0, 999, { samplePeriodSec: 0.001 })
		assert.ok(ed.rises.length >= 9, '找到上升沿：' + ed.rises.length)
		// 序列是「先高 50 点、再低 50 点」：上升沿在 100 的倍数上，下降沿在 50 的倍数上
		assert.equal(ed.rises[0] % 100, 0, '上升沿位置：' + ed.rises[0])
		assert.equal(ed.falls[0] % 100, 50, '下降沿位置：' + ed.falls[0])
		assert.ok(ed.thr > 100 && ed.thr < 1000)
		// 吸附：靠近上升沿 52 → 吸到 50
		const near1 = P.nearestEdge(w, 0, 999, 102, 6)
		assert.equal(near1.index, 100)
		assert.equal(near1.dist, 2)
		// 超出距离不吸
		assert.equal(P.nearestEdge(w, 0, 999, 25, 6), null, '离沿太远不吸附')
		// 距离内取最近的沿
		const near2 = P.nearestEdge(w, 0, 999, 470, 25)
		assert.ok(near2 && (near2.index === 450 || near2.index === 500), '取最近的沿：' + (near2 && near2.index))
	}

	// ---- 分析包：读数额度 + FFT + 电池 + 叠画 ----
	{
		const w = makeWave({ periodSec: 0.001 })
		// 1 kHz 采样、10 Hz 方波，叠画应能切出 10 个周期左右
		for (let i = 0; i < 4000; i++) w.push((i % 100) < 50 ? 2000 : 200)
		const range = { a: 0, b: 3999, source: 'window' }
		const pack = P.buildPack({ wave: w, range: range, samplePeriodSec: 0.001, voltageMv: 3300, capacityMah: 2000, fft: true, cycles: true, segments: true })
		assert.ok(pack, '包应能建出来')
		assert.equal(pack.source, 'window')
		assert.equal(pack.nRaw, 4000)
		assert.ok(pack.rateHz > 0)
		assert.ok(pack.basic.n > 0)
		assert.ok(pack.levels.lowAvg != null && pack.levels.highAvg != null, '双电平有两侧均值')
		assert.ok(pack.levels.highAvg > pack.levels.lowAvg)
		// 周期电量
		assert.ok(pack.qCycle > 0, '每周期电量：' + pack.qCycle)
		// FFT：10 Hz 处有峰
		assert.ok(pack.fft && pack.fft.ok !== false, 'FFT 应可用')
		const peaks = pack.fft.peaks || []
		assert.ok(peaks.length > 0, 'FFT 有峰')
		assert.ok(Math.abs(peaks[0].freqHz - 10) < 2, '主峰在 10 Hz 附近：' + peaks[0].freqHz)
		// 电池：2 V? 用均值估算
		assert.ok(pack.battery && pack.battery.ok, '电池估算可用')
		assert.ok(pack.battery.days > 0)
		// 叠画：周期 100 点，4000 点 → 最多 32 段
		assert.ok(pack.cycles && pack.cycles.nCycles > 0, '叠画有周期')
		assert.ok(pack.cycles.cycles.length <= 32)
		assert.equal(pack.cycles.mean.length, pack.cycles.cycles[0].length, '均值曲线与周期等长')
		// 分段（Sleep/Active）
		assert.ok(pack.segments && pack.segments.segments.length >= 2, '按阈值分段')
		// 电压改了，能量跟着改
		const pack2 = P.buildPack({ wave: w, range: range, samplePeriodSec: 0.001, voltageMv: 5000 })
		assert.ok(pack2.measure.energyUWh > pack.measure.energyUWh, '电压更高 → 能量更高')
		// 不带可选面板时不白算
		const lean = P.buildPack({ wave: w, range: range, samplePeriodSec: 0.001 })
		assert.equal(lean.fft, null)
		assert.equal(lean.cycles, null)
		assert.equal(lean.battery, null)
		assert.equal(P.buildPack({ wave: null, range: range }), null)
	}

	// ---- 缺口段里的分析包：时长与能量同口径 ----
	{
		const w = makeWave({ periodSec: 1 })
		for (let i = 0; i < 30; i++) w.push(500)
		w.noteGap(15)
		for (let i = 0; i < 30; i++) w.push(500)
		const pack = P.buildPack({ wave: w, range: { a: 0, b: 59, source: 'selection' }, samplePeriodSec: 1, voltageMv: 1000 })
		assert.equal(pack.measure.gaps, 1)
		assert.equal(pack.measure.durSec, 58, '59 个间隔减掉缺口那一个')
		assert.ok(Math.abs(pack.measure.chargeUC - 500 * 58) < 1e-6)
		// 双电平统计的是抽稀样点（含缺口两侧），但时长/能量走缺口口径
		assert.ok(pack.basic.n > 0)
	}

	// ---- 格式化口径一致 ----
	{
		assert.equal(P.fmtCurrent(0), '0 µA')
		assert.equal(P.fmtCurrent(1500), '1.500 mA')
		assert.equal(P.fmtCurrent(2e6), '2.000 A')
		assert.equal(P.fmtPower(3300), '3.30 mW')
		assert.equal(P.fmtCharge(1e6), '1.000 C')
		assert.equal(P.fmtEnergy(1e3), '1.000 mWh')
		assert.equal(P.fmtDuration(0), '0 s')
		assert.equal(P.fmtDuration(0.25), '250 ms')
		assert.equal(P.fmtDuration(90), '1 min 30 s')
		assert.equal(P.fmtFreq(1000), '1.000 kHz')
		assert.equal(P.fmtPercent(0.255), '25.5%')
		assert.equal(P.fmtCurrent(NaN), '--')
	}

	console.log('power-panels: ok')
})().catch((e) => { console.error(e); process.exit(1) })
