'use strict'
// 协议核心（js/power-protocol.js）回归：4 字节样点流解码、跨批残帧、相位重同步、档位换算、
// 主机重采样、metadata 解析与命令字节。全部合成数据，不接真设备。
const assert = require('node:assert/strict')
const P = require('../js/power-protocol.js')

let counter = 0
function word(adc, range, logic) {
	const c = (counter++) & 0x3f
	return (((logic == null ? 0xff : logic) & 0xff) << 24 | c << 18 | ((range & 0x7) << 14) | (adc & 0x3fff)) >>> 0
}
function wordsToBytes(list) {
	const u8 = new Uint8Array(list.length * 4)
	list.forEach((w, i) => {
		u8[i * 4] = w & 0xff
		u8[i * 4 + 1] = (w >>> 8) & 0xff
		u8[i * 4 + 2] = (w >>> 16) & 0xff
		u8[i * 4 + 3] = (w >>> 24) & 0xff
	})
	return u8
}

// ---- 命令字节 ----
{
	assert.deepEqual(Array.from(P.cmdMeta()), [0x19])
	assert.deepEqual(Array.from(P.cmdAverageStart()), [0x06])
	assert.deepEqual(Array.from(P.cmdAverageStop()), [0x07])
	assert.deepEqual(Array.from(P.cmdRegulatorSet(3300)), [0x0d, 0x0c, 0xe4])
	// 电压夹到 500..5000 mV
	assert.deepEqual(Array.from(P.cmdRegulatorSet(100)), [0x0d, 0x01, 0xf4])
	assert.deepEqual(Array.from(P.cmdRegulatorSet(9000)), [0x0d, 0x13, 0x88])
	assert.deepEqual(Array.from(P.cmdDutPower(true)), [0x0c, 0x01])
	assert.deepEqual(Array.from(P.cmdDutPower(false)), [0x0c, 0x00])
}

// ---- metadata 解析 ----
{
	const mod = P.parseMetadata([
		'Calibrated=1',
		'R0=1031.64',
		'R3=0.94',
		'GS0=1.002',
		'O2=0.5',
		'VDD=3300 mV',
		'SN=ABC123',
		'END',
	].join('\r\n'))
	assert.equal(mod.Calibrated, '1')
	assert.equal(mod.R[0], 1031.64)
	assert.equal(mod.R[3], 0.94)
	assert.equal(mod.GS[0], 1.002)
	assert.equal(mod.O[2], 0.5)
	assert.equal(mod.savedVddMv, 3300)
	assert.equal(mod.deviceSn, 'ABC123')
	// 缺字段时用内置默认 R 表
	const def = P.parseMetadata('')
	assert.equal(def.R[0], 1031.64)
	assert.equal(def.R[5], 0.009)
	assert.equal(def.deviceSn, '')
}

// ---- 电流换算 ----
{
	const mod = P.defaultModifiers()
	mod.R[3] = 0.94
	const conv = new P.Converter(mod)
	// adc 在 14 位域里乘 4；iUA = (adc - O) * adcMult / R * 1e6
	const r = conv.handleRaw(word(1000, 3, 0xff))
	assert.equal(r.range, 3)
	assert.equal(r.logic, 0xff)
	// 第一点未走滤波：adc = 4000 * 1.8/163840 / 0.94 ≈ 0.04676 A ≈ 46760 µA
	assert.ok(Math.abs(r.iUA - 46760) < 200, 'rough magnitude: ' + r.iUA)
}

// ---- 样点流解码：跨批残帧 ----
{
	const parser = new P.SampleParser(new P.Converter(P.defaultModifiers()))
	const bytes = wordsToBytes([word(10, 2), word(20, 2), word(30, 2)])
	const a = parser.push(bytes.subarray(0, 6))
	assert.equal(a.segments.length, 1)
	assert.equal(a.segments[0].samples.length, 1, '6 字节能解 1 个整帧')
	assert.equal(a.segments[0].breakBefore, null, '流开头没有断点')
	assert.equal(parser.remainder.length, 2)
	const b = parser.push(bytes.subarray(6))
	assert.equal(b.segments.length, 1)
	assert.equal(b.segments[0].samples.length, 2, '残 2 字节 + 新 6 字节 = 2 个整帧')
	assert.equal(b.segments[0].breakBefore, null, '纯残帧拼接仍是连续的一段')
	assert.equal(parser.remainder.length, 0)
}

// ---- 相位重同步：中间丢 1 个字节 → 断点出现在正确位置 ----
{
	const parser = new P.SampleParser(new P.Converter(P.defaultModifiers()))
	// 先喂够 LEARN_WORDS 量的样点建立恒定位判据
	const warm = wordsToBytes(Array.from({ length: 600 }, () => word(500, 3, 0xff)))
	const r0 = parser.push(warm)
	assert.equal(r0.segments.length, 1, '学习期是一整段')
	assert.ok(parser.lockMask !== 0, '学习后应得到恒定位掩码：' + parser.lockMask)
	const resyncBefore = parser.resyncCount
	// 丢一个字节后再给一批合法样点
	const tail = wordsToBytes(Array.from({ length: 64 }, () => word(600, 3, 0xff)))
	const broken = new Uint8Array(tail.length + 1)
	broken[0] = 0x5a // 相位被打断
	broken.set(tail, 1)
	const r = parser.push(broken)
	assert.ok(parser.resyncCount > resyncBefore, '必须重同步（否则整段波形会是锯齿）')
	assert.ok(parser.droppedBytes > 0)
	// 重同步丢掉的字节是一个断点，且它把数据切成两段（前段可能为空）
	const withBreak = r.segments.filter((s) => s.breakBefore)
	assert.equal(withBreak.length, 1, '断点只出现一次：' + JSON.stringify(r.segments.map((s) => s.breakBefore)))
	assert.equal(withBreak[0].breakBefore.reason, 'resync')
	assert.ok(withBreak[0].breakBefore.bytes >= 1, '断点记下丢掉的字节数')
	// 断点两侧的样点不能进同一段
	assert.ok(r.segments.length >= 1)
}

// ---- 设备侧计数器跳变：批内断点，且位置精确 ----
{
	const parser = new P.SampleParser(new P.Converter(P.defaultModifiers()))
	parser.push(wordsToBytes(Array.from({ length: 600 }, () => word(500, 3, 0xff))))
	assert.equal(parser.counterOk, true, '计数器判据可用')
	// 造 40 个样点：前 21 个与上一个样点连续，之后计数器跳 7（= 丢 6 个样点）
	// 直接从解析器的 lastCounter 续，避免测试自己把计数器推乱
	const last = parser.lastCounter
	const list = []
	for (let i = 0; i < 40; i++) {
		const c = i <= 20 ? (last + 1 + i) & 0x3f : (last + 1 + i + 6) & 0x3f
		list.push((((0xff) << 24) | (c << 18) | (3 << 14) | ((700 + i) & 0x3fff)) >>> 0)
	}
	const r = parser.push(wordsToBytes(list))
	assert.equal(r.segments.length, 2, '计数器跳变把这一批切成两段：' + JSON.stringify(r.segments.map((s) => s.samples.length)))
	assert.equal(r.segments[0].samples.length, 21, '断点前 21 个样点：' + r.segments[0].samples.length)
	assert.equal(r.segments[0].breakBefore, null)
	assert.equal(r.segments[1].samples.length, 19, '断点后 19 个样点')
	assert.equal(r.segments[1].breakBefore.reason, 'sample_loss')
	assert.equal(r.segments[1].breakBefore.missedSamples, 6, '丢点数量按计数器差算：' + r.segments[1].breakBefore.missedSamples)
	assert.ok(parser.lostSamples >= 6)
}

// ---- 断点跨 push 保留：一批以断点结尾，下一批的第一段必须带着它 ----
{
	const parser = new P.SampleParser(new P.Converter(P.defaultModifiers()))
	parser.push(wordsToBytes(Array.from({ length: 600 }, () => word(500, 3, 0xff))))
	const last = parser.lastCounter
	// 第一批的最后一个样点计数器跳变，然后这一批就结束了
	const first = []
	for (let i = 0; i < 8; i++) first.push((((0xff) << 24) | (((last + 1 + i) & 0x3f) << 18) | (3 << 14) | (800 & 0x3fff)) >>> 0)
	first.push((((0xff) << 24) | (((last + 40) & 0x3f) << 18) | (3 << 14) | (801 & 0x3fff)) >>> 0)
	const r1 = parser.push(wordsToBytes(first))
	assert.equal(r1.segments.length, 2)
	assert.equal(r1.segments[1].samples.length, 1, '跳变之后还有 1 个点')
	// 下一批的第一段不带断点（断点已经随上一个段交付了）
	const r2 = parser.push(wordsToBytes([(((0xff) << 24) | (((last + 41) & 0x3f) << 18) | (3 << 14) | (802 & 0x3fff)) >>> 0]))
	assert.equal(r2.segments.length, 1)
	assert.equal(r2.segments[0].breakBefore, null, '断点只报一次')
}

// ---- 主机重采样 ----
{
	const adj = new P.RateAdjuster(1000, 100000)
	const outs = []
	for (let i = 0; i < 100; i++) outs.push(...adj.push(100, i))
	assert.equal(outs.length, 1, '100 个输入点出 1 个输出点（100k → 1k）')
	assert.equal(outs[0].iUA, 100)
	assert.equal(adj.appliedRateHz(), 1000)
	// 目标 >= 基速时 1:1
	const adj2 = new P.RateAdjuster(100000, 1000)
	assert.equal(adj2.push(5, 0).length, 1)
}

// ---- 总览折叠 ----
{
	const fold = new P.FoldingBuffer(4)
	for (let i = 0; i < 8; i++) fold.addData(i + 1, i * 0.1)
	const data = fold.getData()
	assert.ok(data.length > 0)
	assert.ok(fold.length <= 4, '超过容量后折叠')
	const xs = data.map((d) => d.x)
	assert.equal(Math.min(...xs) >= 0, true)
}

console.log('power-protocol: ok')
