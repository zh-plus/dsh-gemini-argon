# dsh-gemini-argon

> 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中接入 **Gemini 4 Argon**（Google Vertex AI）。

[![npm](https://img.shields.io/npm/v/dsh-gemini-argon.svg)](https://www.npmjs.com/package/dsh-gemini-argon)
[![license](https://img.shields.io/npm/l/dsh-gemini-argon.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

`dsh-gemini-argon` 是专为 DeepSeek Harness 打造的 LLM provider 插件。它注册了独立的 `gemini-argon` 路由，通过 Vertex AI 原生的 `streamGenerateContent` 接口接入 `gemini-4-argon` 模型，完整支持流式输出、多轮工具调用、思考摘要与 Token 用量统计。

## 为什么需要独立插件？

DSH 内置的 `google-vertex` 路由基于 `pi-ai` 的静态模型目录，尚未包含 `gemini-4-argon`。此外，直接接入该模型还面临两个关键的协议限制：

1. **区域路由限制**：使用 Express API Key 访问简写路径 `/v1/publishers/google/models/...` 时，请求会被自动路由到该 Key 的默认区域（如 `asia-southeast1`）。但 `gemini-4-argon` 仅在 `global` 区域可用，必须显式拼接完整路径 `projects/{project}/locations/global/...`。
2. **工具调用签名校验**：`gemini-4-argon` 在多轮对话中回放工具调用历史时，强制要求携带 `thoughtSignature`。标准的 OpenAI 兼容层无法传递该字段，会导致第二轮工具请求直接返回 `400` 错误。

本插件基于 Vertex AI 原生协议针对性地解决了上述问题，从而能够稳定运行多轮工具调用循环。

## 核心特性

- **流式输出与思考摘要**：支持流式文本生成与思考过程输出（`thinkingLevel` 可配置为 `off` / `low` / `medium` / `high`）。
- **原生多轮工具调用**：基于原生 function calling，在多轮对话中自动保存并回放 `thoughtSignature`。
- **精细化用量统计**：完整统计输入、输出、思考 token 以及缓存命中情况。
- **智能代理探测**：支持从环境变量、macOS 系统代理（`scutil`）自动探测代理，或通过配置显式指定。
- **灵活的凭据管理**：默认接入 DSH 的 credentials 服务，同时支持通过启动环境变量注入。
- **结构化错误分类**：精准识别并分类认证失败、配额耗尽、触发限流、上下文超限及非法请求等错误。

## 快速开始

### 1. 安装插件

```sh
# 通过 npm 安装（推荐）
dsh plugin --profile desktop add dsh-gemini-argon

# 或固定到 GitHub 上的某个 tag
dsh plugin --profile desktop add github:zh-plus/dsh-gemini-argon#v0.2.0

# 或从本地开发目录安装
dsh plugin --profile desktop add file:/path/to/dsh-gemini-argon
```

> **注意**：安装完成后请**重启 DeepSeek Harness**（profile 的 bundle 列表仅在启动时加载）。

### 2. 配置 Google Cloud Project

由于 Express API Key 本身不包含项目信息，必须显式指定 `project`。请编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 并添加以下配置：

```yaml
- id: llm-gemini-argon
  name: "dsh-gemini-argon"
  config:
    project: "your-google-cloud-project"
```

你也可以选择在环境中导出 `GOOGLE_CLOUD_PROJECT` 变量。若未配置 `project`，插件会在加载阶段直接报错拦截，避免将请求发送到错误的区域。

### 3. 配置 API Key

打开 **Settings → Models**，在 `GOOGLE_VERTEX_API_KEY` 项中填入你的 Vertex AI Express API Key。DSH 会将其安全保存至 `$DSH_HOME/.credentials.yaml`。

在 CLI 或 headless 模式下，也可以直接通过环境变量传入：

```sh
GOOGLE_VERTEX_API_KEY=... dsh --profile <name> "..."
```

### 4. 选择模型

重启应用后，在模型选择器中选择 **Gemini 4 Argon**（Provider 显示为 `Google Vertex AI`，路由 ID 为 `gemini-argon`）。

## 配置参考

插件 bundle 内置的默认配置如下：

```yaml
- insert:
    - id: llm-gemini-argon
      name: "dsh-gemini-argon"
      config:
        apiKeyEnv: GOOGLE_VERTEX_API_KEY
        location: global
        model: gemini-4-argon
        modelName: Gemini 4 Argon
        contextWindow: 1048576
        maxTokens: 65536
        thinkingLevel: "off"
```

### 配置项说明

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `GOOGLE_VERTEX_API_KEY` | 凭据环境变量名。优先从 credentials 服务解析，未命中时回退到启动环境变量。 |
| `project` | 空（**必填**） | Google Cloud 项目编号或 ID；也可通过环境变量 `GOOGLE_CLOUD_PROJECT` 指定。 |
| `location` | `global` | 模型所在区域。`gemini-4-argon` 仅在 `global` 提供，设为其他区域会导致 `404`。 |
| `baseURL` | `https://aiplatform.googleapis.com` | API 基础地址，可根据测试需求或私有网关进行修改。 |
| `model` | `gemini-4-argon` | Vertex 发布模型 ID。 |
| `modelName` | `Gemini 4 Argon` | 在模型选择器中展示的名称。 |
| `contextWindow` | `1048576` | 模型上下文窗口大小。 |
| `maxTokens` | `65536` | 默认最大输出 Token 数。 |
| `thinkingLevel` | `off` | 思考模式级别。设为非 `off` 时会发送 `thinkingConfig` 并在多轮对话中回放思考 parts。 |
| `proxy` | `auto` | 代理策略。`auto` 会依次读取环境变量和 macOS 系统代理；也可设为 `direct`（直连）或具体的代理 URL。 |

### 自定义配置覆盖

你可以在 profile 的补丁文件（`cordis.patch.yml`）中通过相同 `id` 覆盖或扩展默认配置：

```yaml
- id: llm-gemini-argon
  name: "dsh-gemini-argon"
  config:
    project: "your-google-cloud-project"
    thinkingLevel: low
    proxy: "http://127.0.0.1:7897"
```

## 工作原理

插件会将请求发送至以下 Vertex AI 原生端点：

```
{baseURL}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse
```

- **认证方式**：通过请求头 `x-goog-api-key` 传递凭据，专为 Vertex Express Key 设计。
- **流式解析**：按 SSE 协议解析响应流，将每个数据块实时转换为 DSH 标准事件（`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / `finish`）。
- **状态与签名回放**：每次收到响应后，插件会将原生 parts 及每个 block 的 `thoughtSignature` 存入 DSH 的 `replayState`；在下一轮对话中将签名原样回放，从而避免工具调用触发 `400` 错误。
- **网络与代理**：请求底层基于 `undici` 的 `ProxyAgent` 发出。代理探测优先级为：`proxy` 显式配置 > `HTTPS_PROXY` / `ALL_PROXY` 等环境变量 > macOS `scutil --proxy` > 直连。

## 已知限制

- **认证方式**：仅支持 Express / API Key 认证，暂不支持 `gcloud` ADC（应用默认凭据）或服务账号 JSON 密钥。
- **输入模态**：当前输入模态声明为纯文本，图片输入会被 DSH 转换为文本占位符。
- **思考模式稳定性**：开启思考模式（`thinkingLevel` 非 `off`）时，包含工具调用历史的长会话偶发响应卡顿，因此默认设为关闭。
- **跨模型切换**：从其他 Provider 切换到本模型时，由于历史工具调用记录缺少 Gemini 专属签名，请求可能会被接口拒绝。建议在长工具会话中固定使用 Gemini 4 Argon。

## 常见问题 (FAQ)

### 404 `Publisher model ... was not found`
通常是区域配置有误。Express Key 的简写路径会默认路由到特定区域，而 `gemini-4-argon` 仅部署在 `global`。请确认已正确配置 `project`，且 `location` 保持为 `global`。

### 401 `API keys are not supported by this API`
说明请求误走了 OpenAI 兼容层或使用了 `Authorization: Bearer` 认证头。本插件采用原生 `generateContent` 接口配合 `x-goog-api-key` 认证，无需更换 Key，请检查路由是否已正确切换至 `gemini-argon`。

### 请求一直挂起不返回
绝大多数情况属于网络连通性问题。Node.js 原生 `fetch` 不会自动读取 macOS 系统代理。请确保 `proxy` 保持为 `auto`（默认）或显式指定代理地址（如 `http://127.0.0.1:7897`），修改后重启应用。

### 400 `Function call is missing a thought_signature`
会话历史中的工具调用缺少签名信息。通常发生在从其他 Provider 中途切换至本模型，或手动裁剪了 `replayState` 时。进行多轮工具调用时，建议全程固定使用 Gemini 4 Argon。

### `MISSING_CREDENTIAL`
未能解析到有效的 API Key。请前往 **Settings → Models** 重新填写，或在启动环境中导出 `GOOGLE_VERTEX_API_KEY`。

### `project is required`
缺少 Google Cloud 项目配置。请在 profile 补丁文件中补充 `project` 字段，或在环境变量中导出 `GOOGLE_CLOUD_PROJECT`。

## 开发与测试

### 独立冒烟测试

无需启动 DSH，直接运行 adapter 进行测试（会真实调用 Vertex 接口，覆盖文本生成、工具调用及工具结果回放）：

```sh
GKEY=... GOOGLE_CLOUD_PROJECT=... node --preserve-symlinks test/live.test.mjs
```

> **提示**：运行测试需确保当前目录能够解析到 `@deepseek-ai/dsh-llm` 和 `undici`（例如将其放置在 DSH 安装目录的 `node_modules` 下执行）。

### 端到端验证

使用 headless profile 进行端到端测试（会真实调用模型并执行本地 bash 工具）：

```sh
dsh --profile argon --from-default-profile headless --help
dsh plugin --profile argon add file:/path/to/dsh-gemini-argon
GOOGLE_VERTEX_API_KEY=... dsh --profile argon --json "Run: echo hi"
```

### 本地开发注意事项

在 pnpm 机制下，`file:` 协议安装的依赖属于硬链接副本。修改插件源码后，需要先提升 `package.json` 中的 `version` 版本号，再执行一次 `remove` + `add` 才能生效。**请勿使用 `link:` 协议**，否则会导致运行时导入 `undici` 失败。

## 安全说明

- 本仓库不包含任何硬编码的 API Key、项目编号或代理地址。
- API Key 仅保存在本地 `$DSH_HOME/.credentials.yaml` 中，请勿将该文件提交至 Git。
- 在发布 npm 包之前，建议先执行 `npm pack --dry-run` 检查打包内容，防止敏感信息泄露。

## License

[MIT](./LICENSE)