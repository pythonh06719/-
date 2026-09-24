import { useEffect, useState } from 'react'
import { View, Text, Input, Button, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { ListMealsResponse, MealType } from '@qsh/shared-types'

import { ApiClientError, apiRequest } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import { todayLocalKey } from '../../utils/date'
import './index.scss'

const MEALS: { label: string; value: MealType }[] = [
  { label: '早餐', value: 'breakfast' },
  { label: '午餐', value: 'lunch' },
  { label: '晚餐', value: 'dinner' },
  { label: '加餐', value: 'snack' },
]

export default function DiaryPage() {
  const status = useAuthStore((s) => s.status)
  const [data, setData] = useState<ListMealsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [mealIdx, setMealIdx] = useState(1)
  const [name, setName] = useState('')
  const [kcal, setKcal] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await apiRequest<ListMealsResponse>('/meals', {
        query: { date: todayLocalKey() },
      })
      setData(d)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (status === 'authenticated') void load()
    if (status === 'anonymous') Taro.redirectTo({ url: '/pages/login/index' })
  }, [status])

  const add = async () => {
    setError('')
    if (!name.trim() || !kcal.trim()) {
      setError('填好名称和热量')
      return
    }
    const n = Number(kcal)
    if (!n || n <= 0) {
      setError('热量需为正数')
      return
    }
    setAdding(true)
    try {
      await apiRequest('/meals/quick-add', {
        method: 'POST',
        body: {
          mealType: MEALS[mealIdx].value,
          customName: name.trim(),
          customKcal: n,
        },
      })
      setName('')
      setKcal('')
      Taro.showToast({ title: '已记录', icon: 'success' })
      void load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '添加失败')
    } finally {
      setAdding(false)
    }
  }

  const remove = async (id: number) => {
    try {
      await apiRequest(`/meals/${id}`, { method: 'DELETE' })
      void load()
    } catch (e) {
      Taro.showToast({
        title: e instanceof ApiClientError ? e.message : '删除失败',
        icon: 'none',
      })
    }
  }

  if (loading) {
    return (
      <View className="container">
        <Text className="muted">加载中…</Text>
      </View>
    )
  }

  return (
    <View className="container">
      <Text className="title">今日饮食</Text>
      <Text className="muted" style={{ marginTop: '8rpx', marginBottom: '16rpx' }}>
        {todayLocalKey()}
      </Text>

      {MEALS.map((m) => {
        const g = data?.groups.find((x) => x.mealType === m.value)
        if (!g || g.logs.length === 0) return null
        return (
          <View className="card" key={m.value}>
            <View className="row between">
              <Text className="meal-title">{m.label}</Text>
              <Text className="muted">{Math.round(g.totalKcal)} kcal</Text>
            </View>
            {g.logs.map((log) => (
              <View className="log row between" key={log.id}>
                <Text>{log.customName || '记录'}</Text>
                <View className="row">
                  <Text className="muted">{Math.round(log.kcal)} kcal</Text>
                  <Text className="del" onClick={() => remove(log.id)}>
                    ×
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )
      })}

      {!data || data.totalKcal === 0 ? (
        <Text className="muted">今天还没记录，下面快速记一笔吧</Text>
      ) : null}

      <View className="card add">
        <Text className="label">快速记一餐</Text>
        <Picker
          mode="selector"
          range={MEALS.map((m) => m.label)}
          value={mealIdx}
          onChange={(e) => setMealIdx(Number(e.detail.value))}
        >
          <View className="picker">{MEALS[mealIdx].label}</View>
        </Picker>
        <View style={{ height: '16rpx' }} />
        <Input
          className="input"
          value={name}
          onInput={(e) => setName(e.detail.value)}
          placeholder="食物名称，如 一碗米饭"
        />
        <View style={{ height: '16rpx' }} />
        <Input
          className="input"
          value={kcal}
          onInput={(e) => setKcal(e.detail.value)}
          type="digit"
          placeholder="热量 kcal"
        />
        <View style={{ height: '20rpx' }} />
        <Button className="btn" loading={adding} disabled={adding} onClick={add}>
          记录
        </Button>
        {error ? <Text className="error">{error}</Text> : null}
      </View>
    </View>
  )
}
