import { describe, expect, it } from 'vitest'
import { writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createModelScorer, toScoreSet } from '../src/core/analysis/models.ts'
import { buildVlmPrompt, parseVlmResponse } from '../src/core/analysis/vlm.ts'
import { freshDir, renderScene } from './helpers/fixtures.ts'

describe('specialised model adapters', () => {
  it('command adapter passes image paths and maps JSON lines', async () => {
    const dir = await freshDir('model-cmd')
    const img = join(dir, 'a.jpg')
    await renderScene({ sky: ['#123', '#9ab'], ground: '#333', seed: 3 }, img)
    const script = join(dir, 'fake-model.mjs')
    await writeFile(script, `#!/usr/bin/env node
for (const p of process.argv.slice(2)) console.log(JSON.stringify({ path: p, score: 7.2, tags: ['landscape'] }))
`)
    await chmod(script, 0o755)
    const scorer = createModelScorer({ id: 'nima', type: 'command', command: process.execPath, args: [script, '{paths}'] })
    const [s] = await scorer.score([img])
    expect(s?.aesthetic).toBeCloseTo(72, 5)
    expect(s?.tags).toEqual(['landscape'])
  })

  it('http adapter posts base64 images and reads results', async () => {
    const dir = await freshDir('model-http')
    const img = join(dir, 'a.jpg')
    await renderScene({ sky: ['#123', '#9ab'], ground: '#333', seed: 4 }, img)
    let received = 0
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { images: Array<{ data: string }> }
        received = parsed.images.length
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ results: parsed.images.map(() => ({ technical: 66, aesthetic: 81 })) }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`
      const [s] = await createModelScorer({ id: 'iqa', type: 'http', url }).score([img])
      expect(received).toBe(1)
      expect(s).toMatchObject({ technical: 66, aesthetic: 81 })
    } finally {
      server.close()
    }
  })

  it('onnx adapter reports a clear error without onnxruntime-node', async () => {
    const scorer = createModelScorer({ id: 'nima-onnx', type: 'onnx', model: '/nonexistent.onnx', head: 'nima' })
    await expect(scorer.score(['/nonexistent.jpg'])).rejects.toThrow(/onnxruntime-node|ENOENT/)
  })

  it('maps raw numbers and 0..10 scales', () => {
    expect(toScoreSet(6.5).aesthetic).toBe(65)
    expect(toScoreSet({ score: 81 }, 'technical').technical).toBe(81)
  })
})

describe('vision LLM contract', () => {
  const items = [{ label: '#1', shotId: 's1', context: 'a' }, { label: '#2', shotId: 's2', context: 'b' }]
  it('builds a rubric prompt naming every frame', () => {
    const p = buildVlmPrompt(items, { purpose: 'travel album' })
    expect(p).toContain('#1, #2')
    expect(p).toContain('travel album')
  })
  it('parses fenced JSON, tolerates 0..10 scales and label drift', () => {
    const text = 'Here you go:\n```json\n[{"label":"#2","technical":8,"aesthetic":9,"composition":7,"content":6,"story":5,"potential":4,"tags":["Sunset"],"issues":[],"caption":"日落"},{"label":"1","technical":70,"aesthetic":60}]\n```'
    const m = parseVlmResponse(text, items)
    expect(m.get('s2')).toMatchObject({ technical: 80, aesthetic: 90, tags: ['sunset'], caption: '日落' })
    expect(m.get('s1')).toMatchObject({ technical: 70, aesthetic: 60 })
  })
  it('returns nothing for unparseable answers', () => {
    expect(parseVlmResponse('sorry I cannot', items).size).toBe(0)
  })
})
