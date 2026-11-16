import { createHash } from 'node:crypto'
import { apply } from '../index.js'

const registered = {}
const ctx = {
  tools: { register: (def) => { registered[def.name] = def } },
  attachments: {
    saveImage: async ({ data, mediaType, name }) => ({
      attachmentId: 'att_' + createHash('sha256').update(Buffer.from(data)).digest('hex').slice(0, 16),
      mediaType,
      bytes: data.length,
      width: 1254,
      height: 1254,
      name,
    }),
  },
}
apply(ctx, {})

const def = registered.generate_image
const out = await def.execute(
  { prompt: '一只白色搪瓷杯放在木桌上，侧逆光，产品摄影', quality: 'low', filename_hint: 'host-smoke' },
  { agent: { session: { cwd: process.cwd() } } },
)
console.log(JSON.stringify({ ok: out.ok, files: (out.files || []).map((f) => ({ path: f.path, attachment: f.attachment && f.attachment.attachmentId, mediaType: f.attachment && f.attachment.mediaType })) }, null, 2))
const meta = def.output.presentationMeta({}, out)
console.log('meta.images:', JSON.stringify(meta.images))
