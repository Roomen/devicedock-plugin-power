'use strict'
// 宿主合批后的 claim.rx 事件形状回归（只用合成字节，没有真硬件）：
//   { claimId, gen, seq, offset, at, bytes: Uint8Array }
// 覆盖：一次事件含多块/多帧、跨事件残帧、offset 不连续 = 缺口、换 gen = 新字节流、
// 宿主 claim.gap（overflow / closing）标记缺口、背压（高水位返回 Promise，排空后放行）。
const assert = require('node:assert/strict')
const P = require('../js/power-protocol.js')
const Claim = require('../js/power-claim.js')

// 合成样点字：14-bit ADC + range + logic，与设备一致；range<=5 才是合法字
let counter = 0
function word(adc, range, logic) {
	const c = (counter++) & 0x3f
	return ((logic & 0xff) << 24 | c << 18 | ((range & 0x7) << 14) | (adc & 0x3fff)) >>> 0
}
function wordsToBytes(list) {
	const u8 = new Uint8Array(list.length * 4)
	for (let i = 0; i < list.length; i++) {
		const w = list[i]
		u8[i * 4] = w & 0xff
		u8[i * 4 + 1] = (w >>> 8) & 0xff
		u8[i * 4 + 2] = (w >>> 16) & 0xff
		u8[i * 4 + 3] = (w >>> 24) & 0xff
	}
	return u8
}
function samples(n, adc) {
	const list = []
	for (let i = 0; i < n; i++) list.push(word(adc + (i % 3), 3, 0xff))
	return list
}

function makeLink(opts) {
	opts = opts || {}
	const batches = []
	const gaps = []
	const states = []
	const link = Claim.createClaimLink({
		host: {},
		maxPendingSamples: opts.maxPendingSamples,
		drainChunkSamples: opts.drainChunkSamples,
		scheduleDrain: opts.scheduleDrain || function (fn) { fn() },
		onSamples: function (s, at, meta) {
			batches.push({ n: s.length, at: at, seq: meta.seq, gen: meta.gen, first: s[0] && s[0].iUA })
		},
		onGap: function (g) { gaps.push(g) },
		onState: function (s) { states.push(s) },
	})
	return { link: link, batches: batches, gaps: gaps, states: states }
}
const total = (batches) => batches.reduce((s, b) => s + b.n, 0)

// ---- 一次事件含多块：字节流解析，不假设「一事件一帧」----
{
	const { link, batches, gaps } = makeLink()
	// 先喂 512 个样点让 SampleParser 学完恒定位（真机流开头也是这样）
	const warm = wordsToBytes(samples(512, 1000))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: warm })
	assert.equal(total(batches), 512, '一条事件里的多帧都要解出来')
	assert.equal(gaps.length, 0)

	// 下一条事件把「三块 read」拼在一起（多帧 + 半帧尾巴）
	const multi = wordsToBytes(samples(300, 2000))
	const withTail = new Uint8Array(multi.length + 3)
	withTail.set(multi)
	withTail.set(multi.subarray(0, 3), multi.length)
	const before = total(batches)
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: warm.length, at: 2, bytes: withTail })
	assert.equal(total(batches) - before, 300, '整帧都解出来，尾巴留给下一次')
	assert.equal(link.residualBytes(), 3, '半帧残字节留在解析器里')
	assert.equal(gaps.length, 0)
}

// ---- 跨事件残帧：7 字节 + 5 字节拼出一个整帧，再空出 2 个整帧 ----
{
	const { link, batches, gaps } = makeLink()
	const four = wordsToBytes(samples(4, 1500))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: four.subarray(0, 7) })
	assert.equal(total(batches), 1, '7 字节能解 1 个整帧')
	assert.equal(link.residualBytes(), 3)
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: 7, at: 2, bytes: four.subarray(7) })
	assert.equal(total(batches), 4, '残 3 字节 + 新 9 字节又拼出 3 个整帧（共 4 个）')
	assert.equal(link.residualBytes(), 0)
	assert.equal(gaps.length, 0, '字节连续时不该报缺口')
}

// ---- offset 不连续 = 缺口，并且要把残帧丢掉而不是拼进缺口后的数据 ----
{
	const { link, batches, gaps, states } = makeLink()
	const first = wordsToBytes(samples(10, 1200))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: first })
	const after = wordsToBytes(samples(10, 1200))
	// 宿主丢了 8 个字节：offset 直接跳到 40+8
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: first.length + 8, at: 2, bytes: after })
	assert.equal(gaps.length, 1, 'offset 跳号必须报一次缺口')
	assert.equal(gaps[0].reason, 'offset_gap')
	assert.equal(gaps[0].bytes, 8, '缺口字节数 = 两批 offset 之差')
	assert.equal(gaps[0].expectedOffset, first.length)
	assert.equal(gaps[0].offset, first.length + 8)
	assert.equal(link.residualBytes(), 0, '缺口前的残字节必须丢掉')
	// 缺口之后的字节流仍然能被解出来（相位重同步）
	assert.ok(total(batches) >= 20, '缺口后继续解样点：' + total(batches))
	assert.equal(states.length, 0, '数据缺口不改连接态')
}

// ---- 换 gen = 新字节流，不是缺口 ----
{
	const { link, batches, gaps } = makeLink()
	const a = wordsToBytes(samples(20, 900))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: a })
	// 关掉再打开：宿主 gen 变 2，offset 从 0 重新开始
	const b = wordsToBytes(samples(576, 900))
	link.handleRx({ claimId: 'c1', gen: 2, seq: 1, offset: 0, at: 2, bytes: b })
	assert.equal(gaps.length, 0, '换 gen 是新的 open，不该报缺口')
	assert.equal(link.streamGen(), 2)
	assert.equal(link.stats().genSwitches, 1)
	assert.ok(total(batches) >= 20 + 576 - 16, '新流照常解码：' + total(batches))
	// 新流不是从 0 开始（宿主已经丢过前段）：要报缺口
	link.handleRx({ claimId: 'c1', gen: 3, seq: 1, offset: 4096, at: 3, bytes: wordsToBytes(samples(8, 900)) })
	assert.equal(gaps.length, 1)
	assert.equal(gaps[0].reason, 'stream_start_offset')
	assert.equal(gaps[0].bytes, 4096)
}

// ---- 宿主 claim.gap：overflow / closing 都标记缺口，旧 gen 忽略 ----
{
	const { link, gaps } = makeLink()
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: wordsToBytes(samples(4, 900)) })
	assert.equal(link.handleGap({ claimId: 'c1', gen: 1, offset: 16, bytes: 4096, reason: 'overflow' }).gap, true)
	assert.equal(gaps.length, 1)
	assert.equal(gaps[0].reason, 'overflow')
	assert.equal(gaps[0].bytes, 4096)
	assert.equal(link.stats().gapBytes, 4096)
	// closing：关闭前宿主丢掉的尾巴，同样要标
	link.handleGap({ claimId: 'c1', gen: 1, offset: 4112, bytes: 12, reason: 'closing' })
	assert.equal(gaps.length, 2)
	assert.equal(gaps[1].reason, 'closing')
	// 旧 gen 的丢弃报告不算到新流上
	link.handleRx({ claimId: 'c1', gen: 2, seq: 1, offset: 0, at: 2, bytes: new Uint8Array(0) })
	const r = link.handleGap({ claimId: 'c1', gen: 1, offset: 0, bytes: 100, reason: 'overflow' })
	assert.equal(r.stale, true)
	assert.equal(gaps.length, 2, '旧 gen 的 gap 不再计数')
	// 别的 claim 的 gap 直接忽略
	assert.equal(link.handleGap({ claimId: 'other', gen: 2, offset: 0, bytes: 10 }).ignored, true)
	assert.equal(gaps.length, 2)
}

// ---- 排空窗口：字节计数但不解析，且恢复后不算缺口 ----
{
	const { link, batches, gaps } = makeLink()
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: wordsToBytes(samples(512, 1000)) })
	const before = total(batches)
	link.setDrop(true)
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: 2048, at: 2, bytes: wordsToBytes(samples(100, 1000)) })
	assert.equal(total(batches), before, '排空期入队但不出样点')
	assert.equal(link.stats().drainedBytes, 400)
	link.setDrop(false)
	link.handleRx({ claimId: 'c1', gen: 1, seq: 3, offset: 2448, at: 3, bytes: wordsToBytes(samples(10, 1000)) })
	assert.equal(gaps.length, 0, '排空期的 offset 已推进，恢复接收不算缺口')
	assert.equal(total(batches) - before, 10)
}

// ---- 回调纪律：同步返回 undefined，入库排在回调外 ----
{
	const drains = []
	const { link, batches } = makeLink({ scheduleDrain: function (fn) { drains.push(fn) } })
	const r = link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: wordsToBytes(samples(512, 1000)) })
	assert.equal(r, undefined, '回调必须同步返回（宿主串行发下一批 + 自动 ack）')
	assert.equal(total(batches), 0, '回调里不入库：样点先入队')
	assert.ok(link.pendingSamples() > 0)
	// 异步入库：排一次就把队列喂完（时间预算内）
	while (drains.length) drains.shift()()
	assert.equal(total(batches), 512, '入库在回调之外完成')
	assert.equal(link.pendingSamples(), 0)
}

// ---- 解码异常也不许抛出（宿主会把「抛错」当成已消费而吞掉整批）----
{
	const { link, gaps } = makeLink()
	link.setParser({
		push: function () { throw new Error('synthetic decode failure') },
		reset: function () {},
		remainder: new Uint8Array(0),
		lostSamples: 0,
	})
	let threw = false
	try {
		link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: new Uint8Array(8) })
	} catch (e) {
		threw = true
	}
	assert.equal(threw, false, '解码失败要自己接住并标缺口')
	assert.equal(gaps.length, 1)
	assert.equal(gaps[0].reason, 'decode_error')
	assert.equal(link.stats().decodeErrors, 1)
}

// ---- 队列硬上限：真跟不上时丢最老的整批并标缺口（不静默丢、不撑爆内存）----
{
	const drains = []
	const { link, gaps } = makeLink({
		maxPendingSamples: 1000,
		scheduleDrain: function (fn) { drains.push(fn) },
	})
	// 不排空：连续灌 4 批，队列必然超过上限
	for (let s = 1; s <= 4; s++) {
		link.handleRx({
			claimId: 'c1', gen: 1, seq: s, offset: (s - 1) * 4 * 512,
			at: s, bytes: wordsToBytes(samples(512, 1000)),
		})
	}
	assert.ok(link.pendingSamples() <= 1000, '队列不能超过硬上限：' + link.pendingSamples())
	const backlog = gaps.filter((g) => g.reason === 'plugin_backlog')
	assert.ok(backlog.length >= 1, '超上限必须标缺口：' + JSON.stringify(gaps.map((g) => g.reason)))
	assert.ok(backlog[0].missedSamples > 0, '缺口要记丢掉的样点数')
	assert.ok(link.stats().backlogDropped > 0)
	// 之后照常排空剩下的
	while (drains.length) drains.shift()()
	assert.equal(link.pendingSamples(), 0)
}

console.log('power-claim: ok')
