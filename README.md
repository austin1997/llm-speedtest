# LLM Speedtest

一个用于测试 LLM 部署性能的浏览器测速网站。支持 OpenAI 兼容 Chat Completions 与 Ollama 原生接口、A/B 同时对比、每端点 1–16 并发、流式输出、思考模式和明暗主题。

所有推理请求从用户浏览器直接发送到配置的端点。Cloudflare 仅托管前端静态资源。

## 本地运行

需要 Node.js 24 与 npm。

```bash
npm ci
npm run dev
```

打开 **http://localhost:5173**。开发服务器默认仅绑定回环地址。构建命令为 `npm run build`，产物位于 `dist/`。

默认使用本地 Ollama 的 `qwen3.6:latest`；点击端点摘要展开编辑模型名和地址。主界面左侧预览输入，中央 GO 开始测试，右侧调整长度和并发滑块；思考模式、温度和超时在“更多参数”中。点击模型框右侧的连接按钮获取模型列表；Ollama 同时会读取模型上下文上限和思考能力。测试完成后自动滚动到本轮结果。

## 配置端点

| 协议 | 地址示例 | 实际请求 |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | `POST /api/chat`，NDJSON |
| OpenAI 兼容 | `http://localhost:11434/v1` | `POST /v1/chat/completions`，SSE |
| 自部署 OpenAI 兼容 | `https://your-server.example/v1` | SSE，可选 Bearer API Key |

也接受完整 `/api/chat` 或 `/chat/completions` 地址，并保留自定义路径前缀。地址不能包含用户名、密码、查询参数或片段。

API Key 只保存在当前页面内存，刷新后清除；不会写入浏览器存储或构建产物。主题和其他配置保存在当前设备的 `localStorage`，不会上传。未配置推理代理、账号系统或云端测试历史。

OpenAI 兼容设置可切换输出上限字段 `max_tokens` / `max_completion_tokens`，也可以关闭 `stream_options.include_usage`。不支持参数时会显示服务返回的错误，不会在本轮测速自动重试。

### 思考模式

默认遵循服务配置。开启或关闭时：

- Ollama 发送 `think: true / false`。
- OpenAI `reasoning_effort` 格式发送 `medium / none`，适用于支持这些值的服务。
- Qwen 模板格式发送 `chat_template_kwargs.enable_thinking: true / false`，适用于支持该扩展的 vLLM / SGLang 等部署。

不同服务与模型的能力不同，OpenAI 兼容协议没有通用布尔思考开关。服务可能拒绝或忽略不支持的扩展，客户端无法保证其生效。返回的 `thinking`、`reasoning` / `reasoning_content` 与正文按到达顺序合并显示和统计；没有返回的思考文本不会补造。端点报告的输出 token 已包含推理时，不会再次相加。

### 输入与上下文

输入滑块使用固定英文语料；改变长度会改变预览内容。预览包含完整用户消息，A/B 与各并发请求发送同一文本。估算规则是 ASCII 约 4 字符 / token，其他字符约 1.5 字符 / token，不加载模型 tokenizer。

输入估算不包括服务端聊天模板。结束后以 `usage.prompt_tokens` 或 `prompt_eval_count` 展示实际输入用量；缺失时仍标明估算。

Ollama 的自动 `num_ctx` 为输入估算 + 输出上限 + 512 token 余量，向上取整到 1024 的倍数，最低 4096。可以手动覆盖。较长上下文或较高并发会占用更多内存。模型上下文上限已成功读取时，会阻止超过上限的配置。

输出长度是生成上限，模型可提前结束；客户端不追加请求来填满预算。

## 跨域与本地连接

Ollama 默认允许部分本地来源。部署网站访问本地 Ollama 时，需要将**网站来源**（协议、域名和端口，不含路径）加入 `OLLAMA_ORIGINS` 并重启 Ollama。例如，直接启动服务：

```bash
OLLAMA_ORIGINS="http://localhost:5173,https://llm-speedtest.YOUR-SUBDOMAIN.workers.dev" ollama serve
```

已有系统服务时，应在相应服务的环境变量中配置，然后重启现有服务，而不是重复启动 `ollama serve`。

OpenAI 兼容部署需要允许当前网站的 CORS 来源，并允许 `POST`、`GET`、`OPTIONS` 以及 `Content-Type`、需要时的 `Authorization` 请求头。不要使用 `no-cors`，否则浏览器无法读取响应流。

浏览器访问本地或局域网端点时，还可能需要授权本地网络访问。HTTPS 网站对部分 HTTP 地址的请求会受混合内容策略限制；浏览器行为不同。遇到错误时检查服务、地址、CORS、HTTPS 和权限，也可以在本机运行网站测试。网站不会尝试绕过这些浏览器规则。

官方说明：[Ollama CORS](https://docs.ollama.com/faq)、[Chrome 本地网络访问](https://developer.chrome.com/blog/local-network-access)。

## 指标定义

浏览器计时使用 `performance.now()`；每个请求在调用 `fetch` 前开始计时。

| 指标 | 口径 |
| --- | --- |
| 首字延迟 TTFT | 首段非空思考或正文到达减请求开始；忽略角色和空片段 |
| 实时吞吐 | 最近一秒正在接收的请求的合并输出估算 token 增量，单位 tok/s |
| 浏览器 decode | 首末文本片段之间的估算 token 增量 / 时间，排除首片段；只有一个片段时不可计算 |
| 服务端 decode | Ollama `eval_count / eval_duration × 10⁹`，独立于浏览器指标 |
| 服务端 prefill | Ollama `(prompt_eval_count - prompt_eval_cached_count) / prompt_eval_duration × 10⁹`；缺失缓存计数时按 0 处理 |
| 模型加载 | Ollama `load_duration` 转为毫秒 |
| 请求总耗时 | 从发送到流正常完成，包括网络、排队、加载和尾部用量事件 |
| 整轮吞吐 | 成功请求输出 token 总数 / 端点最早请求开始至最后请求结束的墙钟时间 |
| 输入 / 输出用量 | 优先采用端点报告，缺失则显示估算；不把响应片段数当作 token 数 |

整轮吞吐的时间包括失败或取消请求占用的时间；它们的输出不进入成功总量。延迟和 decode 均值 / 最小值 / 最大值仅包含成功且具有有效指标的请求。缺失或零时间指标显示 `—`。

所有指标显示“端点报告”“浏览器测量”或“估算”。A/B 只比较相同口径，整体吞吐的 token 来源不同时不计算百分比。不同模型的 tokenizer 会影响估算误差。浏览器 decode 永远保留估算标记，不用服务 token 总数推断每个流片段的真实 token 数。

并发 N 指客户端每端点同时发起 N 个独立请求；A/B 共 2N 个。浏览器连接限制与服务排队会影响实际并行数和端到端延迟。对比同一设备上的两个模型时，共享资源和模型换入换出也会影响结果。重复测试可能命中提示缓存或已驻留模型；缓存和加载数据可在结果中查看。

## 验证

```bash
npm run check                 # 类型、协议/指标/执行测试、生产构建
npx playwright install chromium
npm run test:e2e              # 使用本地流式测试端点，不需要模型或密钥
npm run deploy:check          # Wrangler 部署预检，不发布
```

浏览器测试覆盖预览与请求一致性、两个协议同时并发、停止、失败、再次测试、凭据不持久化、模型发现、主题与窄屏。界面截图位于忽略的 `test-results/`。

本地真实 Ollama 验证为显式选择，会执行推理并加载模型：

```bash
npm run test:ollama
# 可选自定义本地地址：
OLLAMA_URL=http://localhost:11434 npm run test:ollama
```

需要已安装 `qwen3.6:latest` 与 `qwen3:30b-a3b-q4_K_M`。测试分别验证思考开启 / 关闭，然后用 `qwen3.6:latest` 同时测试 Ollama 与 OpenAI 兼容协议，各并发 2。每请求输入约 128 token、输出上限 64，不下载模型，也不修改 Ollama 配置。

## Cloudflare Workers 与 GitHub Actions

`wrangler.jsonc` 使用 Workers Static Assets 托管 `dist/`，提供 SPA fallback，不运行推理服务。静态资源请求符合 Workers 的免费托管模式；LLM 服务本身可能有费用，具体取决于所选端点。[Cloudflare 静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

GitHub Actions 工作流在 PR 和 `main` push 时执行检查、浏览器测试与部署预检。部署设置：

1. 在 GitHub 仓库 Secrets 中配置 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。API Token 应具有目标账户的 Workers 部署权限。
2. 手动运行 **Validate and deploy** 工作流，会在所有检查成功后部署。
3. 若需 `main` 自动部署，添加仓库变量 `ENABLE_CLOUDFLARE_DEPLOY=true`。未启用时 `main` 只验证。
4. 如需更换 Worker 名称，修改 `wrangler.jsonc` 的 `name`；首次部署后将实际网站来源加入端点 CORS。

本地发布命令是 `npm run deploy`，需要先配置 Cloudflare 登录或对应环境变量。`npm run deploy:check` 只做预检，不发布。

[Cloudflare GitHub Actions 指南](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

## 代码结构

- `src/lib/`：输入生成、协议适配、测速执行和指标计算。
- `src/App.tsx` 与 `src/styles.css`：配置、测速、结果及响应式主题界面。
- `tests/`：单元测试、浏览器测试与本地 Ollama 集成测试。
- `.github/workflows/ci.yml`：验证与可选部署。
