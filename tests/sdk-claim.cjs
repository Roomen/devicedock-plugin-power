'use strict'
// 宿主 SDK（sdk/devicedock-plugin.js，与宿主仓库同一份）的 claim 通道契约回归：
//  - 同一 claim 的批次串行交给回调（含回调返回的 Promise），不同 claim 互不阻塞
//  - 每批结束后按序 claim.ack，且是**即发即忘**的 post（不登记 pending、没有超时）
//  - 回调抛错 / Promise 拒绝仍然 ack，并把错误交给 setClaimErrorHandler
//  - claim.gap 透出 { claimId, gen, offset, bytes, reason }，未知 reason 原样透出
// 只在这份 SDK 上做断言：插件自己的解析/缺口逻辑在 power-claim.cjs 里另测。
const assert = require('node:assert/strict')

// ---- 假宿主：捕获 SDK 发出的所有 postMessage 信封 ----
const sent = []
globalThis.__DEVICEDOCK_HOST_TARGET__ = {
	postMessage(envelope) { sent.push(envelope) },
}
const sdk = require('../sdk/devicedock-plugin.js')

function deliver(event, payload) {
	sdk._handleMessage({ data: { __devicedock: sdk.PROTOCOL, event: event, payload: payload } })
}
function acks() {
	return sent.filter((e) => e.method === 'claim.ack').map((e) => Object.assign({ id: e.id }, e.params))
}
function batch(claimId, gen, seq, offset, n) {
	return { claimId: claimId, gen: gen, seq: seq, offset: offset, at: 1000 + seq, bytes: new Uint8Array(n) }
}
const flush = () => new Promise((r) => setImmediate(r))
const flushAll = async () => { for (let i = 0; i < 12; i++) await flush() }

// on() 是全局监听表：每个用例结束时退订，避免上一段的回调收到下一段的事件
let subs = []
function onRx(fn) { const off = sdk.claim.onRx(fn); subs.push(off); return off }
function onGap(fn) { const off = sdk.claim.onGap(fn); subs.push(off); return off }
function reset() {
	subs.forEach(function (off) { off() })
	subs = []
	sdk.setClaimErrorHandler(null)
	sent.length = 0
}

;(async function () {
	// ---- 1. 同一 claim 串行：异步回调也会按序完成，ack 随之按序 ----
	{
		reset()
		const order = []
		let releaseFirst = null
		onRx(function (ev) {
			order.push('start:' + ev.seq)
			if (ev.seq === 1) {
				// 第一批故意挂住：后面的批次必须等它
				return new Promise(function (resolve) {
					releaseFirst = function () {
						order.push('end:1')
						resolve()
					}
				})
			}
			order.push('end:' + ev.seq)
			return undefined
		})
		deliver('claim.rx', batch('c1', 1, 1, 0, 16))
		deliver('claim.rx', batch('c1', 1, 2, 16, 16))
		deliver('claim.rx', batch('c1', 1, 3, 32, 16))
		await flushAll()
		assert.deepEqual(order, ['start:1'], '第一批没结束前不能开始第二批：' + JSON.stringify(order))
		assert.equal(acks().length, 0, '第一批还没 ack')
		releaseFirst()
		await flushAll()
		assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'], '串行且保序：' + JSON.stringify(order))
		assert.deepEqual(acks().map((a) => a.seq), [1, 2, 3], 'ack 按序覆盖完成的连续批次')
	}

	// ---- 2. ack 是即发即忘的 post：没有 pending、没有超时 ----
	{
		reset()
		onRx(function () { /* 同步返回 */ })
		deliver('claim.rx', batch('c2', 2, 1, 0, 8))
		await flushAll()
		const a = acks()
		assert.equal(a.length, 1)
		assert.equal(a[0].claimId, 'c2')
		assert.equal(a[0].gen, 2)
		assert.equal(a[0].seq, 1)
		assert.match(String(a[0].id), /^post-/, 'ack 用 post（即发即忘）而不是 call：' + a[0].id)
		assert.equal(sdk._pendingCount(), 0, '不能为 ack 登记 pending Promise')
		// 公开的 claim.ack 也是 post，返回 undefined
		const ret = sdk.claim.ack('c2', 2, 1)
		assert.equal(ret, undefined, 'claim.ack 返回 undefined（不回包）')
		assert.equal(sdk._pendingCount(), 0)
		assert.match(String(sent[sent.length - 1].id), /^post-/)
	}

	// ---- 3. 回调抛错：仍然 ack，并交给 setClaimErrorHandler ----
	{
		reset()
		const errors = []
		sdk.setClaimErrorHandler(function (err, info) { errors.push({ msg: err && err.message, info: info }) })
		onRx(function () { throw new Error('synthetic handler failure') })
		deliver('claim.rx', batch('c3', 1, 7, 64, 4))
		await flushAll()
		assert.equal(acks().length, 1, '抛错也要 ack（否则宿主卡在背压里）')
		assert.equal(acks()[0].seq, 7)
		assert.equal(errors.length, 1, '错误交给处理器')
		assert.equal(errors[0].msg, 'synthetic handler failure')
		assert.equal(errors[0].info.claimId, 'c3')
		assert.equal(errors[0].info.gen, 1)
		assert.equal(errors[0].info.seq, 7)
		// 处理器自己抛错不能把队列搞坏（SDK 会退回 console.error，这里临时静音）
		const realError = console.error
		const logged = []
		console.error = function () { logged.push(Array.prototype.slice.call(arguments).join(' ')) }
		sdk.setClaimErrorHandler(function () { throw new Error('handler itself throws') })
		deliver('claim.rx', batch('c3', 1, 8, 68, 4))
		await flushAll()
		console.error = realError
		assert.equal(acks().length, 2, '处理器抛错也要继续 ack')
		// 处理器抛出的异常被 SDK 吞掉，退回 console.error 报的是「回调失败」这条
		assert.ok(logged.some((l) => /claim\.rx handler failed/.test(l)), '处理器抛错时退回 console.error：' + JSON.stringify(logged))
	}

	// ---- 4. 回调返回被拒绝的 Promise：同样 ack + 报错 ----
	{
		reset()
		const errors = []
		sdk.setClaimErrorHandler(function (err) { errors.push(err && err.message) })
		onRx(function () { return Promise.reject(new Error('async rejection')) })
		deliver('claim.rx', batch('c4', 1, 1, 0, 4))
		await flushAll()
		assert.equal(acks().length, 1)
		assert.deepEqual(errors, ['async rejection'])
	}

	// ---- 5. 不同 claim 互不阻塞 ----
	{
		reset()
		const order = []
		let releaseA = null
		onRx(function (ev) {
			order.push(ev.claimId + ':' + ev.seq)
			if (ev.claimId === 'a' && ev.seq === 1) {
				return new Promise(function (resolve) { releaseA = resolve })
			}
			return undefined
		})
		deliver('claim.rx', batch('a', 1, 1, 0, 4))
		deliver('claim.rx', batch('b', 1, 1, 0, 4))
		deliver('claim.rx', batch('a', 1, 2, 4, 4))
		await flushAll()
		assert.deepEqual(order, ['a:1', 'b:1'], 'b 不被 a 的挂起批次挡住：' + JSON.stringify(order))
		assert.deepEqual(acks().map((x) => x.claimId + ':' + x.seq), ['b:1'])
		releaseA()
		await flushAll()
		assert.deepEqual(order, ['a:1', 'b:1', 'a:2'])
		assert.deepEqual(acks().map((x) => x.claimId + ':' + x.seq), ['b:1', 'a:1', 'a:2'])
	}

	// ---- 6. claim.gap 透出形状 ----
	{
		reset()
		const gaps = []
		onGap(function (g) { gaps.push(g) })
		deliver('claim.gap', { claimId: 'c5', gen: 3, offset: 4096, bytes: 512, reason: 'overflow' })
		deliver('claim.gap', { claimId: 'c5', gen: 3, offset: 4608, bytes: 16, reason: 'closing' })
		deliver('claim.gap', { claimId: 'c5', gen: 3, offset: 4624, bytes: 8, reason: 'something-new' })
		assert.equal(gaps.length, 3)
		assert.deepEqual(gaps[0], { claimId: 'c5', gen: 3, offset: 4096, bytes: 512, reason: 'overflow' })
		assert.equal(gaps[1].reason, 'closing')
		// 未知 reason 原样透出：插件不能把它谎报成 overflow
		assert.equal(gaps[2].reason, 'something-new')
		// 缺字段也不能崩
		deliver('claim.gap', {})
		assert.equal(gaps.length, 4)
		assert.equal(gaps[3].bytes, 0)
	}

	// ---- 7. bytes 统一成 Uint8Array 视图（数组 / typed array / 缺失）----
	{
		reset()
		const got = []
		onRx(function (ev) { got.push(ev.bytes) })
		deliver('claim.rx', { claimId: 'c6', gen: 1, seq: 1, offset: 0, at: 1, bytes: [1, 2, 3] })
		deliver('claim.rx', { claimId: 'c6', gen: 1, seq: 2, offset: 3, at: 2, bytes: new Uint8Array([4, 5]) })
		deliver('claim.rx', { claimId: 'c6', gen: 1, seq: 3, offset: 5, at: 3 })
		await flushAll()
		assert.equal(got.length, 3)
		assert.ok(got[0] instanceof Uint8Array && got[0].length === 3)
		assert.deepEqual(Array.from(got[1]), [4, 5])
		assert.equal(got[2].length, 0, '缺 bytes 时给空视图而不是 undefined')
		// 没有 claimId 的批次直接丢掉（不属于任何声明）
		deliver('claim.rx', { gen: 1, seq: 9, offset: 0, bytes: [1] })
		await flushAll()
		assert.equal(got.length, 3, '无 claimId 的批次不投递')
	}

	// ---- 8. 队列排空后清掉（不泄漏 Map 条目）----
	{
		reset()
		onRx(function () { return undefined })
		deliver('claim.rx', batch('c7', 1, 1, 0, 4))
		await flushAll()
		assert.equal(await sdk._claimQueueDone('c7'), undefined, '队列已完成')
		assert.equal(await sdk._claimQueueDone('never-used'), undefined, '未用过的 claim 直接返回')
	}

	console.log('sdk-claim: ok')
})().catch(function (e) {
	console.error(e)
	process.exit(1)
})
