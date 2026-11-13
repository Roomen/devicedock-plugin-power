'use strict'
// CSV 导入解析（js/power-import.js）回归：表头识别、无表头回退、缺口标记、时间步长、
// 逐行电压与「能量是否可用」的判定。只解析字符串，不碰文件系统。
const assert = require('node:assert/strict')
const I = require('../js/power-import.js')

;(function () {
	// ---- 本插件导出的格式（含表头与 gap 标记）----
	{
		const csv = [
			'index,time_s,current_uA,power_uW,voltage_mV',
			'0,0,1000,3300,3300',
			'1,0.001,1001,3303.3,3300',
			'# gap overflow 20..20',
			'2,0.002,1002,3306.6,3300',
			'# gap dropped 30..40',
			'3,0.003,1003,3309.9,3300',
			'',
		].join('\n')
		const p = I.parseCsv(csv)
		assert.equal(p.ok, true)
		assert.equal(p.rows.length, 4)
		assert.equal(p.rows[0].currentUA, 1000)
		assert.equal(p.rows[3].index, 3)
		assert.deepEqual(p.gaps, [2, 3], '两条 gap 标记对应第 2、3 行之前：' + JSON.stringify(p.gaps))
		assert.equal(p.markers, 2)
		assert.ok(Math.abs(p.samplePeriodSec - 0.001) < 1e-12, '时间步长来自 time 列：' + p.samplePeriodSec)
		assert.equal(p.volts, 3300)
		assert.equal(p.voltsMixed, false)
		assert.equal(p.powerUsable, true)
		const sum = I.summarize(p)
		assert.match(sum.text, /4 rows/)
		assert.match(sum.text, /1000 Hz/)
		assert.match(sum.text, /2 gap marker/)
		assert.equal(sum.warn, false)
	}

	// ---- 无表头 3 列：index,time,current ----
	{
		const p = I.parseCsv('0,0,10\n1,0.5,20\n2,1.0,30\n')
		assert.equal(p.ok, true)
		assert.equal(p.rows.length, 3)
		assert.equal(p.rows[1].currentUA, 20)
		assert.ok(Math.abs(p.samplePeriodSec - 0.5) < 1e-12)
		assert.equal(p.volts, null)
		assert.equal(p.powerUsable, false, '没有电压时能量不可用')
		assert.equal(I.summarize(p).warn, true)
	}

	// ---- 无表头 2 列：time,current ----
	{
		const p = I.parseCsv('0,100\n0.01,200\n0.02,300\n')
		assert.equal(p.ok, true)
		assert.equal(p.rows.length, 3)
		assert.equal(p.rows[0].currentUA, 100)
		assert.ok(Math.abs(p.samplePeriodSec - 0.01) < 1e-12)
	}

	// ---- 表头列顺序被打乱也能认 ----
	{
		const p = I.parseCsv('current_uA,voltage_mV,time_s,index\n100,1800,0,0\n200,1800,0.001,1\n')
		assert.equal(p.ok, true)
		assert.equal(p.rows[0].currentUA, 100)
		assert.equal(p.rows[0].voltageMV, 1800)
		assert.ok(Math.abs(p.samplePeriodSec - 0.001) < 1e-12)
	}

	// ---- 电压混用：按功率反推电流加权平均 ----
	{
		const p = I.parseCsv([
			'index,time_s,current_uA,power_uW,voltage_mV',
			'0,0,1000,3300,3300',
			'1,0.001,1000,1650,1650',
		].join('\n'))
		assert.equal(p.ok, true)
		assert.equal(p.voltsMixed, true)
		// 按电流加权：Σ(power×1000) / Σ(current) = 4950000/2000 = 2475 mV
		assert.ok(Math.abs(p.volts - 2475) < 1e-9, '加权平均电压（mV）：' + p.volts)
		assert.match(I.summarize(p).text, /mixed voltage/)
	}

	// ---- 坏行跳过并计数；缺电流列直接失败 ----
	{
		const p = I.parseCsv('index,time_s,current_uA\n0,0,100\n1,0.001,oops\n2,0.002,300\n')
		assert.equal(p.ok, true)
		assert.equal(p.rows.length, 2)
		assert.equal(p.skipped, 1)
		assert.match(I.summarize(p).text, /1 row\(s\) skipped/)
		const bad = I.parseCsv('index,time_s\n0,0\n1,1\n')
		assert.equal(bad.ok, false)
		assert.equal(bad.reason, 'no_current_column')
		const empty = I.parseCsv('')
		assert.equal(empty.ok, false)
		assert.equal(empty.reason, 'empty')
		const nothing = I.parseCsv('# gap only\n')
		assert.equal(nothing.ok, false)
	}

	// ---- 行数上限 ----
	{
		const lines = ['index,time_s,current_uA']
		for (let i = 0; i < 10; i++) lines.push(i + ',' + (i * 0.001) + ',100')
		const p = I.parseCsv(lines.join('\n'), { maxRows: 5 })
		assert.equal(p.ok, false)
		assert.equal(p.reason, 'too_many_rows')
	}

	// ---- N3：缺口重置时间基线，周期只按段内时间差 ----
	{
		const csv = [
			'index,time_s,current_uA',
			'0,0,1000',
			'1,0.001,1000',
			'# gap overflow 2..2',
			'2,1,1000',
			'3,1.001,1000',
			'4,1.002,1000',
		].join('\n')
		const p = I.parseCsv(csv)
		assert.equal(p.ok, true)
		assert.equal(p.rows.length, 5)
		assert.ok(Math.abs(p.samplePeriodSec - 0.001) < 1e-12, '周期必须是段内的 1 ms，不能把缺口摊进去：' + p.samplePeriodSec)
		assert.equal(p.gaps.length, 1, '缺口标记要留一条：' + JSON.stringify(p.gaps))
		assert.equal(p.segments.length, 2, '缺口把导入拆成两段：' + JSON.stringify(p.segments.map((s) => [s.start, s.end])))
		assert.equal(p.segments[0].dtN, 1)
		assert.equal(p.segments[1].dtN, 2)
	}

	// ---- N3：倒序 / 不变时间明确断开，不参与周期统计 ----
	{
		const p = I.parseCsv('index,time_s,current_uA\n0,0,1\n1,0.001,1\n2,0.0005,1\n3,0.0015,1\n')
		assert.equal(p.ok, true)
		assert.ok(p.timeJumps >= 1, '倒序时间必须被识别：' + p.timeJumps)
		assert.ok(p.segments.length >= 2, '断成多段：' + p.segments.length)
		assert.ok(Math.abs(p.samplePeriodSec - 0.001) < 1e-12, '周期只用有效的那一段：' + p.samplePeriodSec)
	}

	// ---- N3：步长突变同样断开，避免把间隙摊进周期 ----
	{
		const p = I.parseCsv('index,time_s,current_uA\n0,0,1\n1,0.001,1\n2,0.002,1\n3,1.002,1\n4,1.003,1\n')
		assert.ok(p.timeJumps >= 1, '步长突变要断开：' + p.timeJumps)
		assert.ok(Math.abs(p.samplePeriodSec - 0.001) < 1e-12, '周期仍是 1 ms：' + p.samplePeriodSec)
	}

	// ---- N4：没有电压列 → hasVoltage=false（能量不可用），不能继承当前设置 ----
	{
		const p = I.parseCsv('index,time_s,current_uA\n0,0,1000\n1,1,1000\n')
		assert.equal(p.hasVoltage, false)
		assert.equal(p.powerUsable, false)
		assert.equal(p.volts, null)
		assert.match(I.summarize(p).text, /no voltage/)
		assert.match(I.summarize(p).text, /energy unavailable/)
	}

	console.log('power-import: ok')
})()
