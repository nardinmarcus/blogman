'use client'

import { useEffect, useState } from 'react'
import { SettingsSection } from './SettingsSection'
import { AiProviderManager } from './AiProviderManager'
import { AiImageProviderManager } from './AiImageProviderManager'

interface ActionProfileRef {
  profile_id: number | null
}

function countByProfileId(actions: ActionProfileRef[]): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const action of actions) {
    if (typeof action.profile_id === 'number') {
      counts[action.profile_id] = (counts[action.profile_id] || 0) + 1
    }
  }
  return counts
}

export function ModelsSettings() {
  const [textUsageCounts, setTextUsageCounts] = useState<Record<number, number>>({})
  const [imageUsageCounts, setImageUsageCounts] = useState<Record<number, number>>({})

  // 统计每个模型配置被多少条提示词绑定，用于删除时的影响面提示
  useEffect(() => {
    const load = async () => {
      const [textRes, imageRes] = await Promise.all([
        fetch('/api/admin/ai-actions').catch(() => null),
        fetch('/api/admin/ai-image-actions').catch(() => null),
      ])

      if (textRes?.ok) {
        const data = await textRes.json().catch(() => ({})) as { actions?: ActionProfileRef[] }
        setTextUsageCounts(countByProfileId(data.actions || []))
      }
      if (imageRes?.ok) {
        const data = await imageRes.json().catch(() => ({})) as { actions?: ActionProfileRef[] }
        setImageUsageCounts(countByProfileId(data.actions || []))
      }
    }

    void load()
  }, [])

  return (
    <div className="space-y-5">
      <SettingsSection
        title="文本模型"
        description="文本类 AI 能力的模型配置。提示词可指定绑定，未指定时使用默认配置。"
      >
        <AiProviderManager usageCounts={textUsageCounts} />
      </SettingsSection>
      <SettingsSection
        title="图片模型"
        description="配图、封面等图片生成的模型配置。"
      >
        <AiImageProviderManager usageCounts={imageUsageCounts} />
      </SettingsSection>
    </div>
  )
}
