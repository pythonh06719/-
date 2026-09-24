import { create } from 'zustand'
import type { AuthResponse, SendCodeResponse, User } from '@qsh/shared-types'

import { apiRequest } from '../lib/api'
import { tokenStorage } from '../lib/storage'

interface AuthState {
  accessToken: string | null
  user: User | null
  onboardingCompleted: boolean
  status: 'loading' | 'anonymous' | 'authenticated'
  bootstrap: () => Promise<void>
  sendCode: (email: string) => Promise<SendCodeResponse>
  verifyCode: (email: string, code: string) => Promise<AuthResponse>
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: tokenStorage.get(),
  user: null,
  onboardingCompleted: false,
  status: tokenStorage.get() ? 'loading' : 'anonymous',

  bootstrap: async () => {
    const token = tokenStorage.get()
    if (!token) {
      set({ status: 'anonymous' })
      return
    }
    try {
      await apiRequest('/auth/me', { auth: true })
      set({ status: 'authenticated' })
    } catch {
      tokenStorage.clear()
      set({ accessToken: null, user: null, status: 'anonymous' })
    }
  },

  sendCode: (email) =>
    apiRequest<SendCodeResponse>('/auth/send-code', {
      method: 'POST',
      auth: false,
      body: { email, purpose: 'login' },
    }),

  verifyCode: async (email, code) => {
    const res = await apiRequest<AuthResponse>('/auth/verify-code', {
      method: 'POST',
      auth: false,
      body: { email, code, purpose: 'login' },
    })
    tokenStorage.set(res.accessToken)
    set({
      accessToken: res.accessToken,
      user: res.user,
      onboardingCompleted: res.onboardingCompleted,
      status: 'authenticated',
    })
    return res
  },

  logout: () => {
    tokenStorage.clear()
    set({
      accessToken: null,
      user: null,
      onboardingCompleted: false,
      status: 'anonymous',
    })
  },
}))
