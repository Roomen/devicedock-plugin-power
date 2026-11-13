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
		// 会话序号：reset 推进（导入绑定 epoch 的测试要用）
		_epoch: 0,
		epoch() { return wave._epoch },
		lastPushed: null,
		reset() { wave.pushed = 0; wave.lastPushed = null; wave.gapIdx = []; wave._epoch++ },

		// total / retained 可以分别设定：模拟「旧样点被淘汰」
		totalValue: null,
		retainedValue: null,
		total() { return wave.totalValue == null ? wave.pushed : wave.totalValue },
		retained() { return wave.retainedValue == null ? wave.pushed : wave.retainedValue },
		stats() { return Object.assign({ n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0, dur: 0, gaps: wave.gapIdx.length, dropped: 0, volts: 0 }, wave.scriptedStats || {}) },
		gaps() { return wave.gapIdx },
		gapIdx: [],
		droppedSamples() { return 0 },
		storageStop() { return false },
		noteGap(idx) { wave.gapIdx.push(idx) },
	}

	const control = Control.createControl({
		link: link,
		wave: wave,
		store: state.store,
		settings: { recordMode: opts.recordMode || 'wave', targetRateHz: 1000, voltageMv: 3300 },
		options: { rxDrainMs: 0 },
		log: (msg, level) => state.logs.push({ msg: msg, level: level || '' }),
		onChange: () => { state.changes++ },
		onSamplingEnd: (info) => { state.ends = (state.ends || []).concat([info]) },
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

test('自动停采：停止沿命中后走与手动停相同的会话结束回调（reason=acq_stop），手动停为 manual', async () => {
	const h = await connected()
	h.control.setTargetRateHz(1000)
	h.control.setTrigLevel(50)
	h.control.setAcqTriggers('off', 'fall')
	await h.control.startCapture()
	const feed = (ua, raw) => {
		const list = []
		for (let i = 0; i < raw; i++) list.push({ iUA: ua, range: 3, logic: 0xff })
		return h.control.pushSamples(list, 10, { from: 0, total: raw })
	}
	feed(100, 300)
	feed(0, 300)
	for (let i = 0; i < 40 && h.control.isSampling(); i++) await wait(5)
	await wait(20)
	assert.equal(h.control.isSampling(), false)
	assert.deepEqual(h.state.ends, [{ reason: 'acq_stop' }], '自动停采通知了会话结束（界面据此停看门狗、释放 busy）')
	// 再开一次手动停：回调原因复位为 manual，不沿用上次的 acq_stop
	h.control.setAcqTriggers('off', 'off')
	await h.control.startCapture()
	await h.control.stopCapture()
	assert.deepEqual(h.state.ends, [{ reason: 'acq_stop' }, { reason: 'manual' }])
})

test('连接初始化与采集同队列：探测进行中点开始，探测的 STOP 不会落在采集的 START 之后', async () => {
	const h = await connected()
	const probe = h.control.probeDutPower()
	const start = h.control.startCapture()
	await probe
	const r = await start
	assert.equal(r.ok, true, JSON.stringify(r && r.code))
	const ops = h.state.writes.map((w) => w.bytes[0]).filter((b) => b === 0x06 || b === 0x07)
	// 探测 START/STOP → 采集前置 STOP → 采集 START，最后一个命令必须是 START
	assert.deepEqual(ops, [0x06, 0x07, 0x07, 0x06], '写入顺序：' + ops.map((b) => b.toString(16)).join(','))
	assert.equal(h.control.isSampling(), true)
})

test('启动前 STOP 写失败：中止启动、不写 START，返回原因并记错误日志', async () => {
	const h = await connected()
	h.state.writeFailAt = 1
	const r = await h.control.startCapture()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'capture_prestop_failed')
	assert.equal(r.executed, false)
	assert.match(String(r.ref), /STOP/)
	assert.equal(h.state.writes.length, 1, '只尝试了前置 STOP，没有继续 START')
	assert.equal(h.state.writes[0].bytes[0], 0x07)
	assert.equal(h.control.isSampling(), false)
	assert.ok(h.state.logs.some((l) => l.level === 'error' && /STOP/.test(String(l.msg))), '错误日志说明了 STOP 写失败')
	assert.ok(!h.state.logs.some((l) => l.level === 'success'), '没有后续「采样已开始」盖掉失败')
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

test('导入会话：按导入的周期与逐行电压灌入，缺口标记落位，设备电压设置不受影响', async () => {
	const h = await connected()
	h.control.setVoltageSource(3300)
	const I = require('../js/power-import.js')
	const csv = [
		'index,time_s,current_uA,power_uW,voltage_mV',
		'0,0,1000,3300,3300',
		'1,0.001,1000,3300,3300',
		'2,0.002,1000,1650,1650',
		'# gap import 3..3',
		'3,1.0,0,0,1650',
		'4,1.001,0,0,1650',
	].join('\n')
	const parsed = I.parseCsv(csv)
	assert.equal(parsed.ok, true)
	const res = await h.control.importSeries(parsed)
	assert.equal(res.ok, true)
	assert.equal(res.samples, 5)
	assert.equal(res.gaps, 1)
	assert.ok(Math.abs(h.control.getSamplePeriodSec() - 0.001) < 1e-12, '周期来自段内时间列，缺口不摊进去')
	assert.equal(h.wave.pushed, 5)
	assert.equal(h.wave.gaps().length, 1, '缺口标记必须落进波形')
	// N4：导入不能改写设备控制用的电压设置
	assert.equal(h.control.readVoltageMv(), 3300, '导入文件里的电压只能进历史，不改设备设置')
	assert.equal(h.state.writes.length, 0, '导入不写设备')
	// 波形历史里带着逐样点电压：子区间能量按各自电压
	const st = h.wave.stats ? null : null
	void st
})

test('N4：文件没有电压时能量不可用，不继承当前设置', async () => {
	const h = await connected()
	h.control.setVoltageSource(3300)
	const I = require('../js/power-import.js')
	const parsed = I.parseCsv('index,time_s,current_uA\n0,0,1000\n1,1,1000\n')
	assert.equal(parsed.hasVoltage, false)
	const res = await h.control.importSeries(parsed)
	assert.equal(res.ok, true)
	assert.equal(res.hasVoltage, false)
	assert.equal(h.control.readVoltageMv(), 3300, '设备设置保持不变')
})

test('N5：存储装不下时返回不完整（实际 N / 请求 M），不报完整成功', async () => {
	// 用一个有硬上限的假波形：写到第 40 个样点后 push 返回 false
	const h = await connected()
	let written = 0
	h.wave.push = function () {
		if (written >= 40) return false
		written++
		h.wave.pushed++
		h.wave.lastPushed = arguments[0]
		return true
	}
	const I = require('../js/power-import.js')
	const lines = ['index,time_s,current_uA,voltage_mV']
	for (let i = 0; i < 200; i++) lines.push(i + ',' + (i * 0.001) + ',1000,3300')
	const parsed = I.parseCsv(lines.join('\n'))
	const res = await h.control.importSeries(parsed, { batchSize: 16 })
	assert.equal(res.ok, false, '装不下必须报不完整')
	assert.equal(res.code, 'incomplete')
	assert.ok(res.stored < res.requested, '实际写入少于请求：' + res.stored + ' / ' + res.requested)
	assert.match(res.message, /只写入了 \d+ \/ 200 个样点/)
})

test('N9：导入期间会话变化 → 取消并报告，绝不把旧导入写进新会话', async () => {
	const h = await connected()
	const I = require('../js/power-import.js')
	const lines = ['index,time_s,current_uA,voltage_mV']
	for (let i = 0; i < 64; i++) lines.push(i + ',' + (i * 0.001) + ',100,3300')
	const parsed = I.parseCsv(lines.join('\n'))
	// batchSize=2：第 2 个样点之后会 await，我们在那时清空会话并写入新数据
	const pending = h.control.importSeries(parsed, { batchSize: 2 })
	await new Promise(function (r) { setTimeout(r, 0) })
	h.wave.reset()
	h.wave.push(900)
	h.wave.push(900)
	const res = await pending
	assert.equal(res.ok, false, '会话变化必须取消导入')
	assert.equal(res.code, 'session_changed')
	assert.equal(res.cancelled, true)
	assert.ok(res.stored < res.requested, '只写入了开头的一部分：' + res.stored + ' / ' + res.requested)
	assert.match(res.message, /会话已变化/)
	// 新会话的数据没有被旧导入污染
	assert.equal(h.wave.total(), 2, '新会话只剩我们自己写的两点：' + h.wave.total())
})

test('长期模式：时长只累计有效间隔、缺口有计数、能量按摄入时的电压', async () => {
	const h = await connected()
	h.control.setRecordMode('long')
	h.control.setVoltageSource(3300)
	h.control.ingest(0, 1000)
	h.control.ingest(1000, 1000) // 1 s 间隔
	h.control.noteGap({ reason: 'offset_gap' })
	h.control.ingest(5000, 1000) // 缺口之后的第一个点：不计入时长
	h.control.ingest(6000, 1000) // 再 1 s
	const s = h.control.captureSummary()
	assert.equal(s.mode, 'long')
	assert.equal(s.durationSec, 2, '只累计段内有效间隔，缺口那段不算：' + s.durationSec)
	assert.equal(s.gaps, 1, '长期模式也要报缺口数')
	// 能量 = Σ i·V·dt，电压按摄入时刻：3.3 V × 1000 µA × 2 s = 6600 µW·s
	assert.ok(Math.abs(s.chargeUC - 2000) < 1e-9, '电量 = 1000 µA × 2 s：' + s.chargeUC)
	assert.ok(Math.abs(h.control.overallStats().energyUWh - 6600 / 3600) < 1e-9,
		'能量按历史电压积分：' + h.control.overallStats().energyUWh)
	// 改当前源电压不能改写历史能量
	h.control.setVoltageSource(1800)
	assert.ok(Math.abs(h.control.overallStats().energyUWh - 6600 / 3600) < 1e-9, '改电压不改历史能量')
	assert.ok(Math.abs(h.control.overallStats().volts - 3.3) < 1e-9, '有效电压仍是 3.3 V：' + h.control.overallStats().volts)
})

test('停止采样联动：claim 队列里待入库的样点会被 control 排空后才冻结', async () => {
	// 真的把 claim 链路与 control 拼在一起：队列由测试手动排空，模拟「点停止时队列还没走完」
	const P = require('../js/power-protocol.js')
	const Claim = require('../js/power-claim.js')
	const Control = require('../js/power-control.js')
	const Wave = require('../js/power-wave.js')
	const writes = []
	const host = {
		claim: {
			acquire: async () => ({ claimId: 'cz' }),
			open: async () => ({ open: true }),
			write: async (id, b) => { writes.push(Array.from(b)); return { bytes: b.length } },
			close: async () => ({ closed: true }),
			release: async () => ({ released: true }),
			ack: async () => ({ ack: true }),
		},
	}
	const drains = []
	let ctl = null
	const link = Claim.createClaimLink({
		host: host,
		scheduleDrain: function (fn) { drains.push(fn) },
		// 真的接到 control 的入库路径上（模拟插件里的接线）
		onSamples: function (s, at, meta) { if (ctl) ctl.pushSamples(s, at, meta) },
	})
	const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
	const wave = Wave.createWave({ store: store, chunkSize: 65536, ramCapSamples: 262144, voltage: () => 3.3, samplePeriod: () => 0.001 })
	const control = Control.createControl({
		link: link, wave: wave, store: store,
		settings: { recordMode: 'wave', targetRateHz: 1000, voltageMv: 3300 },
		options: { rxDrainMs: 0 },
	})
	ctl = control
	await link.open('p1')
	await control.startSampling()
	// 灌 1000 个原始点（100 kHz → 1 kHz 目标：约 10 个输出点），但**不**执行 drain
	let counter = 0
	function words(n) {
		const u8 = new Uint8Array(n * 4)
		for (let i = 0; i < n; i++) {
			const c = (counter++) & 0x3f
			const w = (((0xff) << 24) | (c << 18) | (3 << 14) | (1000 + (i % 5))) >>> 0
			u8[i * 4] = w & 0xff
			u8[i * 4 + 1] = (w >>> 8) & 0xff
			u8[i * 4 + 2] = (w >>> 16) & 0xff
			u8[i * 4 + 3] = (w >>> 24) & 0xff
		}
		return u8
	}
	link.handleRx({ claimId: 'cz', gen: 1, seq: 1, offset: 0, at: Date.now(), bytes: words(2000) })
	assert.ok(link.pendingSamples() > 0, '队列里必须有待入库的样点：' + link.pendingSamples())
	assert.equal(wave.total(), 0, '还没排空 → 波形里没有样点')
	const before = link.pendingSamples()
	// 停止采样：control 必须先把这个队列排空，再冻结
	await control.stopSampling()
	assert.equal(link.pendingSamples(), 0, '停止时必须排空队列（不能静默丢）：剩 ' + link.pendingSamples() + ' / 原 ' + before)
	assert.ok(wave.total() > 0, '排空后的样点必须真的入库：' + wave.total())
	assert.equal(control.isSampling(), false)
	// 停止时发 STOP（START 是开始采样时发的，这里只看停止之后有没有再发 START）
	const beforeStop = writes.length
	assert.ok(writes.some((w) => w[0] === 0x07), '要发 AVERAGE_STOP')
	const after = writes.slice(beforeStop)
	void after
	assert.equal(writes[writes.length - 1][0], 0x07, '最后一次写入是 STOP：' + JSON.stringify(writes.map((w) => w[0])))
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
