#!/usr/bin/env node
/**
 * 自检：不经过 DSH 宿主，直接跑 core 引擎。
 *   node selftest.mjs            # 信息 + 1 张最小图
 *   node selftest.mjs --info     # 只查信息（不花钱）
 */
import { runGenerate, runInfo } from './lib/core.js'

const infoOnly = process.argv.includes('--info')

const info = await runInfo({})
console.log('=== image_gen_info ===')
console.log(info.message)

if (!infoOnly) {
  console.log('\n=== generate_image（最小成本验证）===')
  const out = await runGenerate(
    {
      prompt: 'a single red apple on a clean white background, soft studio light, photorealistic product photo',
      aspect_ratio: '1:1',
      size_tier: '1k',
      quality: 'low',
      output_format: 'jpeg',
      filename_hint: 'selftest-apple',
    },
    { cwd: process.cwd() },
  )
  console.log(out.message)
  console.log('markdown:', out.markdown)
  if (!out.files?.length) throw new Error('没有产出文件')
}
