#!/usr/bin/env node
/**
 * 离线测试：把 fetch 换成本地桩，验证 0.3.0 的几条行为，不花钱、不联网。
 *   node test/offline.mjs
 *
 * 覆盖：
 *  - prompts 多提示词 → 多次请求、文件数、每张的 prompt 元数据
 *  - 同名不覆盖（同秒同 prompt 两次调用拿到不同文件）
 *  - sidecar .json 与 index.jsonl 账本
 *  - 单张下载失败重试一次
 *  - sniffFormat 判格式
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AIPAIS_KEY = 'test-key'

const { runGenerate, sniffFormat } = await import('../lib/core.js')

// 1x1 透明 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let calls = []
let failNext = 0

globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  calls.push(href)
  if (href.endsWith('/balance')) {
    return new Response(JSON.stringify({ balance: 12.5 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (href.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-image-2.6-exact', enabled_size_tiers: ['1k', '2k', '4k'] }] }), { status: 200 })
  }
  if (href.endsWith('/images/generations') || href.endsWith('/images/edits')) {
    const body = JSON.parse(init.body ?? '{}')
    const n = Number(body.n) || 1
    return new Response(JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })) }), { status: 200 })
  }
  if (failNext > 0) {
    failNext--
    return new Response('nope', { status: 500 })
  }
  return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 })
}

const cwd = mkdtempSync(join(tmpdir(), 'aipais-test-'))
const assert = (ok, message) => {
  if (!ok) throw new Error('断言失败：' + message)
  console.log('  ✓ ' + message)
}

try {
  console.log('多提示词 → 多次请求 + 逐张 prompt')
  const multi = await runGenerate(
    { prompts: ['一只红苹果', '一只绿苹果', '一只黄苹果'], quality: 'low', output_format: 'png', filename_hint: 'apple' },
    { cwd },
  )
  assert(multi.files.length === 3, '出 3 张')
  assert(new Set(multi.files.map((f) => f.absolute_path)).size === 3, '三个不同文件')
  assert(multi.files.every((f) => typeof f.prompt === 'string' && f.prompt.length > 0), '每张带回自己的 prompt')
  assert(multi.files.map((f) => f.prompt).join('|') === '一只红苹果|一只绿苹果|一只黄苹果', 'prompt 与文件顺序一致')
  assert(calls.filter((u) => u.endsWith('/images/generations')).length === 3, '发了 3 次生成请求')

  console.log('同秒同 prompt 两次调用不覆盖')
  const a = await runGenerate({ prompt: '同一只猫', quality: 'low', filename_hint: 'cat' }, { cwd })
  const b = await runGenerate({ prompt: '同一只猫', quality: 'low', filename_hint: 'cat' }, { cwd })
  assert(a.files[0].absolute_path !== b.files[0].absolute_path, '文件名不撞车')
  assert(existsSync(a.files[0].absolute_path) && existsSync(b.files[0].absolute_path), '两张都还在磁盘上')

  console.log('元数据与账本')
  const sidecar = a.files[0].absolute_path.replace(/\.[a-z0-9]+$/i, '.json')
  assert(existsSync(sidecar), 'sidecar 存在')
  const record = JSON.parse(readFileSync(sidecar, 'utf8'))
  assert(record.prompt === '同一只猫', 'sidecar 记下了 prompt')
  assert(record.model === 'gpt-image-2.6-exact', 'sidecar 记下了模型')
  assert(record.plugin.startsWith('dsh-aipais-image@'), 'sidecar 记下了插件版本')
  const indexLines = readFileSync(join(cwd, 'generate/images/index.jsonl'), 'utf8').trim().split('\n')
  assert(indexLines.length === 5, '账本累计 5 行（3 + 1 + 1）')
  assert(JSON.parse(indexLines[0]).file.length > 0, '账本行带 file 字段')

  console.log('单张下载失败重试一次')
  failNext = 1
  const retried = await runGenerate({ prompt: '下载会失败一次', quality: 'low', filename_hint: 'retry' }, { cwd })
  assert(retried.files.length === 1, '重试后拿到图')

  console.log('格式识别')
  assert(sniffFormat(Buffer.from(PNG_B64, 'base64')) === 'png', 'PNG 魔数')
  assert(sniffFormat(Buffer.from('GIF89a.......', 'latin1')) === 'gif', 'GIF 魔数')

  console.log('\n通过')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
