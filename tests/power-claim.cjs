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

// ---- 换 gen = 新字节流：断点（不是丢数据），并且必须重建解析器 ----
{
	const { link, batches, gaps } = makeLink()
	const a = wordsToBytes(samples(20, 900))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: a })
	// 故意留 3 字节残帧 + 让旧解析器学到相位，再换 gen
	const broken = new Uint8Array(a.length + 3)
	broken.set(a)
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: a.length, at: 1.5, bytes: broken.subarray(a.length) })
	assert.equal(link.residualBytes(), 3, '换 gen 之前有半帧残字节')
	const oldParser = link.getParser()
	// 关掉再打开：宿主 gen 变 2，offset 从 0 重新开始
	const b = wordsToBytes(samples(576, 900))
	link.handleRx({ claimId: 'c1', gen: 2, seq: 1, offset: 0, at: 2, bytes: b })
	assert.equal(gaps.length, 1, '换 gen 是新流的开始：必须有一个断点，不能与旧流连起来')
	assert.equal(gaps[0].reason, 'gen_switch')
	assert.equal(gaps[0].bytes, 0, 'gen 切换本身不是丢字节')
	assert.equal(link.streamGen(), 2)
	assert.equal(link.stats().genSwitches, 1)
	assert.equal(link.residualBytes(), 0, '旧残帧不能带进新流')
	assert.notEqual(link.getParser(), oldParser, 'gen 边界必须重建解析器')
	assert.equal(link.stats().parserRebuilds, 1)
	assert.ok(total(batches) >= 20 + 576 - 16, '新流照常解码：' + total(batches))
	// 新流不是从 0 开始（宿主已经丢过前段）：按缺口记字节数
	link.handleRx({ claimId: 'c1', gen: 3, seq: 1, offset: 4096, at: 3, bytes: wordsToBytes(samples(8, 900)) })
	assert.equal(gaps.length, 2)
	assert.equal(gaps[1].reason, 'stream_start_offset')
	assert.equal(gaps[1].bytes, 4096)
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
	// 旧 gen 的丢弃报告不算到新流上（换 gen 本身会有一个 gen_switch 断点）
	link.handleRx({ claimId: 'c1', gen: 2, seq: 1, offset: 0, at: 2, bytes: new Uint8Array(0) })
	assert.equal(gaps.length, 3, 'gen 切换本身是断点')
	assert.equal(gaps[2].reason, 'gen_switch')
	const r = link.handleGap({ claimId: 'c1', gen: 1, offset: 0, bytes: 100, reason: 'overflow' })
	assert.equal(r.stale, true)
	assert.equal(gaps.length, 3, '旧 gen 的 gap 不再计数')
	// 别的 claim 的 gap 直接忽略
	assert.equal(link.handleGap({ claimId: 'other', gen: 2, offset: 0, bytes: 10 }).ignored, true)
	assert.equal(gaps.length, 3)
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
	// 断点是队列**里**的一项：排空时才按位置通知上层（绝不插到旧样点前面）
	assert.equal(gaps.length, 0, '还没消费时不该已经报缺口')
	while (drains.length) drains.shift()()
	const backlog = gaps.filter((g) => g.reason === 'plugin_backlog')
	assert.ok(backlog.length >= 1, '超上限必须标缺口：' + JSON.stringify(gaps.map((g) => g.reason)))
	assert.ok(backlog[0].missedSamples > 0, '缺口要记丢掉的样点数')
	assert.equal(gaps[0].reason, 'plugin_backlog', '丢的是最老的样点，断点必须排在队首')
	assert.ok(link.stats().backlogDropped > 0)
	while (drains.length) drains.shift()()
	assert.equal(link.pendingSamples(), 0)
}

// ---- 缺口必须落在真实的队列位置：不能插到还在队列里的旧样点前面 ----
{
	const drains = []
	const events = []
	const link = Claim.createClaimLink({
		host: {},
		scheduleDrain: function (fn) { drains.push(fn) },
		onSamples: function (s, at, meta) { events.push({ kind: 'samples', n: s.length, seq: meta.seq }) },
		onGap: function (g) { events.push({ kind: 'gap', reason: g.reason }) },
	})
	const warm = wordsToBytes(samples(512, 1000))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: warm })
	// 第二批还没被消费，就来了 offset 跳号：断点必须排在第二批之后
	const second = wordsToBytes(samples(200, 1000))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: warm.length, at: 2, bytes: second })
	link.handleRx({ claimId: 'c1', gen: 1, seq: 3, offset: warm.length + second.length + 64, at: 3, bytes: wordsToBytes(samples(50, 1000)) })
	// 直到这里都还没消费任何东西
	assert.deepEqual(events, [], '回调里不入库、也不立刻报缺口')
	while (drains.length) drains.shift()()
	const kinds = events.map((e) => e.kind === 'gap' ? 'gap:' + e.reason : 'samples:' + e.n)
	assert.deepEqual(kinds, ['samples:512', 'samples:200', 'gap:offset_gap', 'samples:50'],
		'样点与断点严格按到达顺序消费：' + JSON.stringify(kinds))
	// 缺口字节数 = offset 差
	const gapEvent = events.filter((e) => e.kind === 'gap')[0]
	assert.equal(gapEvent.reason, 'offset_gap')
}

// ---- 解析器自带的断点（设备丢样点）也按批内位置入队 ----
{
	const drains = []
	const events = []
	const link = Claim.createClaimLink({
		host: {},
		scheduleDrain: function (fn) { drains.push(fn) },
		onSamples: function (s, meta) { events.push({ kind: 'samples', n: s.length }) },
		onGap: function (g) { events.push({ kind: 'gap', reason: g.reason, missed: g.missedSamples }) },
	})
	// 先学满恒定位
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: wordsToBytes(samples(512, 1000)) })
	while (drains.length) drains.shift()()
	events.length = 0
	// 造一批中间有计数器跳变的样点：第 10 个点之后计数器跳 5
	const list = []
	const c0 = counter
	for (let i = 0; i < 12; i++) {
		const c = i < 10 ? (c0 + i) & 0x3f : (c0 + i + 4) & 0x3f
		list.push((((0xff) << 24) | (c << 18) | (3 << 14) | ((1200 + i) & 0x3fff)) >>> 0)
	}
	counter += 16
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: 2048, at: 2, bytes: wordsToBytes(list) })
	while (drains.length) drains.shift()()
	const kinds = events.map((e) => e.kind === 'gap' ? 'gap:' + e.reason + ':' + e.missed : 'samples:' + e.n)
	assert.equal(events.filter((e) => e.kind === 'gap').length, 1, '计数器跳变要断开：' + JSON.stringify(kinds))
	assert.equal(events.filter((e) => e.kind === 'gap')[0].reason, 'sample_loss')
	assert.ok(events[events.length - 1].kind === 'samples', '断点之后还有样点：' + JSON.stringify(kinds))
}

// ---- 排空截止点之前已收到的队列（停止采样用），返回值告诉调用方还剩多少 ----
{
	const drains = []
	const { link, batches, gaps } = makeLink({ scheduleDrain: function (fn) { drains.push(fn) } })
	const a = wordsToBytes(samples(512, 1000))
	link.handleRx({ claimId: 'c1', gen: 1, seq: 1, offset: 0, at: 1, bytes: a })
	link.handleRx({ claimId: 'c1', gen: 1, seq: 2, offset: a.length, at: 2, bytes: wordsToBytes(samples(200, 1000)) })
	assert.equal(total(batches), 0)
	const res = link.flushQueue(50)
	assert.equal(res.remaining, 0, '排空后没有剩余')
	assert.equal(total(batches), 712, '队列里的样点必须交出去：' + total(batches))
	assert.deepEqual(gaps, [], '连续数据没有缺口')
	// 排空之后新的数据仍然可以被显式排空
	link.handleRx({ claimId: 'c1', gen: 1, seq: 3, offset: a.length + 800, at: 3, bytes: wordsToBytes(samples(10, 1000)) })
	const r2 = link.flushQueue(50)
	assert.equal(r2.remaining, 0)
	assert.equal(total(batches), 722)
}

// ---- 打开失败必须回到「未打开」（不能永久停在 Opening） ----
async function openFailureCase() {
	const states = []
	const released = []
	let mode = 'acquire-fail'
	const host = {
		claim: {
			acquire: async () => {
				if (mode === 'acquire-fail') throw new Error('port busy')
				return { claimId: 'cX' }
			},
			open: async () => {
				if (mode === 'open-fail') throw new Error('cannot open')
				return { open: true }
			},
			release: async (id) => { released.push(id); return { released: true } },
			write: async () => ({ bytes: 0 }),
			ack: async () => ({ ack: true }),
		},
	}
	const link = Claim.createClaimLink({ host, scheduleDrain: function (fn) { fn() }, onState: function (s) { states.push(s) } })
	let err = null
	try { await link.open('p1') } catch (e) { err = e }
	assert.ok(err, '申请被拒要抛出')
	assert.equal(link.isOpening(), false, '失败后不能停在 Opening')
	assert.equal(link.isOpen(), false)
	assert.equal(states[states.length - 1].opening, false, '最后一次状态必须是 opening=false')
	assert.equal(link.stats().openFailures, 1)

	// 拿到声明但 open 失败：声明必须还回去，状态同样回到未打开
	mode = 'open-fail'
	err = null
	try { await link.open('p1') } catch (e) { err = e }
	assert.ok(err, 'open 失败要抛出')
	assert.deepEqual(released, ['cX'], '半成品声明要释放：' + JSON.stringify(released))
	assert.equal(link.isOpening(), false)
	assert.equal(link.isOpen(), false)
	assert.equal(link.claimId(), null)

	// 之后还能重新打开（界面不会被卡死）
	mode = 'ok'
	const ok = await link.open('p1')
	assert.equal(ok.ok, true)
	assert.equal(link.isOpen(), true)
	assert.equal(link.stats().openFailures, 2)
}

// ---- 挂断：释放声明；重复 close 幂等 ----
async function closeCase() {
	const released = []
	const host = {
		claim: {
			acquire: async () => ({ claimId: 'cY' }),
			open: async () => ({ open: true }),
			close: async () => ({ closed: true }),
			release: async (id) => { released.push(id); return { released: true } },
			write: async () => ({ bytes: 0 }),
			ack: async () => ({ ack: true }),
		},
	}
	const link = Claim.createClaimLink({ host, scheduleDrain: function (fn) { fn() } })
	await link.open('p1')
	await link.close()
	assert.deepEqual(released, ['cY'])
	assert.equal(link.isOpen(), false)
	await link.close()
	assert.deepEqual(released, ['cY'], '没有声明时 close 不重复释放')
}

openFailureCase().then(closeCase).then(function () {
	console.log('power-claim: ok')
}).catch(function (e) {
	console.error(e)
	process.exit(1)
})
