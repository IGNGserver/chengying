import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@fontsource')) return 'fonts'
          return undefined
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
