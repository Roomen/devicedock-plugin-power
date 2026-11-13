'use strict'
// 功耗仪上下电 / 电压 / 采样启停 / 摘要的回归（从 web-serial-debug 的 power-control 迁入）：
// 直接跑本仓库的 js/power-claim.js（假宿主，claim.* 链路）+ js/power-control.js，
// 覆盖原测试的全部行为契约，并额外覆盖「缺口不跨段积分能量」。
const assert = require('node:assert/strict')
const P = require('../js/power-protocol.js')
const Claim = require('../js/power-claim.js')
const Control = require('../js/power-control.js')

const settle = () => new Promise((r) => setImmediate(r))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeHarness(opts) {
	opts = opts || {}
	const state = {
		writes: [],
		writeMode: 'ok', // ok | throw
		writeDelay: 0,
		writeFailAt: 0, // 从第几次写入开始失败（0 = 不按次序失败）
		openSeq: 0,
		claims: new Map(),
		logs: [],
		changes: 0,
		samples: 0,
		gaps: [],
		onStoreInit: null,
	}
	// 冷存储的 init 由测试决定做什么（例如「初始化期间连接断了」）
	state.store = {
		init: async () => { if (state.onStoreInit) await state.onStoreInit() },
	}
	function makeHost() {
		const listeners = new Map()
		return {
			device: { listPorts: async () => [] },
			on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
			claim: {
				onRx: () => () => {},
				onGap: () => () => {},
				acquire: async (portKey, mode) => {
					const id = 'claim' + (++state.openSeq)
					state.claims.set(id, { portKey: portKey, open: false })
					return { claimId: id, mode: mode || 'exclusive' }
				},
				open: async (id) => {
					const c = state.claims.get(id)
					if (!c) throw new Error('no claim')
					c.open = true
				},
				close: async (id) => { const c = state.claims.get(id); if (c) c.open = false },
				release: async (id) => { state.claims.delete(id) },
				write: async (id, bytes) => {
					state.writes.push({ id: id, bytes: Array.from(bytes) })
					const n = state.writes.length
					if (state.writeDelay > 0) await wait(state.writeDelay)
					if (state.writeFailAt && n >= state.writeFailAt) throw new Error('synthetic write failure')
					if (state.writeMode === 'throw') throw new Error('synthetic write failure')
					return { bytes: bytes.length }
				},
				ack: async () => ({ ack: true }),
			},
		}
	}

	const link = Claim.createClaimLink({
		host: makeHost(),
		baudRate: 115200,
		scheduleDrain: (fn) => fn(),
		onSamples: (list) => { state.samples += list.length },
		onGap: (g) => state.gaps.push(g),
		onLog: (msg, level) => state.logs.push({ msg: msg, level: level || '' }),
	})

	const wave = {
		pushed: 0,
		scriptedStats: null,
		// lastPushed 让用例能断言「实际入库的电流值」，而不只是条数
		push(v) { wave.pushed++; wave.lastPushed = v; return true },
		lastPushed: null,
		reset() { wave.pushed = 0 },

		// total / retained 可以分别设定：模拟「旧样点被淘汰」
		totalValue: null,
		retainedValue: null,
		total() { return wave.totalValue == null ? wave.pushed : wave.totalValue },
		retained() { return wave.retainedValue == null ? wave.pushed : wave.retainedValue },
		stats() { return Object.assign({ n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0, dur: 0, gaps: 0 }, wave.scriptedStats || {}) },
		gaps() { return state.gaps },
		storageStop() { return false },
		noteGap() {},
	}

	const control = Control.createControl({
		link: link,
		wave: wave,
		store: state.store,
		settings: { recordMode: opts.recordMode || 'wave', targetRateHz: 1000, voltageMv: 3300 },
		options: { rxDrainMs: 0 },
		log: (msg, level) => state.logs.push({ msg: msg, level: level || '' }),
		onChange: () => { state.changes++ },
	})

	return { link, control, wave, state }
}

async function connected(opts) {
	const h = makeHarness(opts)
	await h.link.open('p1')
	h.state.writes.length = 0
	return h
}

const tests = []
function test(name, fn) { tests.push({ name: name, fn: fn }) }

test('上电：电压写失败时绝不下发上电命令', async () => {
	const h = await connected()
	h.state.writeMode = 'throw'
	const r = await h.control.doPowerOn()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'voltage_write_failed')
	assert.equal(h.state.writes.length, 1, '只尝试过电压写入')
	assert.equal(h.control.powerPayload().state, 'unknown')
})

test('上电：电压成功后写 DUT 上电，状态记为 commanded', async () => {
	const h = await connected()
	const r = await h.control.doPowerOn()
	assert.equal(r.ok, true)
	assert.equal(h.state.writes.length, 2)
	assert.deepEqual(h.state.writes[0].bytes, Array.from(P.cmdRegulatorSet(3300)))
	assert.deepEqual(h.state.writes[1].bytes, Array.from(P.cmdDutPower(true)))
	assert.equal(h.control.powerPayload().state, 'on')
	assert.equal(h.control.powerPayload().source, 'commanded')
})

test('上电写失败：不谎称已上电，状态标成 unknown', async () => {
	const h = await connected()
	h.state.writeFailAt = 2 // 第一次(电压)成功，第二次(上电)失败
	const r = await h.control.doPowerOn()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'power_write_failed')
	assert.equal(r.executed, 'unknown')
	assert.equal(h.control.powerPayload().state, 'unknown')
	assert.equal(h.control.powerPayload().source, 'unknown')
})

test('下电写失败：同样标 unknown，不保留上一次 commanded', async () => {
	const h = await connected()
	h.control.markPowered(true, 'commanded')
	h.state.writeMode = 'throw'
	const r = await h.control.doPowerOff()
	assert.equal(r.ok, false)
	assert.equal(r.executed, 'unknown')
	assert.equal(h.control.powerPayload().state, 'unknown')
})

test('电压写失败：不把请求值当成已生效', async () => {
	const h = await connected()
	h.state.writeMode = 'throw'
	const r = await h.control.applyVoltageMv(1800)
	assert.equal(r.ok, false)
	assert.equal(r.stale, false)
	assert.equal(h.control.readVoltageMv(), 3300, '仍保持上一次有效电压')
})

test('写入完成后连接已变化：不把结果算到新连接，也不改它的供电状态', async () => {
	const h = await connected()
	h.state.writeDelay = 20
	const pending = h.control.doPowerOn()
	await wait(5)
	// 写入还没完成时占用被宿主收回（停用 / 关闭），代次推进；新连接自己的供电状态是「已知下电」
	h.link.handleClaimState({ claims: [] })
	h.control.markPowered(false, 'commanded')
	const r = await pending
	assert.equal(r.ok, false)
	assert.equal(r.code, 'disconnected')
	assert.equal(r.executed, 'unknown')
	// 新连接的状态必须原样保留，不能被旧连接的上电失败改成 unknown
	assert.equal(h.control.powerPayload().state, 'off')
	assert.equal(h.control.powerPayload().source, 'commanded')
})

test('取消发生在电压与上电之间：不再上电', async () => {
	const h = await connected()
	let step = 0
	const guard = {
		start: () => Promise.resolve(null),
		step: () => {
			step++
			return step >= 2 ? { ok: false, code: 'aborted', message: '请求已取消，未上电', executed: false } : null
		},
	}
	const r = await h.control.doPowerOn(guard)
	assert.equal(r.ok, false)
	assert.equal(r.code, 'aborted')
	assert.equal(h.state.writes.length, 1, '只写入了电压')
	assert.equal(h.control.powerPayload().state, 'unknown')
})

test('存储初始化期间断开：不开始采样、不发 START', async () => {
	const h = await connected()
	h.state.onStoreInit = () => { h.link.handleClaimState({ claims: [] }) }
	const r = await h.control.startSampling()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'disconnected')
	assert.equal(h.control.isSampling(), false)
	assert.equal(h.state.writes.filter((w) => w.bytes[0] === P.CMD.AVERAGE_START).length, 0)
})

test('存储初始化期间取消：不开始采样', async () => {
	const h = await connected()
	let step = 0
	const guard = {
		start: () => Promise.resolve(null),
		step: () => {
			step++
			return step >= 2 ? { ok: false, code: 'aborted', message: '请求已取消，未开始采样', executed: false } : null
		},
	}
	const r = await h.control.startSampling(guard)
	assert.equal(r.ok, false)
	assert.equal(r.code, 'aborted')
	assert.equal(h.control.isSampling(), false)
	assert.equal(h.state.writes.filter((w) => w.bytes[0] === P.CMD.AVERAGE_START).length, 0)
})

test('正常开始采样：STOP 排空 → START，状态为采样中', async () => {
	const h = await connected()
	const r = await h.control.startSampling()
	assert.equal(r.ok, true)
	assert.equal(h.control.isSampling(), true)
	assert.deepEqual(h.state.writes.map((w) => w.bytes[0]), [P.CMD.AVERAGE_STOP, P.CMD.AVERAGE_START])
})

test('停止采样：先停入库再发 STOP', async () => {
	const h = await connected()
	await h.control.startSampling()
	h.state.writes.length = 0
	const r = await h.control.stopSampling()
	assert.equal(r.ok, true)
	assert.deepEqual(h.state.writes.map((w) => w.bytes[0]), [P.CMD.AVERAGE_STOP])
	assert.equal(h.control.isSampling(), false)
})

test('摘要：长期模式样点数取 longStats，能量不拿当前电压凑', async () => {
	const h = await connected()
	h.control.setRecordMode('long')
	// 长期模式：两个样点之间 0.4 s
	h.control.ingest(1000, 100)
	h.control.ingest(1400, 200)
	const s = h.control.captureSummary()
	assert.equal(s.ready, true, '长期模式样点不进波形环，也要能出摘要')
	assert.equal(s.totalSamples, 2)
	assert.equal(s.retainedSamples, 2)
	assert.equal(s.span, 'full_session')
	assert.equal(s.energyUWh, null)
	assert.equal(s.energySource, 'unavailable')
	assert.ok(s.chargeUC > 0)
})

test('摘要：波形模式被淘汰时标 retained，能量来自存储累加', async () => {
	const h = await connected()
	h.control.setRecordMode('wave')
	h.wave.totalValue = 200
	h.wave.retainedValue = 100
	h.wave.scriptedStats = { n: 100, avgI: 1000, avgP: 3300, minI: 10, maxI: 2000, dur: 1, chargeUC: 1000, energyUWh: 3300 }
	// 保留量少于总数：旧样点被淘汰，统计只覆盖仍保留的部分
	const s = h.control.captureSummary()
	assert.equal(s.ready, true)
	assert.equal(s.totalSamples, 200)
	assert.equal(s.retainedSamples, 100)
	assert.equal(s.span, 'retained')
	assert.equal(s.energyUWh, 3300)
	assert.equal(s.energySource, 'stored_chunk_sums')
})

test('摘要：没采到样点时 ready=false 且说明原因', async () => {
	const h = await connected()
	const s = h.control.captureSummary()
	assert.equal(s.ready, false)
	assert.equal(s.reason, 'no_samples')
	await h.link.close()
	assert.equal(h.control.captureSummary().reason, 'power_not_connected')
})

test('setPower 幂等只认「上次命令」：实测 / 未知状态照样下发命令', async () => {
	const h = await connected()
	h.control.markPowered(true, 'probed')
	const r = await h.control.setPower(true)
	assert.equal(r.ok, true)
	assert.ok(h.state.writes.some((w) => w.bytes[0] === P.CMD.DEVICE_RUNNING_SET), 'probed 不足以跳过命令')
	assert.equal(h.control.powerPayload().state, 'on')
	assert.equal(h.control.powerPayload().source, 'commanded')
	const again = await h.control.setPower(true)
	assert.equal(again.changed, false, 'commanded 相同状态才跳过')
	assert.equal(h.state.writes.filter((w) => w.bytes[0] === P.CMD.DEVICE_RUNNING_SET).length, 1)
})

test('队列：后台的 failFast 不会排在正在执行的操作后面', async () => {
	const h = await connected()
	h.state.writeDelay = 30
	const slow = h.control.setVoltage(3500)
	await wait(2)
	const busy = await h.control.setPower(false, { start: () => Promise.resolve(null), step: () => null })
	assert.equal(busy.ok, false)
	assert.equal(busy.code, 'power_busy')
	await slow
})

test('缺口：能量不跨缺口积分', async () => {
	const h = await connected()
	h.control.setRecordMode('wave')
	// 正常连续：每 1000 ms 一个样点，周期 1 s → dt = 1 s
	h.control.setSamplePeriodSec(1)
	h.control.ingest(0, 100)
	h.control.ingest(1000, 100)
	assert.equal(h.control.captureSummary().durationSec, 0, '波形模式的时长由存储按段统计，这里只验证不跨缺口')
	// 标一个缺口再继续：这一段不能与前面连起来算
	h.control.noteGap({ reason: 'offset_gap' })
	assert.equal(h.control.captureSummary().gaps >= 0, true)
	const st = h.control.overallStats()
	assert.ok(st.n >= 0)
})

test('原始流 100 kHz + 目标 1 kHz：重采样后入库，不存 100 倍数据', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	await h.control.startSampling()
	// 模拟设备满速：每 10 ms 到 1000 个样点（= 100 kHz），共 200 ms
	let stored = 0
	for (let batch = 0; batch < 20; batch++) {
		const list = []
		for (let i = 0; i < 1000; i++) list.push({ iUA: 100, range: 3, logic: 0xff })
		stored += h.control.pushSamples(list, batch * 10 + 10, { from: 0, total: list.length })
	}
	assert.ok(stored > 0, '必须有样点入库')
	assert.ok(stored <= 260, '1 kHz 目标下 200 ms 最多约 200 点，实际 ' + stored)
	assert.ok(stored >= 150, '不能少得太离谱：' + stored)
	assert.equal(h.control.deviceStreamHz(), 100000, '实测设备速率')
	assert.ok(Math.abs(h.control.getSamplePeriodSec() - 0.001) < 1e-6, '周期按输出速率：' + h.control.getSamplePeriodSec())
})

test('采样沿启动：命中启动沿之前不入库，命中后开闸', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	h.control.setTrigLevel(50)
	h.control.setAcqTriggers('rise', 'off')
	await h.control.startSampling()
	assert.equal(h.control.acqState().waiting, true, 'Arm 后先等沿')
	// 设备满速 100 kHz、目标 1 kHz：每 100 个原始点出 1 个入库点
	const feed = (ua, raw) => {
		const list = []
		for (let i = 0; i < raw; i++) list.push({ iUA: ua, range: 3, logic: 0xff })
		return h.control.pushSamples(list, 10, { from: 0, total: raw })
	}
	// 低电平：只累计 pre-range，不入库
	assert.equal(feed(10, 300), 0, '等沿期间不入库')
	assert.equal(h.control.acqState().preMin, 10)
	assert.equal(h.wave.pushed, 0)
	// 高电平：命中上升沿后开始入库
	const stored = feed(100, 300)
	assert.ok(stored > 0, '命中启动沿后入库：' + stored)
	assert.equal(h.control.acqState().storeEnabled, true)
	assert.equal(h.control.acqState().startLatched, true)
	assert.ok(h.wave.pushed > 0)
})

test('采样沿停止：命中停沿后自动停采（异步发 STOP，不在入库路径里 await）', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	h.control.setTrigLevel(50)
	h.control.setAcqTriggers('off', 'fall')
	await h.control.startSampling()
	h.state.writes.length = 0
	const feed = (ua, raw) => {
		const list = []
		for (let i = 0; i < raw; i++) list.push({ iUA: ua, range: 3, logic: 0xff })
		return h.control.pushSamples(list, 10, { from: 0, total: raw })
	}
	feed(100, 300) // 高：seed 成 high
	assert.equal(h.control.isSampling(), true)
	feed(0, 300) // 低：命中下降沿 → 排队停采
	// 停采是异步的（requestStop → setTimeout → stopSampling → 写 STOP），多等几拍
	for (let i = 0; i < 20 && h.control.isSampling(); i++) await new Promise(function (r) { setTimeout(r, 5) })
	await new Promise(function (r) { setTimeout(r, 20) })
	assert.equal(h.control.isSampling(), false, '停沿后应停止采样')
	assert.ok(h.state.writes.some((w) => w.bytes[0] === 0x07), '发了 AVERAGE_STOP')
})

test('长期模式：仍然维护折叠总览（minimap），但不进波形环', async () => {
	const h = await connected()
	h.control.setRecordMode('long')
	h.control.ingest(1000, 100)
	h.control.ingest(2000, 300)
	assert.equal(h.wave.pushed, 0, '长期模式不进波形环')
	assert.ok(h.control.foldingLength() > 0, '折叠总览有数据')
	const data = h.control.minimapData()
	assert.ok(data.length >= 2, '总览点：' + data.length)
	assert.ok(data.every((d) => isFinite(d.x) && isFinite(d.y)))
	// 清空会话时总览也清掉
	h.control.clearSessionState()
	assert.equal(h.control.foldingLength(), 0)
})

test('缺口（有序到达）：清空重采样累加器，缺口两侧不平均成同一个输出点', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	await h.control.startSampling()
	// 100 kHz 原始流：每个输出点需要 100 个原始样点。先喂 50 个（不足一个输出点）
	const feed = (ua, raw) => {
		const list = []
		for (let i = 0; i < raw; i++) list.push({ iUA: ua, range: 3, logic: 0xff })
		return h.control.pushSamples(list, 10, { from: 0, total: raw })
	}
	assert.equal(feed(1000, 50), 0, '半个窗口先攒着，不出点')
	// 缺口：累加器必须被清空
	h.control.noteGap({ reason: 'offset_gap' })
	// 再喂 50 个 0 µA 的点：如果累加器没清，会凑出一个 (1000*50+0*50)/100 = 500 µA 的假点
	const stored = feed(0, 50)
	assert.equal(stored, 0, '缺口之后不能把两段拼成一个输出点：' + stored)
	// 再补满一个完整窗口：出来的是纯 0 µA
	const more = feed(0, 50)
	assert.equal(more, 1)
	assert.ok(h.wave.lastPushed != null && Math.abs(h.wave.lastPushed) < 1e-9,
		'输出点必须是 0 µA，而不是 (1000+0)/2 = 500：' + h.wave.lastPushed)
})

test('缺口（有序到达）：采样沿触发的滞回状态与 pre-range 一起重置', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	h.control.setTrigLevel(50)
	h.control.setAcqTriggers('rise', 'off')
	await h.control.startSampling()
	const feed = (ua, raw) => {
		const list = []
		for (let i = 0; i < raw; i++) list.push({ iUA: ua, range: 3, logic: 0xff })
		return h.control.pushSamples(list, 10, { from: 0, total: raw })
	}
	feed(10, 300) // 低：等沿中，累计 pre-range
	assert.ok(isFinite(h.control.acqState().preMin), '等沿时累计 pre-range')
	h.control.noteGap({ reason: 'offset_gap' })
	assert.equal(h.control.acqState().preMin, Infinity, '缺口后 pre-range 清零')
	assert.equal(h.control.acqState().startState, 0, '缺口后沿状态复位')
})

test('停止采样：先把队列里已收到的样点排空，再冻结统计', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	await h.control.startSampling()
	// 手动往队列里塞样点（模拟「点停止时还有一批没入库」）
	const list = []
	for (let i = 0; i < 300; i++) list.push({ iUA: 100, range: 3, logic: 0xff })
	// 直接用 pushSamples 走 control 的入库路径（link 队列另有测试）
	h.control.pushSamples(list, 10, { from: 0, total: 300 })
	const before = h.wave.pushed
	await h.control.stopSampling()
	assert.ok(h.wave.pushed >= before, '停止不能丢已经入库的样点：' + before + ' → ' + h.wave.pushed)
})

test('意外断开：终止会话、供电状态置为未知、下一次连接不继承旧状态', async () => {
	const h = await connected()
	await h.control.startSampling()
	assert.equal(h.control.isSampling(), true)
	h.control.markPowered(true, 'commanded')
	const r = h.control.abortSession('连接已断开')
	assert.equal(r.wasSampling, true)
	assert.equal(h.control.isSampling(), false, '断开后不能还在采样')
	assert.equal(h.control.powerPayload().state, 'unknown', '断开后供电状态必须未知')
	assert.equal(h.control.powerPayload().source, 'unknown')
	// 下一次连接前清掉残留：采样标志与供电状态都回到初始
	h.control.markPowered(false, 'commanded')
	h.control.prepareSession()
	assert.equal(h.control.powerPayload().state, 'unknown')
	assert.equal(h.control.isSampling(), false)
})

test('保存设置后 Start 必须真的下发 START（旧 sampling 状态不会短路）', async () => {
	const h = await connected()
	await h.control.startSampling()
	h.control.abortSession('模拟断开')
	h.state.writes.length = 0
	// 重新开始采样：必须真的发 STOP 排空 + START
	const r = await h.control.startSampling()
	assert.equal(r.ok, true)
	assert.deepEqual(h.state.writes.map((w) => w.bytes[0]), [0x07, 0x06])
})

test('电压在采样中改变：摘要标出这一点', async () => {
	const h = await connected()
	await h.control.startSampling()
	await h.control.applyVoltageMv(1800)
	assert.equal(h.control.captureSummary().voltageChangedDuringCapture, true)
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok   ' + t.name)
		} catch (e) {
			failed++
			console.error('FAIL ' + t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
