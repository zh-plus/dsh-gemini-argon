/**
 * Browser companion for dsh-gemini-argon.
 *
 * Adds an editable configuration card to this provider's row under
 * Settings → Models, using the `settings.models.provider-card` slot. The card
 * writes the plugin's volatile config through `configForms`, so fields land in
 * the profile patch exactly like any built-in provider, and stores the API key
 * through the credentials service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gemini-argon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'llm-gemini-argon'
    const DEFAULT_KEY_REF = 'GOOGLE_VERTEX_API_KEY'

    const inject = ['slots', 'configForms', 'remote.credentials']

    const S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        padding: '10px 12px',
        background: 'var(--dsw-alias-bg-module-platform)',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      statusOk: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
      statusBad: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      label: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      fieldHint: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        width: '100%',
        height: '32px',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '0 10px',
        fontSize: '14px',
        lineHeight: '22px',
        font: 'inherit',
      },
      wide: { gridColumn: '1 / -1' },
      actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      primary: {
        height: '32px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
      secondary: {
        height: '32px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        cursor: 'pointer',
      },
    }

    const BASIC_FIELDS = [
      { key: 'project', label: 'Google Cloud 项目', kind: 'text', placeholder: 'my-project 或 123456789012', hint: 'Project ID 或 Project Number 均可；在 Cloud Console 的项目信息卡里查看，使用 service account JSON 时可留空' },
      { key: 'auth', label: '认证方式', kind: 'select', options: [['auto', 'auto（有 JSON 用 JSON）'], ['api-key', 'API Key'], ['service-account', 'Service Account JSON']] },
      { key: 'apiKeyEnv', label: 'API Key 凭据名', kind: 'text', placeholder: DEFAULT_KEY_REF },
      { key: 'serviceAccountFile', label: 'Service Account JSON 路径', kind: 'text', placeholder: '~/.config/gcloud/argon-sa.json', hint: '留空时读取 GOOGLE_APPLICATION_CREDENTIALS；JSON 里的 project_id 会自动作为 project' },
      { key: 'model', label: '模型 ID', kind: 'text', placeholder: 'gemini-4-argon' },
      { key: 'modelName', label: '显示名', kind: 'text', placeholder: 'Gemini 4 Argon' },
      { key: 'thinkingLevel', label: '思考档位', kind: 'select', options: [['off', 'off（最低档 LOW）'], ['low', 'low（返回思考摘要）'], ['medium', 'medium'], ['high', 'high']] },
      { key: 'proxy', label: '代理', kind: 'text', placeholder: 'auto / direct / http://127.0.0.1:7897' },
    ]

    const ADVANCED_FIELDS = [
      { key: 'location', label: 'Vertex location', kind: 'text', placeholder: 'global' },
      { key: 'baseURL', label: 'HTTP 根地址', kind: 'text', placeholder: 'https://aiplatform.googleapis.com' },
      { key: 'contextWindow', label: '上下文窗口', kind: 'number' },
      { key: 'maxTokens', label: '最大输出 token', kind: 'number' },
      { key: 'streamIdleTimeoutMs', label: '流空闲超时 (ms)', kind: 'number' },
      { key: 'imageMaxPixels', label: '单图最大像素', kind: 'number' },
      { key: 'imageMaxBytes', label: '单图最大字节', kind: 'number' },
    ]

    function apply(ctx) {
      function useForm(form) {
        return React.useSyncExternalStore(
          React.useCallback((notify) => form.subscribe(notify), [form]),
          () => form.getSnapshot(),
          () => form.getSnapshot(),
        )
      }

      function fieldNode(field, draft, setDraft) {
        const raw = draft[field.key]
        const value = raw === undefined || raw === null ? '' : String(raw)
        const onChange = (event) => {
          const next = event.target.value
          setDraft((current) => ({ ...current, [field.key]: next }))
        }
        const options = field.kind === 'select' ? field.options : undefined
        return h('label', { key: field.key, style: field.wide === true ? { ...S.field, ...S.wide } : S.field },
          h('span', { style: S.label }, field.label),
          options === undefined
            ? h('input', {
                type: field.kind === 'number' ? 'number' : 'text',
                value,
                placeholder: field.placeholder,
                onChange,
                style: S.input,
              })
            : h('select', { value: value === '' ? options[0][0] : value, onChange, style: S.input },
                options.map(([optionValue, label]) => h('option', { key: optionValue, value: optionValue }, label))),
          field.hint === undefined ? null : h('span', { style: S.fieldHint }, field.hint),
        )
      }

      function ProviderCard(props) {
        const [open, setOpen] = React.useState(false)
        const [draft, setDraft] = React.useState(null)
        const [keyDraft, setKeyDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [message, setMessage] = React.useState(undefined)
        const [messageBad, setMessageBad] = React.useState(false)
        const form = React.useMemo(() => ctx.configForms.get(NS), [])
        const snap = useForm(form)
        const value = snap.value

        React.useEffect(() => {
          if (draft === null && value !== undefined) setDraft({ ...value })
        }, [draft, value])

        const keyRef = ((draft?.apiKeyEnv ?? value?.apiKeyEnv ?? DEFAULT_KEY_REF) || DEFAULT_KEY_REF).trim() || DEFAULT_KEY_REF
        const ready = snap.status === 'ready' && draft !== null
        const writable = snap.writable === true

        const save = async () => {
          if (!ready) return
          setBusy(true)
          setMessage(undefined)
          try {
            const ops = []
            for (const field of [...BASIC_FIELDS, ...ADVANCED_FIELDS]) {
              const before = value[field.key]
              let after = draft[field.key]
              if (typeof after === 'string') after = after.trim() === '' ? undefined : after.trim()
              if (field.kind === 'number' && after !== undefined) {
                const parsed = Number(after)
                if (!Number.isFinite(parsed) || parsed <= 0) {
                  setMessageBad(true)
                  setMessage(`${field.label} 必须是正数`)
                  return
                }
                after = parsed
              }
              if (after === before) continue
              ops.push(after === undefined ? { op: 'unset', path: [field.key] } : { op: 'set', path: [field.key], value: after })
            }
            if (ops.length > 0) {
              const accepted = await form.mutate(ops, snap.revision)
              if (!accepted) {
                setMessageBad(true)
                setMessage('保存失败：配置不可写，或版本已变化，请点“重新读取”后再试')
                return
              }
            }
            const key = keyDraft.trim()
            if (key.length > 0) {
              const stored = await ctx.remote.credentials.set(keyRef, key)
              if (!stored.ok) {
                setMessageBad(true)
                setMessage(`API Key 保存失败：${stored.error?.message ?? 'unknown error'}`)
                return
              }
              setKeyDraft('')
            }
            setDraft(null)
            setMessageBad(false)
            setMessage('已保存，下一次模型请求生效')
          } catch (error) {
            setMessageBad(true)
            setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setBusy(false)
          }
        }

        const reload = () => {
          setDraft(null)
          setMessage(undefined)
          void ctx.configForms.describe().load()
        }

        const clearKey = async () => {
          setBusy(true)
          setMessage(undefined)
          try {
            const removed = await ctx.remote.credentials.unset(keyRef)
            setMessageBad(removed.ok !== true)
            setMessage(removed.ok ? `已清除 ${keyRef}` : `清除失败：${removed.error?.message ?? 'unknown error'}`)
          } finally {
            setBusy(false)
          }
        }

        const status = props.keyConfigured === true
          ? h('span', { style: S.statusOk }, `API Key 已配置（${keyRef}）`)
          : h('span', { style: S.hint }, `API Key 未配置（${keyRef}）`)

        if (open && !ready) {
          return h('div', { style: S.card, 'data-gemini-argon-config': '' },
            h('div', { style: S.head },
              h('span', { style: S.hint }, snap.status === 'loading' ? '正在读取配置…' : '配置暂不可用'),
              h('button', { type: 'button', style: S.secondary, disabled: busy, onClick: reload }, '重新读取'),
            ),
          )
        }

        return h('div', { style: S.card, 'data-gemini-argon-config': '' },
          h('div', { style: S.head },
            h('span', { style: S.hint }, '项目、认证、模型、思考档位与代理可直接在这里编辑'),
            h('button', { type: 'button', style: S.secondary, onClick: () => setOpen((current) => !current) }, open ? '收起' : '编辑配置'),
            status,
          ),
          open ? h(React.Fragment, null,
            h('div', { style: S.grid }, BASIC_FIELDS.map((field) => fieldNode(field, draft, setDraft))),
            h('label', { style: { ...S.field, ...S.wide } },
              h('span', { style: S.label }, 'API Key（留空表示保持已保存的值）'),
              h('input', {
                type: 'password',
                value: keyDraft,
                placeholder: props.keyConfigured === true ? '已保存，留空即不修改' : '粘贴 Vertex AI Express API Key',
                onChange: (event) => setKeyDraft(event.target.value),
                style: S.input,
                autoComplete: 'off',
              }),
            ),
            h('details', { style: { ...S.field, ...S.wide } },
              h('summary', { style: { ...S.label, cursor: 'pointer' } }, '高级设置'),
              h('div', { style: { ...S.grid, marginTop: '10px' } }, ADVANCED_FIELDS.map((field) => fieldNode(field, draft, setDraft))),
            ),
            h('div', { style: S.actions },
              h('button', { type: 'button', style: S.primary, disabled: !ready || !writable || busy, onClick: save }, busy ? '保存中…' : '保存'),
              h('button', { type: 'button', style: S.secondary, disabled: busy, onClick: reload }, '重新读取'),
              h('button', { type: 'button', style: S.secondary, disabled: !writable || busy, onClick: clearKey }, '清除 API Key'),
              ready ? null : h('span', { style: S.hint }, snap.status === 'loading' ? '正在读取配置…' : '配置暂不可用'),
            ),
            message === undefined ? null : h('span', { style: messageBad ? S.statusBad : S.statusOk }, message),
          ) : null,
        )
      }

      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: NS,
      }, ProviderCard))), 'gemini-argon: model provider card')
    }

    return { inject, apply }
  },
})
