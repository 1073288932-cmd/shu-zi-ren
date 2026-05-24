import { defineConfig, defaultExclude } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    // Node v24.x 默认 threads pool 触发 uv_fs_close 原生断言崩溃，强制走子进程隔离
    pool: 'forks',
    // 排除 git worktrees —— main 跑测时不应吸进其他分支的副本（同一文件跑多次 + 假阴性风险）
    exclude: [...defaultExclude, '.worktrees/**'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
})
