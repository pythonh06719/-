import Taro from '@tarojs/taro'

export const TOKEN_KEY = 'qsh:accessToken'

// 小程序无 cookie / sessionStorage，登录态只存本地存储。
export const tokenStorage = {
  get: (): string | null => Taro.getStorageSync(TOKEN_KEY) || null,
  set: (t: string) => Taro.setStorageSync(TOKEN_KEY, t),
  clear: () => Taro.removeStorageSync(TOKEN_KEY),
}
