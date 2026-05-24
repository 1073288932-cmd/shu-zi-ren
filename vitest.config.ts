import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    // Node v24.x 默认 threads pool 触发 uv_fs_close 原生断言崩溃，强制走子进程隔离
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
})
