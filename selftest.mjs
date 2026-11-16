#!/usr/bin/env node
/**
 * 自检：不经过 DSH 宿主，直接跑 core 引擎。
 *   node selftest.mjs            # 信息 + 1 张最小图（约 0.009 credits）
 *   node selftest.mjs --info     # 只查信息（不花钱）
 *   node selftest.mjs --multi    # 信息 + 2 条不同提示词（验证多提示词链路，约 0.018 credits）
 */
import { runGenerate, runInfo } from './lib/core.js'

const infoOnly = process.argv.includes('--info')
const multi = process.argv.includes('--multi')

const info = await runInfo({})
console.log('=== image_gen_info ===')
console.log(info.message)

if (!infoOnly) {
  console.log('\n=== generate_image（最小成本验证）===')
  const out = multi
    ? await runGenerate(
        {
          prompts: [
            'a single red apple on a clean white background, soft studio light, photorealistic product photo',
            'the same apple drawn as a flat vector icon, two colors, white background',
          ],
          aspect_ratio: '1:1',
          size_tier: '1k',
          quality: 'low',
          output_format: 'jpeg',
          filename_hint: 'selftest-multi',
        },
        { cwd: process.cwd() },
      )
    : await runGenerate(
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
  console.log('markdown:\n' + out.markdown)
  for (const file of out.files ?? []) {
    console.log('- ' + file.path + ' | ' + (file.width ?? 0) + '×' + (file.height ?? 0) + ' | ' + String(file.prompt).slice(0, 40))
  }
  if (!out.files?.length) throw new Error('没有产出文件')
  if (multi && out.files.length !== 2) throw new Error('多提示词没有出 2 张')
}
