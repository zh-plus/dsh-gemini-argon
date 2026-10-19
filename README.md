# dsh-gemini-argon

> 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中接入 **Gemini 4 Argon**（Google Vertex AI）。

[![npm](https://img.shields.io/npm/v/dsh-gemini-argon.svg)](https://www.npmjs.com/package/dsh-gemini-argon)
[![license](https://img.shields.io/npm/l/dsh-gemini-argon.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

`dsh-gemini-argon` 是专为 DeepSeek Harness 打造的 LLM provider 插件。它注册了独立的 `gemini-argon` 路由，通过 Vertex AI 原生的 `streamGenerateContent` 接口接入 `gemini-4-argon` 模型，完整支持流式输出、多轮工具调用、思考摘要与 Token 用量统计；认证既支持 **Express API Key**，也支持 **service account JSON 密钥**。

## 为什么需要独立插件？

DSH 内置的 `google-vertex` 路由基于 `pi-ai` 的静态模型目录，尚未包含 `gemini-4-argon`。此外，直接接入该模型还面临两个关键的协议限制：

1. **区域路由限制**：使用 Express API Key 访问简写路径 `/v1/publishers/google/models/...` 时，请求会被自动路由到该 Key 的默认区域（如 `asia-southeast1`）。但 `gemini-4-argon` 仅在 `global` 区域可用，必须显式拼接完整路径 `projects/{project}/locations/global/...`。
2. **工具调用签名校验**：`gemini-4-argon` 在多轮对话中回放工具调用历史时，强制要求携带 `thoughtSignature`。标准的 OpenAI 兼容层无法传递该字段，会导致第二轮工具请求直接返回 `400` 错误。

本插件基于 Vertex AI 原生协议针对性地解决了上述问题，从而能够稳定运行多轮工具调用循环。

## 核心特性

- **流式输出与思考摘要**：支持流式文本生成与思考过程输出（`thinkingLevel` 可配置为 `off` / `low` / `medium` / `high`；`off` 为最低档 `LOW` 且不展示思考内容）。
- **原生多轮工具调用**：基于原生 function calling，完整回放原生 parts 与 `thoughtSignature`，思考模式下也能稳定续接。
- **图片输入**：用户消息和工具结果中的图片会按路由预算缩放，并以 Gemini `inlineData` 发送。
- **跨 Provider 工具历史**：来自其他模型的工具调用没有 Gemini 签名，插件会自动降级为文本，切换模型不再触发 400。
- **流式稳定性**：长时间收不到数据会以 `TIMEOUT` 失败并交给重试策略，不会无限挂起。
- **可视化配置**：在 **Settings → Models** 的 provider 卡片里直接编辑项目、认证、模型、思考档位、代理和 API Key。
- **精细化用量统计**：完整统计输入、输出、思考 token 以及缓存命中情况。
- **智能代理探测**：支持从环境变量、macOS 系统代理（`scutil`）自动探测代理，或通过配置显式指定。
- **API Key 凭据**：默认接入 DSH 的 credentials 服务，同时支持通过启动环境变量注入。
- **Service Account 支持**：读取 service account JSON（文件、内联或 `GOOGLE_APPLICATION_CREDENTIALS`），自动完成 OAuth2 JWT 交换、access token 缓存与刷新。
- **结构化错误分类**：精准识别并分类认证失败、配额耗尽、触发限流、上下文超限及非法请求等错误。

## 快速开始

### 1. 安装插件

```sh
# 通过 npm 安装（推荐）
dsh plugin --profile desktop add dsh-gemini-argon

# 或固定到 GitHub 上的某个 tag
dsh plugin --profile desktop add github:zh-plus/dsh-gemini-argon#v0.6.3

# 或从本地开发目录安装
dsh plugin --profile desktop add file:/path/to/dsh-gemini-argon
```

> **注意**：安装完成后请**重启 DeepSeek Harness**（profile 的 bundle 列表仅在启动时加载）。

### 2. 在 Settings → Models 中配置（推荐）

重启后打开 **Settings → Models**，在 **Google Vertex AI** 这一行点 **编辑配置**，即可直接修改：

- `project`、`auth`、`apiKeyEnv`、`serviceAccountFile`
- `model` / `modelName`、`thinkingLevel`、`proxy`
- 高级项：`location`、`baseURL`、`contextWindow`、`maxTokens`、`streamIdleTimeoutMs`、`imageMaxPixels`、`imageMaxBytes`
- API Key 输入框（写入 `GOOGLE_VERTEX_API_KEY`，也可清除）

保存后写入 profile 的 `cordis.patch.yml`，下一次模型请求生效，无需重启。内联的 `serviceAccountJson` 刻意没有放进 UI（避免私钥明文进配置），需要时仍可通过文件或 `GOOGLE_APPLICATION_CREDENTIALS`。

**Service Account JSON 路径**一栏旁边有 **浏览…** 按钮：桌面端会调起系统文件选择器（只接受 `.json`），选中后填入文件的绝对路径；内容不会被读取或上传，只存路径。CLI / 远程连接等没有桌面文件桥的环境仍可手动输入，支持 `~`。

下面的 YAML 写法适用于 CLI / headless，或想直接编辑配置文件的情况。

### 3. 配置 Google Cloud Project

#### `project` 是什么？

Google Cloud 项目有两个等价标识，Vertex 的 `projects/{project}` 路径两者都接受，插件也都支持：

- **Project ID**：字母数字和连字符，例如 `my-argon-project-123456`
- **Project Number**：纯数字，例如 `397502380865`

你在配置里看到的一串数字就是 **Project Number**，不是随机数。Express API Key 本身不携带 project 信息，最初的数字是从 Vertex 返回的 404 错误里读到的：

```
Publisher model `projects/397502380865/locations/asia-southeast1/...`
```

#### 怎么拿到自己的 project？

1. **Cloud Console**：顶部项目选择器选中项目，打开项目信息卡即可看到 Project ID 和 Project number。也可以直接打开
   `https://console.cloud.google.com/home/dashboard?project=<PROJECT_ID>`，在 “Project info” 卡片里查看。
2. **gcloud**：

   ```sh
   gcloud config get-value project
   # 输出 Project ID

   gcloud projects describe "$(gcloud config get-value project)" \
     --format='value(projectNumber)'
   # 输出 Project Number
   ```

3. **Service Account JSON**：文件里的 `project_id` 就是项目 ID，使用 JSON 密钥时插件会自动读取，不需要再填。
4. **只有 Express Key**：Key 不直接暴露 project。如果不知道它属于哪个项目，用这个 Key 调一次 Vertex，错误信息里通常会带 `projects/<number>`；也可以到创建该 Key 的 Cloud Console / AI Studio 项目里查。

填 Project ID 或 Project Number 都可以，注意不要带空格或多余字符。`project` 不是密钥，但仍属于账号信息，公开仓库里不要写死。

#### 配置来源

插件支持以下任一来源（优先级从高到低）：

1. profile 补丁或 **Settings → Models** 里的 `project`；
2. service account JSON 里的 `project_id`（使用 JSON 密钥时自动读取）；
3. 环境变量 `GOOGLE_CLOUD_PROJECT`。

都没有时，插件会在加载阶段直接报错，避免把请求发到错误区域。使用 API Key 时在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里补：

```yaml
- id: llm-gemini-argon
  name: "dsh-gemini-argon"
  config:
    project: "your-google-cloud-project"
```

### 4. 配置认证

插件支持两种认证方式，按需选一种即可。`auth: auto`（默认）在检测到 service account 时优先使用 JSON 密钥，否则使用 API Key；也可以用 `auth: api-key` / `auth: service-account` 强制指定。

#### 方式 A：Express API Key

打开 **Settings → Models**，在 `GOOGLE_VERTEX_API_KEY` 项中填入你的 Vertex AI Express API Key。DSH 会将其安全保存至 `$DSH_HOME/.credentials.yaml`。

在 CLI 或 headless 模式下，也可以直接通过环境变量传入：

```sh
GOOGLE_VERTEX_API_KEY=... dsh --profile <name> "..."
```

#### 方式 B：Service Account JSON

把你的 service account 密钥 JSON 放在本机（**不要提交进 Git**），然后在 profile 补丁里指定文件路径：

```yaml
- id: llm-gemini-argon
  name: "dsh-gemini-argon"
  config:
    auth: service-account
    serviceAccountFile: "~/.config/gcloud/argon-sa.json"
```

也支持：

- 内联 JSON：`serviceAccountJson: '{"type":"service_account",...}'`（会以明文保存在 profile 配置里，不推荐）；
- 标准环境变量：`GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`（`auth: auto` 会自动启用）；
- 项目号：默认取 JSON 的 `project_id`，也可用 `project` 覆盖。

插件会用私钥签一个 RS256 JWT，向 `token_uri` 换取 OAuth2 access token，再以 `Authorization: Bearer` 调用 Vertex；token 会缓存到过期前 5 分钟并自动刷新，收到 401 时会刷新一次并重试。service account 需要具备 Vertex AI 调用权限（例如 `Vertex AI User`），并且项目已启用 Vertex AI API。

### 5. 选择模型

重启应用后，在模型选择器中选择 **Gemini 4 Argon**（Provider 显示为 `Google Vertex AI`，路由 ID 为 `gemini-argon`）。

## 配置参考

插件 bundle 内置的默认配置如下：

```yaml
- insert:
    - id: llm-gemini-argon
      name: "dsh-gemini-argon"
      config:
        auth: auto
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
| `auth` | `auto` | 认证方式：`auto` / `api-key` / `service-account`。`auto` 在检测到 service account 时优先使用 JSON 密钥。 |
| `apiKeyEnv` | `GOOGLE_VERTEX_API_KEY` | API Key 的凭据引用。仅在 API Key 模式下使用；优先从 credentials 服务解析，未命中时回退到启动环境变量。 |
| `serviceAccountFile` | 空 | service account JSON 文件路径，支持 `~`。未设置时回退到 `GOOGLE_APPLICATION_CREDENTIALS`。 |
| `serviceAccountJson` | 空 | 内联 service account JSON。会以明文形式保存在 profile 配置中，仅建议在临时环境使用。 |
| `project` | 空（必填） | Google Cloud 项目编号或 ID。优先级：`project` > service account 的 `project_id` > `GOOGLE_CLOUD_PROJECT`。 |
| `location` | `global` | 模型所在区域。`gemini-4-argon` 仅在 `global` 提供，设为其他区域会导致 `404`。 |
| `baseURL` | `https://aiplatform.googleapis.com` | API 基础地址，可根据测试需求或私有网关进行修改。 |
| `model` | `gemini-4-argon` | Vertex 发布模型 ID。 |
| `modelName` | `Gemini 4 Argon` | 在模型选择器中展示的名称。 |
| `contextWindow` | `1048576` | 模型上下文窗口大小。 |
| `maxTokens` | `65536` | 默认最大输出 Token 数。 |
| `streamIdleTimeoutMs` | `300000` | 流式响应允许的最长无数据间隔；超时以 `TIMEOUT` 失败，交给重试策略。 |
| `imageMaxPixels` | `4194304` | 单张请求图片的最大像素数，超过时由 attachment 层等比缩放。 |
| `imageMaxBytes` | `2097152` | 单张请求图片的编码字节目标。 |
| `thinkingLevel` | `off` | 思考级别。`off` 固定为模型支持的最低档 `LOW` 且不返回思考内容（4 Argon 无法真正关闭思考）；`low` / `medium` / `high` 会返回并展示思考摘要。 |
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

- **认证方式**：API Key 模式通过 `x-goog-api-key` 请求头认证；service account 模式先用 RS256 JWT 向 `token_uri` 换取 OAuth2 access token，再以 `Authorization: Bearer` 调用 Vertex。
- **流式解析**：按 SSE 协议解析响应流，将每个数据块实时转换为 DSH 标准事件（`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / `finish`）。
- **状态与签名回放**：每次收到响应后，插件会把原生 parts（文本、思考、functionCall、`thoughtSignature`）和每个 block 的签名存入 DSH 的 `replayState`；下一轮原样回放。没有 Gemini 签名的历史工具调用会降级为 `[Tool call ...]` / `[Tool result ...]` 文本，避免 Vertex 400。
- **图片**：按 `imageMaxPixels` / `imageMaxBytes` 生成请求版本，再以 `inlineData`（base64 + MIME）发送；已 offload 的图片会变成文本占位符。
- **稳定性**：每收到一个数据块都会重置 idle 计时器；超时中止请求并报 `TIMEOUT`（默认重试策略会重试）。
- **网络与代理**：请求底层基于 `undici` 的 `ProxyAgent` 发出。代理探测优先级为：`proxy` 显式配置 > `HTTPS_PROXY` / `ALL_PROXY` 等环境变量 > macOS `scutil --proxy` > 直连。

## 已知限制

- **认证方式**：支持 Express API Key 和 service account JSON；不支持 metadata server / Workload Identity Federation 自动发现。
- **图片范围**：只支持用户消息和工具结果中的图片；图片会按 `imageMaxPixels` / `imageMaxBytes` 等比缩放，超大图会损失细节。
- **思考成本**：Gemini 4 Argon 不支持真正关闭思考（`thinkingBudget: 0` 会被拒绝，`OFF` 不是合法级别）。`off` 会固定到最低档 `LOW` 并隐藏思考内容；档位越高，延迟和输出 token 越多。极长的思考仍可能触发 idle timeout，可调大 `streamIdleTimeoutMs`。
- **跨模型切换**：其他 Provider 产生的工具调用会降级为文本以保持会话可用，原生 `functionCall` / `thoughtSignature` 语义会丢失（工具结果仍然保留）。

## 常见问题 (FAQ)

### 404 `Publisher model ... was not found`
通常是区域配置有误。Express Key 的简写路径会默认路由到特定区域，而 `gemini-4-argon` 仅部署在 `global`。请确认已正确配置 `project`，且 `location` 保持为 `global`。

### 401 `API keys are not supported by this API`
说明当前用 API Key 发了请求，但该端点只接受 OAuth2 凭据。检查 `auth` 是否被固定为 `api-key`；如果该环境提供的是 service account JSON，改为 `auth: service-account` 或直接配置 `serviceAccountFile`。

### 能完全关闭思考吗？

不能。`gemini-4-argon` 不接受 `thinkingBudget: 0`，也没有 `OFF` 档位。把 `thinkingLevel` 设为 `off` 时，插件会发送最低档 `LOW` 并关闭 `includeThoughts`：不会显示思考内容，内部思考也降到当前模型允许的最低水平。想要思考摘要就选 `low` / `medium` / `high`。

### 请求一直挂起不返回

先看是不是网络：Node.js 原生 `fetch` 不会自动读取 macOS 系统代理，请确认 `proxy` 为 `auto`（默认）或显式代理。若网络正常但仍无数据，插件会在 `streamIdleTimeoutMs`（默认 5 分钟）后以 `TIMEOUT` 中止并交给重试策略；思考任务较多时可适当调大该值。

### 400 `Function call is missing a thought_signature`

说明有一个 Gemini 生成的工具调用丢了签名（例如手动裁剪了 `replayState`、会话被外部编辑）。其他 Provider 产生的工具调用不会触发该错误：插件会自动降级为文本。若确认是 Gemini 自己的历史被破坏，只能新建会话或让该工具调用重新执行一次。

### `MISSING_CREDENTIAL`
未能解析到有效的 API Key。请前往 **Settings → Models** 重新填写，或在启动环境中导出 `GOOGLE_VERTEX_API_KEY`；如果使用 service account，确认 `serviceAccountFile` 路径可读。

### 400 `invalid_grant` / `invalid JWT signature`
service account 私钥与 `client_email` 不匹配、系统时间偏差过大，或密钥已被撤销。检查 JSON 是完整的密钥文件、校准系统时间；轮换密钥后重启应用。

### 图片没有生效或报 `UNSUPPORTED_CONTENT`
确认当前 profile 挂载了 attachment 服务（官方 desktop/web profile 默认有）；图片只能出现在用户消息或工具结果中；同时检查 `imageMaxPixels` / `imageMaxBytes` 是否被设得过小。

### `project is required`
缺少 Google Cloud 项目配置。请在 profile 补丁文件中补充 `project` 字段、在 service account JSON 中提供 `project_id`，或导出 `GOOGLE_CLOUD_PROJECT`。

## 开发与测试

### 独立冒烟测试

离线认证测试（自动生成 RSA 密钥、启动 mock OAuth2 和 mock Vertex 服务，不需要真实凭据与网络）：

```sh
node test/service-account.test.mjs
```

离线图片 / 降级 / 超时测试（mock attachment 和 mock Vertex，验证 inlineData、跨 Provider 降级与 idle timeout）：

```sh
node test/images-and-degrade.test.mjs
```

真实调用测试（会访问 Vertex，覆盖文本、图片、工具调用、工具结果回放与跨 Provider 工具历史）：

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

- 本仓库不包含任何硬编码的 API Key、项目编号、代理地址或 service account 私钥。
- API Key 仅保存在本地 `$DSH_HOME/.credentials.yaml` 中，请勿将该文件提交至 Git。
- service account JSON 包含私钥：建议文件权限设为 `600`，绝不提交进仓库；优先使用 `serviceAccountFile` 或 `GOOGLE_APPLICATION_CREDENTIALS`，避免把私钥内联到 `serviceAccountJson`。
- 在发布 npm 包之前，建议先执行 `npm pack --dry-run` 检查打包内容，防止敏感信息泄露。

## License

[MIT](./LICENSE)