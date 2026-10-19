/**
 * Browser companion for dsh-gemini-argon.
 *
 * Adds an editable configuration card to this provider's row under
 * Settings → Models, using the `settings.models.provider-card` slot. The card
 * writes the plugin's volatile config through `configForms`, so fields land in
 * the profile patch exactly like any built-in provider, and stores the API key
 * through the credentials service.
 *
 * Styling follows the Models page's own typography and design tokens: 12/18
 * field labels, 14/22 inputs and buttons, 36px controls, and the shared
 * settings-card surfaces, so the card does not stand out as a foreign widget.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gemini-argon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'llm-gemini-argon'
    const DEFAULT_KEY_REF = 'GOOGLE_VERTEX_API_KEY'

    const inject = ['slots', 'configForms', 'remote', 'remote.credentials', 'remote.llm']

    const S = {
      editor: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '14px 16px',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        background: 'var(--dsw-alias-bg-module-platform)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
      },
      head: { display: 'flex', alignItems: 'flex-start', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' },
      headText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      title: { fontSize: '14px', lineHeight: '22px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      hintError: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
      hintOk: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
      hintWarn: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))' },
      headActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      sectionTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        lineHeight: '18px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
      },
      divider: { height: '0.5px', background: 'var(--dsw-alias-border-l2)', width: '100%' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
      wide: { gridColumn: '1 / -1' },
      label: { fontSize: '12px', lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
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
        fontFamily: 'inherit',
      },
      inputWithAction: { display: 'flex', gap: '6px', alignItems: 'center' },
      inputGrow: { flex: '1 1 0', minWidth: 0 },
      keyWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
      keyToggle: {
        position: 'absolute',
        right: '1px',
        height: '30px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      primary: {
        height: '36px',
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      secondary: {
        height: '36px',
        padding: '0 14px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      small: {
        height: '28px',
        padding: '0 10px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      danger: {
        height: '36px',
        padding: '0 10px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '22px',
        cursor: 'pointer',
      },
      dangerConfirm: {
        height: '32px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-state-error-primary)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
      },
      confirmGroup: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      spacer: { flex: '1 1 auto' },
      disabled: { opacity: 0.4, cursor: 'default' },
      details: { display: 'flex', flexDirection: 'column', gap: '10px' },
      summary: {
        fontSize: '12px',
        lineHeight: '18px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        width: 'fit-content',
      },
    }

    const CONNECTION_FIELDS = [
      { key: 'project', label: 'Google Cloud 项目', kind: 'text', placeholder: 'my-project 或 123456789012', hint: 'Project ID 或 Project Number 均可；在 Cloud Console 的项目信息卡里查看，使用 service account JSON 时可留空' },
      { key: 'auth', label: '认证方式', kind: 'select', options: [['auto', 'auto（有 JSON 用 JSON）'], ['api-key', 'API Key'], ['service-account', 'Service Account JSON']] },
      { key: 'apiKeyEnv', label: 'API Key 凭据名', kind: 'text', placeholder: DEFAULT_KEY_REF, hint: '凭据服务里的名字，默认 GOOGLE_VERTEX_API_KEY' },
      { key: 'serviceAccountFile', label: 'Service Account JSON 路径', kind: 'text', browse: true, placeholder: '~/.config/gcloud/argon-sa.json', hint: '留空时读取 GOOGLE_APPLICATION_CREDENTIALS；JSON 里的 project_id 会自动作为 project' },
    ]

    const MODEL_FIELDS = [
      { key: 'model', label: '模型 ID', kind: 'text', placeholder: 'gemini-4-argon' },
      { key: 'modelName', label: '显示名', kind: 'text', placeholder: 'Gemini 4 Argon' },
      { key: 'thinkingLevel', label: '思考档位', kind: 'select', options: [['off', 'off（最低档 LOW）'], ['low', 'low（返回思考摘要）'], ['medium', 'medium'], ['high', 'high']], hint: '4 Argon 无法真正关闭思考；off 固定最低档并隐藏思考内容' },
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

    const ALL_FIELDS = [...CONNECTION_FIELDS, ...MODEL_FIELDS, ...ADVANCED_FIELDS]

    function apply(ctx) {
      function useForm(form) {
        return React.useSyncExternalStore(
          React.useCallback((notify) => form.subscribe(notify), [form]),
          () => form.getSnapshot(),
          () => form.getSnapshot(),
        )
      }

      function normalized(field, value) {
        if (value === undefined || value === null) return undefined
        if (field.kind === 'number') {
          const number = Number(String(value).trim())
          return Number.isFinite(number) ? number : String(value).trim()
        }
        const text = String(value).trim()
        return text === '' ? undefined : text
      }

      function fieldNode(field, draft, setDraft, onBrowse) {
        const raw = draft[field.key]
        const value = raw === undefined || raw === null ? '' : String(raw)
        const onChange = (event) => {
          const next = event.target.value
          setDraft((current) => ({ ...current, [field.key]: next }))
        }
        const options = field.kind === 'select' ? field.options : undefined
        const control = options === undefined
          ? h('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              value,
              placeholder: field.placeholder,
              onChange,
              style: S.input,
              'aria-label': field.label,
              ...(field.kind === 'number' ? { min: 1, step: 1 } : {}),
            })
          : h('select', { value: value === '' ? options[0][0] : value, onChange, style: S.input, 'aria-label': field.label },
              options.map(([optionValue, label]) => h('option', { key: optionValue, value: optionValue }, label)))
        const withBrowse = field.browse === true && onBrowse !== undefined
          ? h('div', { style: S.inputWithAction },
              h('div', { style: S.inputGrow }, control),
              h('button', { type: 'button', style: S.small, onClick: onBrowse }, '浏览…'),
            )
          : control
        return h('div', { key: field.key, style: field.wide === true ? { ...S.field, ...S.wide } : S.field },
          h('span', { style: S.label }, field.label),
          withBrowse,
          field.hint === undefined ? null : h('span', { style: S.hint }, field.hint),
        )
      }

      function ProviderCard(props) {
        const [open, setOpen] = React.useState(false)
        const [keyDraft, setKeyDraft] = React.useState('')
        const [showKey, setShowKey] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [testing, setTesting] = React.useState(false)
        const [message, setMessage] = React.useState(undefined)
        const [messageBad, setMessageBad] = React.useState(false)
        const [confirmClear, setConfirmClear] = React.useState(false)
        const [confirmClearSa, setConfirmClearSa] = React.useState(false)
        const fileInput = React.useRef(null)
        const form = React.useMemo(() => ctx.configForms.get(NS), [])
        const snap = useForm(form)
        const value = snap.value
        // Seed from the first ready snapshot so opening the card never flashes a
        // loading row; the effect only fills the gap when the mirror arrives late.
        const [draft, setDraft] = React.useState(() => (value === undefined ? null : { ...value }))

        React.useEffect(() => {
          if (draft === null && value !== undefined) setDraft({ ...value })
        }, [draft, value])

        const keyRef = ((draft?.apiKeyEnv ?? value?.apiKeyEnv ?? DEFAULT_KEY_REF) || DEFAULT_KEY_REF).trim() || DEFAULT_KEY_REF
        const ready = snap.status === 'ready' && draft !== null
        const writable = snap.writable === true
        const authMode = draft?.auth ?? value?.auth ?? 'auto'
        const serviceAccountConfigured = authMode === 'service-account'
          || (authMode === 'auto' && ((draft?.serviceAccountFile ?? value?.serviceAccountFile) !== undefined))
        const storedServiceAccount = Boolean(value?.serviceAccountFile) || Boolean(value?.serviceAccountJson)
        const dirty = React.useMemo(() => {
          if (value === undefined || draft === null) return false
          return ALL_FIELDS.some((field) => normalized(field, value[field.key]) !== normalized(field, draft[field.key]))
        }, [draft, value])

        React.useEffect(() => {
          if (!confirmClear && !confirmClearSa) return undefined
          const timer = setTimeout(() => {
            setConfirmClear(false)
            setConfirmClearSa(false)
          }, 4000)
          return () => clearTimeout(timer)
        }, [confirmClear, confirmClearSa])

        const chooseFile = (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file === undefined) return
          const path = window.__DSH_HOST_PATHS__?.pathFor?.(file) ?? file.path
          if (typeof path === 'string' && path.length > 0) {
            setDraft((current) => ({ ...current, serviceAccountFile: path }))
            setMessageBad(false)
            setMessage(`已选择：${path}`)
            return
          }
          setMessageBad(true)
          setMessage('当前环境无法读取文件绝对路径，请手动填写')
        }

        const save = async () => {
          if (!ready) return
          setBusy(true)
          setMessage(undefined)
          try {
            const ops = []
            for (const field of ALL_FIELDS) {
              const before = normalized(field, value[field.key])
              const after = normalized(field, draft[field.key])
              if (field.kind === 'number' && after !== undefined && (typeof after !== 'number' || after <= 0)) {
                setMessageBad(true)
                setMessage(`${field.label} 必须是正数`)
                return
              }
              if (after === before) continue
              ops.push(after === undefined ? { op: 'unset', path: [field.key] } : { op: 'set', path: [field.key], value: after })
            }
            const key = keyDraft.trim()
            if (key.length > 0 && String(draft.apiKeyEnv ?? '').trim() === '') {
              // Give the row its credential dot once a key exists.
              ops.push({ op: 'set', path: ['apiKeyEnv'], value: keyRef })
            }
            if (ops.length > 0) {
              const accepted = await form.mutate(ops, snap.revision)
              if (!accepted) {
                setMessageBad(true)
                setMessage('保存失败：配置不可写，或版本已变化，请点“重新读取”后再试')
                return
              }
            }
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
          setKeyDraft('')
          setConfirmClear(false)
          setMessage(undefined)
          void ctx.configForms.describe().load()
        }

        const discard = () => {
          setDraft(value === undefined ? null : { ...value })
          setKeyDraft('')
          setConfirmClear(false)
          setMessage(undefined)
        }

        const removeKey = async () => {
          setConfirmClear(false)
          setBusy(true)
          setMessage(undefined)
          try {
            const removed = await ctx.remote.credentials.unset(keyRef)
            if (removed.ok === true) {
              setMessageBad(false)
              setMessage(`已清除 ${keyRef}`)
              // The parent row's credential join may lag; force one describe read
              // so the status and the API-key dot catch up immediately.
              void ctx.configForms.describe().load()
            } else {
              setMessageBad(true)
              setMessage(`清除失败：${removed.error?.message ?? 'unknown error'}`)
            }
          } catch (error) {
            setMessageBad(true)
            setMessage(`清除失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setBusy(false)
          }
        }

        const clearServiceAccount = async () => {
          if (!confirmClearSa) {
            setConfirmClearSa(true)
            return
          }
          setConfirmClearSa(false)
          setBusy(true)
          setMessage(undefined)
          try {
            const ops = []
            if (value.serviceAccountFile !== undefined) ops.push({ op: 'unset', path: ['serviceAccountFile'] })
            if (value.serviceAccountJson !== undefined) ops.push({ op: 'unset', path: ['serviceAccountJson'] })
            if ((value.auth ?? 'auto') === 'service-account') ops.push({ op: 'set', path: ['auth'], value: 'api-key' })
            if (ops.length > 0) {
              const accepted = await form.mutate(ops, snap.revision)
              if (!accepted) {
                setMessageBad(true)
                setMessage('清除失败：配置不可写，或版本已变化，请点“重新读取”后再试')
                return
              }
            }
            setDraft(null)
            setKeyDraft('')
            setMessageBad(false)
            setMessage('已清除 Service Account 配置；JSON 文件本身未删除')
          } catch (error) {
            setMessageBad(true)
            setMessage(`清除失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setBusy(false)
          }
        }

        const testConnection = async () => {
          if (dirty || keyDraft.trim().length > 0) {
            setMessageBad(true)
            setMessage('请先保存修改，再测试连接')
            return
          }
          setTesting(true)
          setMessage(undefined)
          try {
            const result = await ctx.remote.llm.discoverModels(NS, { provider: 'gemini-argon' })
            if (result.ok === true) {
              setMessageBad(false)
              setMessage('连接成功：认证、端点和模型均可达（countTokens 探测）')
            } else {
              setMessageBad(true)
              setMessage(`连接失败：${result.error?.message ?? 'unknown error'}`)
            }
          } catch (error) {
            setMessageBad(true)
            setMessage(`连接失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setTesting(false)
          }
        }

        const statusDot = serviceAccountConfigured
          ? h('span', { style: S.hint }, '认证：Service Account JSON（不使用 API Key）')
          : props.keyConfigured === true
            ? h('span', { style: S.hintOk }, `认证：API Key 已配置（${keyRef}）`)
            : h('span', { style: S.hint }, `API Key 未配置（${keyRef}）`)

        const head = h('div', { style: S.head },
          h('div', { style: S.headText },
            h('span', { style: S.title }, 'Gemini 4 Argon 配置'),
            h('span', { style: S.hint }, '项目、认证、模型、思考档位与代理；保存后下一次模型请求生效'),
          ),
          h('div', { style: S.headActions },
            dirty ? h('span', { style: S.hintWarn }, '有未保存的修改') : null,
            statusDot,
            h('button', { type: 'button', style: S.secondary, onClick: () => setOpen((current) => !current) }, open ? '收起' : '编辑配置'),
          ),
        )

        if (open && !ready) {
          return h('div', { style: S.editor, 'data-gemini-argon-config': '', 'data-auth': serviceAccountConfigured ? 'service-account' : 'api-key' },
            head,
            h('div', { style: S.actions },
              h('span', { style: S.hint }, snap.status === 'loading' ? '正在读取配置…' : '配置暂不可用'),
              h('button', { type: 'button', style: S.small, disabled: busy, onClick: reload }, '重新读取'),
            ),
          )
        }

        return h('div', { style: S.editor, 'data-gemini-argon-config': '', 'data-auth': serviceAccountConfigured ? 'service-account' : 'api-key' },
          head,
          open ? h(React.Fragment, null,
            h('span', { style: S.hintWarn }, '右上角“编辑”打开的是 DSH 通用编辑器，第三方 provider 不会渲染字段；请使用本卡片。'),
            h('input', {
              type: 'file',
              accept: '.json,application/json',
              ref: fileInput,
              style: { display: 'none' },
              onChange: chooseFile,
            }),
            h('div', { style: S.sectionTitle }, '连接'),
            h('div', { style: S.grid }, CONNECTION_FIELDS.map((field) => fieldNode(field, draft, setDraft, () => fileInput.current?.click()))),
            h('div', { style: S.divider }),
            h('div', { style: S.sectionTitle }, '模型与思考'),
            h('div', { style: S.grid }, MODEL_FIELDS.map((field) => fieldNode(field, draft, setDraft))),
            h('details', { style: S.details },
              h('summary', { style: S.summary }, '高级设置'),
              h('div', { style: { ...S.grid, marginTop: '10px' } }, ADVANCED_FIELDS.map((field) => fieldNode(field, draft, setDraft))),
            ),
            h('div', { style: S.divider }),
            h('div', { style: S.field },
              h('span', { style: S.label }, `API Key（${keyRef}）`),
              h('div', { style: S.keyWrap },
                h('input', {
                  type: showKey ? 'text' : 'password',
                  value: keyDraft,
                  placeholder: props.keyConfigured === true ? '已保存，留空即不修改' : '粘贴 Vertex AI Express API Key',
                  onChange: (event) => setKeyDraft(event.target.value),
                  style: { ...S.input, paddingRight: '56px' },
                  autoComplete: 'off',
                  'aria-label': 'API Key',
                }),
                h('button', { type: 'button', style: S.keyToggle, onClick: () => setShowKey((current) => !current) }, showKey ? '隐藏' : '显示'),
              ),
              h('span', { style: S.hint }, '写入 DSH credentials 服务；不会保存到配置文件'),
            ),
            h('div', { style: S.actions },
              h('button', {
                type: 'button',
                style: { ...S.primary, ...((!dirty && keyDraft.trim().length === 0) || !writable || busy ? S.disabled : {}) },
                disabled: (!dirty && keyDraft.trim().length === 0) || !writable || busy,
                onClick: save,
              }, busy ? '保存中…' : '保存'),
              h('button', {
                type: 'button',
                style: { ...S.secondary, ...((!dirty && keyDraft.trim().length === 0) || busy ? S.disabled : {}) },
                disabled: (!dirty && keyDraft.trim().length === 0) || busy,
                onClick: discard,
              }, '放弃修改'),
              h('button', { type: 'button', style: { ...S.secondary, ...(busy ? S.disabled : {}) }, disabled: busy, onClick: reload }, '重新读取'),
              h('button', {
                type: 'button',
                style: { ...S.secondary, ...(busy || testing ? S.disabled : {}) },
                disabled: busy || testing,
                onClick: testConnection,
              }, testing ? '测试中…' : '测试连接'),
              h('div', { style: S.spacer }),
              storedServiceAccount
                ? confirmClearSa
                  ? h('div', { style: S.confirmGroup },
                      h('span', { style: S.hintWarn }, '确认清除 Service Account 配置？'),
                      h('button', {
                        type: 'button',
                        style: { ...S.dangerConfirm, ...(busy ? S.disabled : {}) },
                        disabled: busy,
                        onClick: clearServiceAccount,
                      }, '确认清除'),
                      h('button', {
                        type: 'button',
                        style: { ...S.small, ...(busy ? S.disabled : {}) },
                        disabled: busy,
                        onClick: () => setConfirmClearSa(false),
                      }, '取消'),
                    )
                  : h('button', {
                      type: 'button',
                      style: { ...S.danger, ...(!writable || busy ? S.disabled : {}) },
                      disabled: !writable || busy,
                      onClick: () => setConfirmClearSa(true),
                    }, '清除 Service Account 配置')
                : null,
              props.keyConfigured === true
                ? confirmClear
                  ? h('div', { style: S.confirmGroup },
                      h('span', { style: S.hintWarn }, `确认清除 ${keyRef}？`),
                      h('button', {
                        type: 'button',
                        style: { ...S.dangerConfirm, ...(busy ? S.disabled : {}) },
                        disabled: busy,
                        onClick: removeKey,
                      }, '确认清除'),
                      h('button', {
                        type: 'button',
                        style: { ...S.small, ...(busy ? S.disabled : {}) },
                        disabled: busy,
                        onClick: () => setConfirmClear(false),
                      }, '取消'),
                    )
                  : h('button', {
                      type: 'button',
                      style: { ...S.danger, ...(!writable || busy ? S.disabled : {}) },
                      disabled: !writable || busy,
                      onClick: () => setConfirmClear(true),
                    }, '清除 API Key')
                : null,
            ),
            message === undefined ? null : h('span', { style: messageBad ? S.hintError : S.hintOk, role: 'status' }, message),
          ) : null,
        )
      }

      // DSH's row dot only reflects the API-key credential. Under service-account
      // auth a missing key is expected, so suppress that one misleading red dot
      // for this provider row; the card itself states the active auth mode.
      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const style = document.createElement('style')
        style.textContent = [
          'li:has([data-gemini-argon-config][data-auth="service-account"]) span[class*="credentialDotMissing"],',
          'li:has([data-gemini-argon-config][data-auth="service-account"]) span[aria-label="API key missing"],',
          'li:has([data-gemini-argon-config][data-auth="service-account"]) span[aria-label="API 密钥缺失"] { display: none !important; }',
        ].join('\n')
        document.head.appendChild(style)
        return () => style.remove()
      }, 'gemini-argon: api-key dot policy')

      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: NS,
      }, ProviderCard))), 'gemini-argon: model provider card')
    }

    return { inject, apply }
  },
})
