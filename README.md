# LLM Speedtest

一个用于测试 LLM 部署性能的浏览器测速网站。支持 OpenAI 兼容 Chat Completions 与 Ollama 原生接口、A/B 同时对比、每端点 1–16 并发、流式输出、思考模式和明暗主题。

所有推理请求从用户浏览器直接发送到配置的端点。Cloudflare 托管前端静态资源；完成数据库迁移后，测速结束时可以把汇总结果写入 D1。

## 本地运行

需要 Node.js 24 与 npm。

```bash
npm ci
npm run dev
```

打开 **http://localhost:5173**。开发服务器默认仅绑定回环地址。构建命令为 `npm run build`，产物位于 `dist/`。

默认使用本地 Ollama 的 `qwen3.6:latest`；点击端点摘要展开编辑模型名和地址。主界面左侧预览输入，中央 GO 开始测试，右侧调整长度和并发滑块；思考模式、温度和超时在“更多参数”中。点击模型框右侧的连接按钮获取模型列表；Ollama 同时会读取模型上下文上限和思考能力。全部请求结束后，实时页保留最终指标和输出一秒，再切换至本轮结果；这一秒不计入测速耗时。输出与曲线默认折叠，点击可查看。

宽屏下三个阶段都按屏幕高度分配空间。配置页保留左侧预览、中央 GO 和右侧滑块；实时页展示放大的吞吐仪表、指标、趋势和自适应并发窗口；结果页默认只显示汇总，逐请求数据及沿用实时布局的输出曲线均按需展开。长输出及展开详情在各自区域内滚动，不自动滚动页面。较窄或较矮的窗口恢复纵向布局，保持文本和控件可读。

页面宽度、GO、仪表、文字和表格行高会随浏览器尺寸伸缩；参数区和结果表使用可用高度，并发窗口最后一排自动补齐空位，减少大屏留白。

宽屏双端点实时测速在标题旁显示双车竞速：每条赛道预算为输出上限 × 每端点并发数，生成中的输出使用 token 估算，已结束请求使用端点报告的真实用量。思考与正文合并计入距离。右侧数字在每个请求结束时校准；仍有请求在生成或缺失用量时，合计保留估算标记。赛车保留已显示的最远位置；校准后的合计低于车的位置时暂停前进，直到后续输出追平后才继续，车不会回退。提前结束、失败或取消时停车，未达到预算不会自动补跑到终点。

首个全部并发请求成功完成的端点，在数字右侧亮起“1st”；仅估算冲线不授予标记。亮起动画持续 1.4 秒，切换结果页需同时满足全部请求结束后的一秒停留和动画完成，不计入测速耗时。单端点与窄屏不展示赛道，减少动态效果模式直接亮起；隐藏或取消动画不会阻止进入结果页。

## 配置端点

| 协议 | 地址示例 | 实际请求 |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | `POST /api/chat`，NDJSON |
| OpenAI 兼容 | `http://localhost:11434/v1` | `POST /v1/chat/completions`，SSE |
| 自部署 OpenAI 兼容 | `https://your-server.example/v1` | SSE，可选 Bearer API Key |

也接受完整 `/api/chat` 或 `/chat/completions` 地址，并保留自定义路径前缀。地址不能包含用户名、密码、查询参数或片段。

每个端点可设置一个可选别名，配置摘要、实时监控、赛车和结果均显示该别名。别名仅影响界面，不改变请求中的模型名；留空时沿用原来的名称。别名与其他非敏感配置一起保存在本机，较长名称在紧凑区域省略显示，悬停可查看全文。

API Key 只保存在当前页面内存，刷新后清除，不会写入浏览器存储或构建产物。主题和其他非敏感配置保存在当前设备的 `localStorage`。未配置推理代理或账号系统。若部署启用了测速记录且页面上的“记录结果”保持开启，结束后会把端点地址、API Key 和汇总指标发送到本站 Worker。详见下文“测速记录”。

OpenAI 兼容设置可切换输出上限字段 `max_tokens` / `max_completion_tokens`，也可以关闭 `stream_options.include_usage`。不支持参数时会显示服务返回的错误，不会在本轮测速自动重试。

### 实时 token API 校准

OpenAI 兼容端点默认启用 token API 校准。在“兼容与上下文设置”中可关闭、手动检测，并调整校准间隔（8–512 token，默认 32）。GO 会在正式推理前检测计数接口，也可再次点击取消检测。修改地址、模型或 API Key 会清除检测结果；检测结果只留在页面内存，开关与间隔保存在本机。

支持 vLLM 的 `POST /tokenize`（`prompt`、`add_special_tokens:false`）、llama.cpp 的 `POST /tokenize`（`content`、`add_special:false`），以及带 `/v1` 或自定义路径前缀的变体。还会检测 `POST /v1/responses/input_tokens`，并优先使用原文本分词接口。[vLLM 协议](https://github.com/vllm-project/vllm/blob/main/vllm/entrypoints/serve/tokenize/protocol.py)、[llama.cpp 文档](https://github.com/ggml-org/llama.cpp/tree/master/tools/server#post-tokenize-tokenize-a-given-text)

按新增 token 数批量查询累计的可见输出，而不是把每个 chunk 独立分词后相加，这样可处理跨 chunk 的词边界。首次用字符估算判断间隔，之后利用计数结果校准估算比例；查询间的进度与速率仍含估算。计数增量按原始片段到达时间校准近期样本，不把 API 返回延迟造成的批量增量当成瞬时吞吐。每端点最多两个计数查询在途，相同前缀可复用结果。额外请求可能影响被测服务负载，关闭此选项可比较计数开销。

Responses 的输入计数包含消息结构。使用相同 assistant 消息结构的空文本作为基线，按差值校准，标记为“API 校准（含估算）”，不宣称是实际生成 usage。原文本分词标记为“端点分词”；隐藏推理、格式与特殊 token 不一定能从可见文本恢复，最终仍优先采用流末尾 usage。[OpenAI 官方计数说明](https://developers.openai.com/api/docs/guides/token-counting)

探测或计数失败时回退估算，推理继续执行。计数查询异步进行，不阻塞流式读取；只有缺少最终 usage 时才补齐末次完整文本计数，等待计数的时间不计入 LLM 请求耗时。“停止测试”同时取消推理、排队及在途计数请求。计数接口也须允许当前网站的 CORS 来源和认证请求头。

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
| 浏览器 decode | 结束后优先使用实际输出 token / 首段文本至流完成的浏览器耗时，标为实测；缺少最终用量时保留字符估算 |
| 服务端 decode | Ollama `eval_count / eval_duration × 10⁹`；汇总展示成功请求速率的算术均值，独立于并发整轮吞吐 |
| 服务端 prefill | Ollama `(prompt_eval_count - prompt_eval_cached_count) / prompt_eval_duration × 10⁹`；衡量未缓存输入的处理阶段并展示逐请求均值，缺失缓存计数时按 0 处理 |
| 模型加载 | Ollama `load_duration` 转为毫秒 |
| 请求总耗时 | 从发送到流正常完成，包括网络、排队、加载和尾部用量事件 |
| 整轮吞吐 | 成功请求输出 token 总数 / 端点最早请求开始至最后请求结束的墙钟时间 |
| 输入 / 输出用量 | 优先采用端点报告，缺失则显示估算；不把响应片段数当作 token 数 |

整轮吞吐的时间包括失败或取消请求占用的时间；它们的输出不进入成功总量。延迟和 decode 均值 / 最小值 / 最大值仅包含成功且具有有效指标的请求。缺失或零时间指标显示 `—`。

无计数 API 时，实时浏览器 decode 使用首末文本片段之间的估算 token 增量，排除首片段；有计数 API 时使用已校准文本量与浏览器时间并显示来源。最终实测速率使用整段实际输出及首段文本至流完成的时间，包含首段文本与尾部用量传输；只有一个文本片段或零时长时显示 `—`，不推断每个片段的真实 token 数。不同模型的 tokenizer、流式缓冲及网络传输会影响浏览器速率与服务端速率之间的差异。

整轮吞吐标明“实际/估算 token · 浏览器计时”，服务端 decode / prefill 使用端点报告的字段。A/B 只比较相同口径；混合实测与估算的浏览器均值不计算差异。悬停汇总数值可查看公式；逐请求详情提供实际用量、缓存输入、输出阶段耗时、服务 decode / prefill 耗时及总耗时，服务时间可悬停查看原始纳秒值。

整轮完成更快不一定意味着 decode / prefill 更高：首字前等待、服务排队、输出量、提示缓存及并行调度都影响结果。服务端阶段速率不包含整轮所有等待。参考 [Ollama 用量与纳秒耗时定义](https://docs.ollama.com/api/usage)。

并发 N 指客户端每端点同时发起 N 个独立请求；A/B 共 2N 个。浏览器连接限制与服务排队会影响实际并行数和端到端延迟。对比同一设备上的两个模型时，共享资源和模型换入换出也会影响结果。重复测试可能命中提示缓存或已驻留模型；缓存和加载数据可在结果中查看。

Ollama 的生成并行度由服务端控制，与页面设置的并发请求数分开。当前官方说明中，`OLLAMA_NUM_PARALLEL` 默认是 1；需要同时生成时，在运行 Ollama 的服务环境中设置为所需并行数并重启服务。并行数增加也会增加上下文内存需求。[Ollama 并发说明](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests)

Ollama 0.35.0 对 `qwen35moe` 等架构强制使用单路生成，即使设置了更大的 `OLLAMA_NUM_PARALLEL`。本机的 `qwen3.6:latest` 属于此架构，`qwen3:30b-a3b-q4_K_M` 的 `qwen3moe` 不在该限制名单中。因此页面并发 2 不保证两个模型具有相同的服务端并行度，应结合整轮吞吐和逐请求耗时比较。[对应版本调度源码](https://github.com/ollama/ollama/blob/v0.35.0/server/sched.go#L481)

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

`wrangler.jsonc` 使用 Workers Static Assets 托管 `dist/`，提供 SPA fallback，不运行推理服务。只有 `/api/*` 会先进入 Worker；页面、脚本和样式仍由静态资源直接提供，符合 Workers 的免费托管模式。LLM 服务本身可能有费用，具体取决于所选端点。[Cloudflare 静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

GitHub Actions 工作流在 PR 和 `main` push 时执行检查、浏览器测试与部署预检。部署设置：

1. 在 GitHub 仓库 Secrets 中配置 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。API Token 需要目标账户的 Workers 部署权限和 D1 编辑权限。部署成功后会执行 `wrangler d1 migrations apply DB --remote`。
2. 手动运行 **Validate and deploy** 工作流，会在所有检查成功后部署。
3. 若需 `main` 自动部署，添加仓库变量 `ENABLE_CLOUDFLARE_DEPLOY=true`。未启用时 `main` 只验证。
4. 如需更换 Worker 名称，修改 `wrangler.jsonc` 的 `name`；首次部署后将实际网站来源加入端点 CORS。

本地发布命令是 `npm run deploy`，需要先配置 Cloudflare 登录或对应环境变量。`npm run deploy:check` 只做预检，不发布。

[Cloudflare GitHub Actions 指南](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

## 测速记录

部署并完成迁移后，页面会向 `GET /api/status` 询问数据库是否可用。可用时，GO 按钮下方出现“记录结果”，默认开启，选择保存在本机 `llm-speedtest-record`。关闭后不再上报。数据库未绑定、迁移尚未应用或 schema 版本低于 Worker 要求时，开关隐藏，测速照常进行。

一次测速结束后提交一条记录，用户停止或请求失败也会提交。浏览器直连端点的推理请求不经过 Worker。记录内容是本轮结果的汇总，不是逐请求明细，也不包含输入或输出文本：

- 测试参数、耗时、输入文本的 SHA-256 前 16 位十六进制。
- 每个端点的协议、规范化地址、模型、别名、兼容选项和结果表中的汇总指标。
- API Key 原文。相同 Key 以 SHA-256 指纹去重，只存一行；`secret_format` 目前固定为 `plain`，以后改成加密存储时不需要改动引用它的记录。
- 来源 IP。Worker 只读取 Cloudflare 设置的 `CF-Connecting-IP`，请求体里的地址会被丢弃；没有这个头或格式不对时留空。这是上报结果时浏览器的公网地址，不是被测端点的地址。同一个 IP 只存一行。本地 `wrangler dev` 会记成 `127.0.0.1`。

`/api/runs` 没有登录。它要求 JSON、同源 `Origin`、32 KB 以内的请求体，并用客户端生成的测速编号去重，重复提交不会再写一行。建议在账户套餐支持时为 `POST /api/runs` 配置速率限制。写入额度用尽只会使这次记录失败，可以在结果条上重试，不影响测速。

D1 免费额度大约是每天 10 万行写入和 500 万行读取，存储合计 5 GB。维度表命中后，单端点一次测速大约写入 5 行，双端点大约 7 行（含记录本身和必要索引）；新的端点、模型、API Key 或来源 IP 才会额外写入。按双端点估算，约为一天 1.4 万次测速。[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)

表分为 `endpoints`、`models`、`api_keys`、`source_ips` 和每次测速的 `runs`、`run_endpoints`。`meta.schema_version` 记录结构版本。`v_run_results` 把一次测速的每个端点展开成一行，其中包含 API Key 和来源 IP，不要把查询结果贴到公开场合。例如：

```sql
SELECT started_at, source_ip, slot, protocol, base_url, model, alias,
       overall_tps, ttft_mean_ms, success_count, failure_count, cancelled_count
FROM v_run_results
ORDER BY started_at DESC
LIMIT 20;
```

时间戳是 Unix 纪元毫秒。`npm run dev:worker` 在本地同时提供页面和 API；只跑 `npm run dev` 时没有数据库，开关不会出现。本地建表是 `npm run db:migrate:local`，远端是 `npm run db:migrate:remote`。`npm run deploy` 会在发布后应用远端迁移。

首次 `wrangler deploy` 若配置里还没有 `database_id`，Wrangler 会按 `database_name` 查找或创建 `llm-speedtest`，并在交互式终端把 ID 写回 `wrangler.jsonc`。CI 不会改写配置文件，下次部署仍按数据库名称接上已有库。`npm run deploy:check` 不创建远端资源。

迁移文件在 `migrations/`，只追加、不改已经发布的文件。新结构先加列或表，确认新旧 Worker 都能工作，再切换读写，最后另一次迁移清理旧列。重建表时在迁移里使用 `PRAGMA defer_foreign_keys = true`。应用迁移前可以用 `wrangler d1 export llm-speedtest --remote --output backup.sql` 备份；误迁移还可以用 D1 Time Travel 恢复。Worker 只在 `schema_version` 不低于代码要求时接受写入，因此先发布 Worker、后跑迁移的短时间里记录会暂停，而不是写坏数据。

来源 IP 和 API Key 会一直保留完整值，目前没有自动过期或截断。如果需要保留期限，用新的迁移删除或截断旧行，不要直接改 `0001_init.sql`。

## 代码结构

- `src/lib/`：输入生成、协议适配、测速执行、指标计算和结果上报。
- `shared/run-record.ts`：浏览器与 Worker 共用的记录格式和校验。
- `worker/`：`/api/status`、`/api/runs` 和 D1 写入。
- `migrations/`：按顺序应用的数据库迁移。
- `src/App.tsx` 与 `src/styles.css`：配置、测速、结果及响应式主题界面。
- `tests/`：单元测试、浏览器测试与本地 Ollama 集成测试。
- `.github/workflows/ci.yml`：验证、可选部署和远端迁移。
