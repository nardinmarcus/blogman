'use client'

import { useEffect, useMemo, useState } from 'react'
import { useToast } from '@/components/Toast'
import { Modal } from '@/components/Modal'
import {
  AI_IMAGE_PROVIDER_CATEGORIES,
  AI_IMAGE_PROVIDER_MAP,
  AI_IMAGE_PROVIDER_PRESETS,
} from '@/lib/ai-image-provider-presets'
import { normalizeBaseUrl } from '@/lib/ai-provider-profiles'
import {
  createModelOptions,
  ProviderBasicFields,
  ProviderDialog,
  ProviderListTable,
  ProviderTemplateModal,
  type BaseProviderFormState,
  type BaseProviderProfile,
  type ModelsResponse,
  type ProviderTemplateGroup,
} from '@/app/admin/(protected)/settings/provider-manager-shared'

const CUSTOM_PROVIDER_ID = 'custom'

/** 带撤销的 toast 停留更久，给用户反应时间 */
const UNDO_TOAST_DURATION = 5000

type ProviderProfile = BaseProviderProfile

type ProviderFormState = BaseProviderFormState

function createEmptyForm(): ProviderFormState {
  return {
    name: '',
    provider: CUSTOM_PROVIDER_ID,
    provider_name: '自定义',
    provider_type: 'openai_images',
    provider_category: '',
    api_key_url: '',
    base_url: '',
    model: '',
    api_key: '',
    is_default: false,
    api_key_masked: '',
  }
}

function mapProfileToForm(profile: ProviderProfile): ProviderFormState {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    provider_name: profile.provider_name,
    provider_type: profile.provider_type,
    provider_category: profile.provider_category,
    api_key_url: profile.api_key_url,
    base_url: profile.base_url,
    model: profile.model,
    api_key: '',
    is_default: profile.is_default === 1,
    api_key_masked: profile.api_key_masked || '',
  }
}

export function AiImageProviderManager({ usageCounts }: { usageCounts?: Record<number, number> }) {
  const toast = useToast()

  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [defaultProfileId, setDefaultProfileId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const [editing, setEditing] = useState<ProviderFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)

  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [modelsSource, setModelsSource] = useState<'provider' | 'preset' | null>(null)
  const [modelsWarning, setModelsWarning] = useState('')
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderProfile | null>(null)

  const groupedPresets = useMemo(
    () => AI_IMAGE_PROVIDER_CATEGORIES.map((category) => ({
      category,
      presets: AI_IMAGE_PROVIDER_PRESETS.filter((preset) => preset.category === category),
    })).filter((group) => group.presets.length > 0) as ProviderTemplateGroup[],
    [],
  )

  const modelOptions = useMemo(() => {
    return createModelOptions(models, editing?.model || '')
  }, [editing?.model, models])

  const loadProfiles = async () => {
    try {
      const res = await fetch('/api/admin/ai-image-provider')
      if (!res.ok) throw new Error('加载失败')
      const data = (await res.json()) as { profiles: ProviderProfile[]; default_profile_id?: number | null }
      setProfiles(data.profiles || [])
      setDefaultProfileId(typeof data.default_profile_id === 'number' ? data.default_profile_id : null)
    } catch {
      toast.error('加载图片模型配置失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProfiles()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => {
    setEditing(createEmptyForm())
    setModels([])
    setModelsSource(null)
    setModelsWarning('')
  }

  const openEdit = (profile: ProviderProfile) => {
    setEditing(mapProfileToForm(profile))
    setModels([])
    setModelsSource(null)
    setModelsWarning('')
  }

  const applyPreset = (presetId: string) => {
    if (!editing) return

    if (presetId === CUSTOM_PROVIDER_ID) {
      setEditing({
        ...editing,
        provider: CUSTOM_PROVIDER_ID,
        provider_name: '自定义',
        provider_type: 'openai_images',
        provider_category: '',
        api_key_url: '',
        base_url: '',
        model: '',
      })
    } else {
      const preset = AI_IMAGE_PROVIDER_MAP[presetId]
      if (!preset) return
      setEditing({
        ...editing,
        provider: preset.id,
        provider_name: preset.name,
        provider_type: preset.providerType,
        provider_category: preset.category,
        api_key_url: preset.apiKeyUrl || '',
        base_url: preset.baseUrl,
        model: preset.defaultModel,
        name: editing.name.trim() ? editing.name : preset.name,
      })
    }

    setModels([])
    setModelsSource(null)
    setModelsWarning('')
    setTemplateModalOpen(false)
  }

  const handleFetchModels = async () => {
    if (!editing) return
    if (!editing.base_url.trim()) {
      toast.error('请先填写 Base URL')
      return
    }

    setLoadingModels(true)
    setModelsWarning('')

    try {
      const params = new URLSearchParams({
        provider: editing.provider,
        base_url: normalizeBaseUrl(editing.base_url),
      })
      if (editing.id) params.set('profile_id', String(editing.id))
      if (editing.api_key.trim()) params.set('api_key', editing.api_key.trim())

      const res = await fetch(`/api/admin/ai-image-provider/models?${params.toString()}`)
      const data = (await res.json()) as ModelsResponse
      if (!res.ok) {
        throw new Error(data.error || '获取模型列表失败')
      }

      const nextModels = data.models || []
      setModels(nextModels)
      setModelsSource(data.source || null)
      setModelsWarning(data.warning || '')

      if (nextModels.length > 0) {
        if (!editing.model.trim()) {
          setEditing((current) => current ? { ...current, model: nextModels[0].id } : current)
        }
        if (data.source === 'preset') {
          toast.warning(data.warning || `接口不可用，已回退 ${nextModels.length} 个预设模型`)
        } else if (data.warning) {
          toast.warning(data.warning)
        } else {
          toast.success(`已加载 ${nextModels.length} 个模型`)
        }
      } else {
        toast.warning('未获取到模型列表')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '获取模型列表失败'
      toast.error(message)
      setModels([])
      setModelsSource(null)
      setModelsWarning('')
    } finally {
      setLoadingModels(false)
    }
  }

  const handleSave = async () => {
    if (!editing) return

    if (!editing.name.trim() || !editing.base_url.trim() || !editing.model.trim()) {
      toast.error('请填写名称、Base URL、模型')
      return
    }

    setSaving(true)

    try {
      const payload: Record<string, unknown> = {
        name: editing.name.trim(),
        provider: editing.provider,
        provider_name: editing.provider_name,
        provider_type: editing.provider_type,
        provider_category: editing.provider_category,
        api_key_url: editing.api_key_url,
        base_url: normalizeBaseUrl(editing.base_url),
        model: editing.model.trim(),
        is_default: editing.is_default,
      }

      if (editing.id) payload.id = editing.id
      if (editing.api_key.trim()) payload.api_key = editing.api_key.trim()

      const res = await fetch('/api/admin/ai-image-provider', {
        method: editing.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || '保存失败')

      toast.success('图片模型配置已保存')
      setEditing(null)
      await loadProfiles()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const isDefaultProfile = (profile: ProviderProfile) =>
    profile.is_default === 1 || profile.id === defaultProfileId

  /** 通过 PUT 完整字段把某个配置的默认标记置为指定值（不触碰 api_key） */
  const saveDefaultFlag = async (target: ProviderProfile, isDefault: boolean) => {
    const res = await fetch('/api/admin/ai-image-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: target.id,
        name: target.name,
        provider: target.provider,
        provider_name: target.provider_name,
        provider_type: target.provider_type,
        provider_category: target.provider_category,
        api_key_url: target.api_key_url,
        base_url: target.base_url,
        model: target.model,
        is_default: isDefault,
      }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string }
    if (!res.ok) throw new Error(data.error || '设置默认失败')
  }

  const handleDelete = async () => {
    if (!deleteTarget) return

    const wasDefault = isDefaultProfile(deleteTarget)
    // 后端删除默认配置后不会自动扶正其他配置；这里删完后补一次 PUT，让弹窗里的承诺成立
    const fallback = wasDefault
      ? profiles.find((profile) => profile.id !== deleteTarget.id) ?? null
      : null

    try {
      const res = await fetch('/api/admin/ai-image-provider', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || '删除失败')

      if (fallback) {
        await saveDefaultFlag(fallback, true)
      }

      // 不提供撤销：重建配置无法恢复已删除的 API Key（列表里只有掩码）
      toast.success('图片模型配置已删除')
      setDeleteTarget(null)
      await loadProfiles()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const setAsDefault = async (profile: ProviderProfile) => {
    if (isDefaultProfile(profile)) return

    const previousDefault = profiles.find((item) => isDefaultProfile(item)) ?? null

    try {
      await saveDefaultFlag(profile, true)
      await loadProfiles()

      toast.success(
        `已将「${profile.name}」设为默认图片模型`,
        UNDO_TOAST_DURATION,
        previousDefault
          ? {
              label: '撤销',
              onClick: () => {
                void (async () => {
                  try {
                    await saveDefaultFlag(previousDefault, true)
                    await loadProfiles()
                    toast.success('已撤销')
                  } catch {
                    toast.error('撤销失败，请重试')
                  }
                })()
              },
            }
          : undefined,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '设置默认失败')
    }
  }

  const updateEditing = (patch: Partial<ProviderFormState>) => {
    setEditing((current) => (current ? { ...current, ...patch } : current))
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-[var(--editor-muted)]">加载中…</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-[var(--editor-ink)]">图片模型配置</h3>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-lg bg-[var(--editor-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:brightness-105"
        >
          + 新增配置
        </button>
      </div>

      <ProviderListTable
        profiles={profiles}
        defaultProfileId={defaultProfileId}
        emptyText="暂无配置"
        usageCounts={usageCounts}
        onEdit={openEdit}
        onDelete={setDeleteTarget}
        onSetDefault={setAsDefault}
      />

      {editing && (
        <ProviderDialog
          title={editing.id ? '编辑图片模型' : '新增图片模型'}
          onClose={() => setEditing(null)}
          headerAction={(
            <button
              type="button"
              onClick={() => setTemplateModalOpen(true)}
              className="rounded-md border border-[var(--editor-line)] px-2.5 py-1 text-xs text-[var(--editor-ink)] hover:bg-[var(--editor-soft)]"
            >
              快捷模板
            </button>
          )}
        >
          <ProviderBasicFields
            editing={editing}
            modelOptions={modelOptions}
            loadingModels={loadingModels}
            models={models}
            modelsSource={modelsSource}
            modelsWarning={modelsWarning}
            onChange={updateEditing}
            onFetchModels={handleFetchModels}
            fetchModelsLabel="获取模型"
          />

          <div className="mt-3">
            <label className="inline-flex items-center gap-2 text-sm text-[var(--editor-ink)]">
                <input
                  type="checkbox"
                  checked={editing.is_default}
                  onChange={(event) => updateEditing({ is_default: event.target.checked })}
                />
                设为默认配置
            </label>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg border border-[var(--editor-line)] px-4 py-2 text-sm text-[var(--editor-ink)] hover:bg-[var(--editor-soft)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-[var(--editor-accent)] px-4 py-2 text-sm font-semibold text-white hover:brightness-105 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </ProviderDialog>
      )}

      {templateModalOpen && editing && (
        <ProviderTemplateModal
          groups={groupedPresets}
          customOptionLabel="自定义兼容接口"
          customOptionDescription="适用于支持 OpenAI Images 风格接口的自定义服务。"
          onClose={() => setTemplateModalOpen(false)}
          onSelect={applyPreset}
        />
      )}

      {deleteTarget && (() => {
        const usageCount = usageCounts?.[deleteTarget.id] ?? 0
        const deletingDefault = isDefaultProfile(deleteTarget)
        const isLastProfile = profiles.length <= 1
        const nextDefault = profiles.find((profile) => profile.id !== deleteTarget.id) ?? null

        if (isLastProfile) {
          return (
            <Modal
              isOpen
              onClose={() => setDeleteTarget(null)}
              title="无法删除"
              description={`「${deleteTarget.name}」是当前唯一的图片模型配置，删除后将没有可用配置，因此无法删除。请先新增其他配置。`}
              type="info"
            />
          )
        }

        const impactParts: string[] = []
        if (usageCount > 0) {
          impactParts.push(`${usageCount} 个图片提示绑定了此配置，删除后将回落到默认配置。`)
        }
        if (deletingDefault && nextDefault) {
          impactParts.push(`删除后默认配置将切换为「${nextDefault.name}」。`)
        }

        return (
          <Modal
            isOpen
            onClose={() => setDeleteTarget(null)}
            onConfirm={handleDelete}
            title="确认删除"
            description={`确定要删除配置「${deleteTarget.name}」吗？${impactParts.length > 0 ? ` ${impactParts.join(' ')}` : ''}`}
            confirmText="删除"
            type="danger"
          />
        )
      })()}
    </div>
  )
}
