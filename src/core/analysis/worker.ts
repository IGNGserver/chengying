/** Worker-thread entry: decode a preview and compute classical features off the main thread. */
import { parentPort } from 'node:worker_threads'
import { loadRgb } from '../image/preview.ts'
import { computeFeatures } from './pixels.ts'

interface Job { id: number; path: string; maxEdge: number }

parentPort?.on('message', (job: Job) => {
  void (async () => {
    try {
      const img = await loadRgb(job.path, job.maxEdge)
      parentPort?.postMessage({ id: job.id, features: computeFeatures(img) })
    } catch (error) {
      parentPort?.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
