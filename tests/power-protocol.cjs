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
	assert.equal(a.length, 1, '6 字节能解 1 个整帧')
	assert.equal(parser.remainder.length, 2)
	const b = parser.push(bytes.subarray(6))
	assert.equal(b.length, 2, '残 2 字节 + 新 6 字节 = 2 个整帧')
	assert.equal(parser.remainder.length, 0)
}

// ---- 相位重同步：中间丢 1 个字节，学习完之后能找回相位 ----
{
	const parser = new P.SampleParser(new P.Converter(P.defaultModifiers()))
	// 先喂够 LEARN_WORDS 量的样点建立恒定位判据
	const warm = wordsToBytes(Array.from({ length: 600 }, () => word(500, 3, 0xff)))
	parser.push(warm)
	assert.ok(parser.lockMask !== 0, '学习后应得到恒定位掩码：' + parser.lockMask)
	const resyncBefore = parser.resyncCount
	// 丢一个字节后再给一批合法样点
	const tail = wordsToBytes(Array.from({ length: 64 }, () => word(600, 3, 0xff)))
	const broken = new Uint8Array(tail.length + 1)
	broken[0] = 0x5a // 相位被打断
	broken.set(tail, 1)
	parser.push(broken)
	assert.ok(parser.resyncCount > resyncBefore, '必须重同步（否则整段波形会是锯齿）')
	assert.ok(parser.droppedBytes > 0)
	assert.ok(parser.lostSamples >= 0)
}

// ---- 非法字不当电流画出去 ----
{
	const parser = new P.SampleParser(new P.Converter(P.defaultModifiers()))
	const warm = wordsToBytes(Array.from({ length: 600 }, () => word(500, 3, 0xff)))
	parser.push(warm)
	const bad = new Uint8Array(4 * 4)
	// range = 7 在 14 位域之外（>5），整批都非法
	for (let i = 0; i < 4; i++) {
		const w = (0x7 << 14) | 0x1234
		bad[i * 4] = w & 0xff
		bad[i * 4 + 1] = (w >>> 8) & 0xff
		bad[i * 4 + 2] = (w >>> 16) & 0xff
		bad[i * 4 + 3] = (w >>> 24) & 0xff
	}
	parser.push(bad)
	assert.ok(parser.badSamples > 0, '非法字要计入 badSamples')
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
