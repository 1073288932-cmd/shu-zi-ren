import type { XingyunConfigStatus } from '../../shared/types'

export const DEFAULT_GATEWAY = 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session'

export function getXingyunConfig(env: NodeJS.ProcessEnv = process.env): XingyunConfigStatus {
  const appId = env.XINGYUN_APP_ID ?? ''
  const appSecret = env.XINGYUN_APP_SECRET ?? ''
  if (!appId || !appSecret) {
    return {
      configured: false,
      missingKey: true,
      errorReason: '未配置魔珐 — 请在 .env 填 XINGYUN_APP_ID / XINGYUN_APP_SECRET',
    }
  }
  return {
    configured: true,
    appId,
    appSecret,
    gatewayServer: env.XINGYUN_GATEWAY_SERVER || DEFAULT_GATEWAY,
  }
}
