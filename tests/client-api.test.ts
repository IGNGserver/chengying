import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadApi(base?: string): Promise<typeof import('../src/client/api.ts')> {
  vi.resetModules()
  if (base === undefined) vi.stubGlobal('__CHENGYING_API_BASE__', undefined)
  else vi.stubGlobal('__CHENGYING_API_BASE__', base)
  return import('../src/client/api.ts')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('browser Host API client', () => {
  it('uses the configured same-origin base and encodes artifact URLs', async () => {
    const { API_BASE, imageUrl, renderUrl, exportUrl } = await loadApi('/dsh/plugins/chengying/')
    expect(API_BASE).toBe('/dsh/plugins/chengying')
    expect(imageUrl('project / 1', 'shot / 1', 'thumb')).toBe('/dsh/plugins/chengying/p/project%20%2F%201/image/shot%20%2F%201/thumb')
    expect(renderUrl('p', 'r/1')).toBe('/dsh/plugins/chengying/p/p/render/r%2F1')
    expect(exportUrl('p', 'e', 'manifest')).toBe('/dsh/plugins/chengying/p/p/export-file/e?kind=manifest')
  })

  it('passes cancellation to fetch and decodes structured errors', async () => {
    const { api } = await loadApi()
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'denied', message: 'no access' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api('/private', { signal: controller.signal })).rejects.toMatchObject({ status: 403, code: 'denied', message: 'no access' })
    expect(fetchMock).toHaveBeenCalledWith('/api/chengying/private', expect.objectContaining({ signal: controller.signal, cache: 'no-store', credentials: 'same-origin' }))
  })

  it('reports invalid success responses instead of casting arbitrary text', async () => {
    const { api } = await loadApi()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy error</html>', { status: 200 })))
    await expect(api('/projects')).rejects.toMatchObject({ status: 200, code: 'invalid-response' })
  })
})
