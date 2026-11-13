'use strict'
// 导出上限回归：宿主 app.saveFile 只有 8 MiB，超限必须拒绝并明确提示，
// 不允许静默截断（这是原 web-serial-debug 的导出路径没有的约束）。
const assert = require('node:assert/strict')
const E = require('../js/power-export.js')
const Wave = require('../js/power-wave.js')

const LIMIT = E.MAX_EXPORT_BYTES

;(async function () {
	// ---- 计划：刚好在上限内 → 允许；超一个字节 → 拒绝 ----
	{
		const maxRows = E.maxRowsFor(LIMIT)
		assert.ok(maxRows > 100000, '8 MiB 至少能放十几万行：' + maxRows)
		const okPlan = E.planExport({ kind: 'range', start: 0, end: maxRows })
		assert.equal(okPlan.ok, true)
		assert.ok(okPlan.estimatedBytes <= LIMIT)

		const bigPlan = E.planExport({ kind: 'range', start: 0, end: maxRows * 4 })
		assert.equal(bigPlan.ok, false)
		assert.equal(bigPlan.reason, 'too_large')
		assert.equal(bigPlan.maxSamples, maxRows)
		assert.match(bigPlan.message, /超过单次导出上限/)
		assert.deepEqual(bigPlan.suggestions, ['shorten_range', 'export_summary'])
	}

	// ---- 空区间 ----
	{
		const p = E.planExport({ kind: 'range', start: 10, end: 10 })
		assert.equal(p.ok, false)
		assert.equal(p.reason, 'empty')
	}

	// ---- 摘要永远允许 ----
	{
		const p = E.planExport({ kind: 'summary', totalSamples: 1e9 })
		assert.equal(p.ok, true)
		assert.equal(p.kind, 'summary')
	}

	// ---- 真实生成：超限时拒绝而不是截断 ----
	{
		// 用一个只报总数的假波形：CSV 每行固定开销足够大，直接走到拒绝分支
		const fakeWave = { total: () => 4e6, iAt: () => 100, gaps: () => [] }
		const r = E.buildCsv(fakeWave, 0, 4e6, { voltageMv: 3300, samplePeriodSec: 1e-5 })
		assert.equal(r.ok, false)
		assert.equal(r.code, 'too_large')
		assert.equal(r.text, undefined, '拒绝时必须没有半截内容')
		assert.match(r.message, /不会自动截断/)
	}

	// ---- 真实生成：小范围正常出 CSV，含表头与缺口标记 ----
	{
		const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
		const w = Wave.createWave({ store: store, chunkSize: 64, ramCapSamples: 64, voltage: () => 3.3, samplePeriod: () => 0.001 })
		for (let i = 0; i < 40; i++) w.push(1000 + i)
		w.noteGap(20)
		const r = E.buildCsv(w, 0, w.total(), { voltageMv: 3300, samplePeriodSec: 0.001 })
		assert.equal(r.ok, true)
		const lines = r.text.split('\n').filter((l) => l.length)
		assert.equal(lines[0], 'index,time_s,current_uA,power_uW')
		assert.equal(lines.filter((l) => l === '# gap').length, 1, '缺口处要有标记行')
		assert.ok(lines.length >= 40 - 1 + 2, '每个样点一行（含缺口标记）')
		assert.ok(r.bytes <= LIMIT)
		assert.equal(lines[1], '0,0,1000,3300', '首行是第 0 个样点')
		// 功率 = 电流 × 电压
		const row = lines.find((l) => l.indexOf('1,0.001,') === 0)
		assert.ok(row, '第二行存在：' + lines[1])
	}

	// ---- 导出服务：超限时既不调 saveFile 也不写文件 ----
	{
		let saved = 0
		const fakeWave = { total: () => 4e6, iAt: () => 1, gaps: () => [] }
		const svc = E.createExportService({
			wave: fakeWave,
			control: { state: () => ({ voltageMv: 3300 }), getSamplePeriodSec: () => 1e-5, captureSummary: () => ({ ready: true, totalSamples: 4e6 }) },
			saveFile: async () => { saved++ },
		})
		const r = await svc.exportRange(0, 4e6)
		assert.equal(r.ok, false)
		assert.equal(r.code, 'too_large')
		assert.equal(saved, 0, '超限时不能调用 saveFile')
		// 摘要路径照常可导出
		const s = await svc.exportSummary()
		assert.equal(s.ok, true)
		assert.equal(saved, 1)
	}

	// ---- 文件名清洗 ----
	{
		assert.equal(E.sanitizeFileName('a/b:c.csv'), 'a_b_c.csv')
		assert.ok(E.sanitizeFileName('x'.repeat(300)).length <= 120)
	}

	console.log('power-export: ok')
})().catch((e) => { console.error(e); process.exit(1) })
