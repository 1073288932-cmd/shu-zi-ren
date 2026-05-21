import { TencentAvatarVideoProvider } from './TencentAvatarVideoProvider'
import type { AvatarVideoProvider } from './AvatarVideoProvider'

export const avatarVideoProvider: AvatarVideoProvider = new TencentAvatarVideoProvider()
export type { AvatarVideoProvider }
