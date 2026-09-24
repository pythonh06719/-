import { useState } from 'react'
import { View, Text, Input, Button, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { ActivityLevel, Gender, OnboardingRequest } from '@qsh/shared-types'

import { ApiClientError, apiRequest } from '../../lib/api'
import './index.scss'

const GENDERS: { label: string; value: Gender }[] = [
  { label: '男', value: 'male' },
  { label: '女', value: 'female' },
]
const ACTIVITIES: { label: string; value: ActivityLevel }[] = [
  { label: '久坐（很少运动）', value: 'sedentary' },
  { label: '轻度（每周 1-3 次）', value: 'light' },
  { label: '中度（每周 3-5 次）', value: 'moderate' },
  { label: '高度（每周 6-7 次）', value: 'high' },
  { label: '运动员', value: 'athlete' },
]

export default function OnboardingPage() {
  const [genderIdx, setGenderIdx] = useState(0)
  const [birthDate, setBirthDate] = useState('1995-01-01')
  const [heightCm, setHeightCm] = useState('165')
  const [currentWeightKg, setCurrentWeightKg] = useState('60')
  const [targetWeightKg, setTargetWeightKg] = useState('55')
  const [targetWeeks, setTargetWeeks] = useState('12')
  const [activityIdx, setActivityIdx] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    const body: OnboardingRequest = {
      gender: GENDERS[genderIdx].value,
      birthDate,
      heightCm: Number(heightCm),
      currentWeightKg: Number(currentWeightKg),
      targetWeightKg: Number(targetWeightKg),
      targetWeeks: Number(targetWeeks),
      activityLevel: ACTIVITIES[activityIdx].value,
      disclaimerAccepted: true,
    }
    if (
      [body.heightCm, body.currentWeightKg, body.targetWeightKg, body.targetWeeks].some(
        (n) => !n || n <= 0,
      )
    ) {
      setError('请填写有效的数值')
      return
    }
    setSubmitting(true)
    try {
      await apiRequest('/onboarding', { method: 'POST', body })
      Taro.showToast({ title: '已保存', icon: 'success' })
      Taro.switchTab({ url: '/pages/dashboard/index' })
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '提交失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className="container">
      <Text className="title">完善资料</Text>
      <Text className="muted" style={{ marginTop: '8rpx', marginBottom: '24rpx' }}>
        用于计算你的每日热量预算
      </Text>

      <View className="card">
        <Text className="label">性别</Text>
        <Picker
          mode="selector"
          range={GENDERS.map((g) => g.label)}
          value={genderIdx}
          onChange={(e) => setGenderIdx(Number(e.detail.value))}
        >
          <View className="picker">{GENDERS[genderIdx].label}</View>
        </Picker>
      </View>

      <View className="card">
        <Text className="label">出生日期</Text>
        <Picker
          mode="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.detail.value)}
        >
          <View className="picker">{birthDate}</View>
        </Picker>
      </View>

      <View className="card">
        <Text className="label">身高 (cm)</Text>
        <Input
          className="input"
          value={heightCm}
          onInput={(e) => setHeightCm(e.detail.value)}
          type="digit"
        />
      </View>

      <View className="card">
        <Text className="label">当前体重 (kg)</Text>
        <Input
          className="input"
          value={currentWeightKg}
          onInput={(e) => setCurrentWeightKg(e.detail.value)}
          type="digit"
        />
      </View>

      <View className="card">
        <Text className="label">目标体重 (kg)</Text>
        <Input
          className="input"
          value={targetWeightKg}
          onInput={(e) => setTargetWeightKg(e.detail.value)}
          type="digit"
        />
      </View>

      <View className="card">
        <Text className="label">目标周期 (周)</Text>
        <Input
          className="input"
          value={targetWeeks}
          onInput={(e) => setTargetWeeks(e.detail.value)}
          type="number"
        />
      </View>

      <View className="card">
        <Text className="label">活动量</Text>
        <Picker
          mode="selector"
          range={ACTIVITIES.map((a) => a.label)}
          value={activityIdx}
          onChange={(e) => setActivityIdx(Number(e.detail.value))}
        >
          <View className="picker">{ACTIVITIES[activityIdx].label}</View>
        </Picker>
      </View>

      <Button
        className="btn"
        loading={submitting}
        disabled={submitting}
        onClick={submit}
      >
        保存并开始
      </Button>
      {error ? <Text className="error">{error}</Text> : null}
    </View>
  )
}
