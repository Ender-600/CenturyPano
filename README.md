# CENTURY PANO

同一个地方，另一个时代。用自己拍摄的全景照片选择 1800 年至当年的任意整数年份，逐块生成过去的想象重建，拖动或转动手机探索，并用滑杆比较现在与过去。

**想象重建，非历史影像。** HackCMU 2026 · Traveling。

## 当前可运行版本

已实现移动端页面、FastAPI 图像流水线、GPT Image 2.5 Sunburst / Gemini 图像编辑、fal 回退、Gemini 场景识别、精确年份与地点历史背景推理、磁盘缓存、渐进瓦片、前后对比、陀螺仪与拖动、音频揭幕、离线回放和串行基线。

仓库自带的是 **工程示例**：程序绘制的街景插画经过本地色调变换，没有调用 AI，不是实拍照片，不代表历史重建画质。真实模型效果、真实模型性能、iPhone 的实体传感器验收需在配置密钥后完成，不能把下方本地数值作为真实模型的结果。

## 本地启动

需要 Python 3.11+，推荐 `uv`。前端没有构建步骤和 CDN 依赖。

```bash
uv sync --python 3.11
cp .env.example .env
uv run python scripts/generate_audio.py
PROVIDER=demo uv run python scripts/seed_demo.py
./scripts/serve.sh
```

打开 <http://localhost:8000>。点击「先来一场时光旅行」选工程示例；或者选择相册中的全景，预览、选择年份并生成。

`seed_demo.py` 只允许 `PROVIDER=demo`，会生成城市、校园街区、360 三份插画回放和各自的串行基线。重复上传相同输入、精确年份、位置、提示词版本和提供方会命中缓存，保留原始指标并显示回放标记。离线前需要在同一浏览器至少完整打开一次所需回放，等待「旅程已保存 · 断网后可从时光档案重访」。

## 前端设计 Demo

打开 <http://localhost:8000/designs/> 比较三套新的设计方向：电影感深色、蓝白极简工作台、复古旅行手账。可切换手机预览，体验本地照片、年代选择、今昔对比和沉浸预览。Demo 使用概念图与本地色调模拟；当前主页面和真实生成流程保持原有实现。代码与素材说明见 [web/designs/README.md](web/designs/README.md)。

## 连接真实模型

Marble 按需历史三维世界的实现、延迟实验与手机 AR 方案见 [实施计划](docs/MARBLE_IMPLEMENTATION_PLAN.md)。该方案目前处于规划阶段，下面仍是已有全景图像流程的配置。

把密钥写入本地 `.env`，不要写入前端或提交到 Git。变更配置后重启服务器。

```dotenv
PROVIDER=openai
OPENAI_API_KEY=你的OpenAI密钥
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst
OPENAI_IMAGE_QUALITY=medium
OPENAI_IMAGE_TIMEOUT_S=180
# 如需 fal 回退，设为 fal 并填写 FAL_KEY；留空表示只使用 OpenAI。
PROVIDER_FALLBACK=
MAX_CONCURRENCY=6
```

GPT Image 2.5 Sunburst 负责「整幅年代锚点」及「原始瓦片 + 锚点参考」的多图编辑，使用官方 Image Edits API。瓦片输出规范化为 1024×1024 JPEG，宽幅锚点先请求合法尺寸，再还原工作尺寸。`medium` 为默认画质；可通过 `OPENAI_IMAGE_QUALITY` 调整为 `low`、`high`、`xhigh`、`max` 或 `auto`。每次调用默认最多等待 180 秒，并发数量沿用 `MAX_CONCURRENCY`。OpenAI 不接收这里的 `seed` / `strength`，因此共享种子不保证图像可复现。任务记录 OpenAI 模型与画质配置，缓存和串行基线保留这份配置；每块图片另行记录实际使用的服务，便于识别 fal 回退。

场景理解仍是独立的 Gemini VLM：可选填写 `GEMINI_API_KEY`，默认 `GEMINI_TEXT_MODEL=gemini-2.5-flash`；只填写 OpenAI 密钥时使用默认场景描述。可选填写 `K2_API_KEY` 启用 IFM 年代约束；可选填写 `FAL_KEY` 并设置 `PROVIDER_FALLBACK=fal` 启用图像回退。若想继续使用 Gemini 编辑，设置 `PROVIDER=gemini`，默认图像模型为 `gemini-2.5-flash-image`。

这里的 K2 是 HackCMU 赞助方 **IFM K2**。未配置完整 K2 时可使用 Gemini 文本模型；历史推理不可用时采用精确年份通用约束，并明确标记地点历史尚未确认。VLM 失败使用默认场景，锚点失败仍继续瓦片。真实图像服务失败时不会偷偷退回本地色调变换：失败瓦片使用原图并标记 `done_partial`。

先验证单次调用，再准备实拍回放。下列命令会使用所配置服务并产生对应服务用量；基线会额外完整运行一次。

```bash
uv run python scripts/probe_providers.py /absolute/path/panorama.jpg --provider openai
uv run python scripts/make_replay.py /absolute/path/panorama.jpg 1945 --place "Pittsburgh, Pennsylvania, US"
# 省略基线：附加 --no-baseline
# 单独补跑串行基线：
uv run python scripts/baseline.py JOB_ID
```

探针会记录模型、画质和真实返回图；没有密钥时标记 `SKIPPED` 且调用次数为 0。`--provider all` 会依次探测 OpenAI、Gemini 和 fal。探针结果保存在被 Git 忽略的 `data/probes/`。

官方接口参考：[GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)、[OpenAI 图片编辑](https://developers.openai.com/api/docs/guides/image-generation)、[Gemini 图片编辑](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[fal img2img](https://fal.ai/models/fal-ai/flux/dev/image-to-image/api)、[IFM 快速开始](https://docs.ifm.ai/#/quickstart)、[IFM JSON 输出](https://docs.ifm.ai/#/structured-output)。

## 手机 HTTPS 演示

手机的传感器和定位需要安全上下文。在电脑运行服务器，然后使用 HTTPS 隧道：

```bash
cloudflared tunnel --url http://localhost:8000 --protocol http2
uv run python scripts/make_qr.py https://终端输出的地址.trycloudflare.com
```

二维码写入 `data/demo-qr.png`。Quick Tunnel 是临时演示入口，电脑和隧道进程都需保持运行；正式服务可使用 Docker + 你们的 HTTPS 反向代理。隧道启动方式见 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

```bash
docker build -t century-pano .
docker run --rm -p 8000:8000 --env-file .env -v "$PWD/data:/data" century-pano
```

当前是比赛用单实例应用，任务状态与锁均在一个 Uvicorn worker 中管理。不要加 `--workers`。公网真实生成服务需通过你们的访问控制入口限制使用，模型费用由服务器密钥承担。

## 架构与数据

```text
上传原图 → EXIF/离线城市 → 预处理 → VLM 当前场景
                                      ↓
                    精确年份 + GPS/城市 → 当地历史与地块变化
                                      ↓
                          冻结统一提示词 → 图像模型锚点
                                      ↓
                         视口优先的并行瓦片 → Lab 颜色匹配 → 余弦羽化拼接
                                      ↓                          ↓
                              原始/匹配瓦片                   结果 + 指标
                                      └──── manifest.json ──────┘
                                               ↓ 每 500ms
                                   浏览器渐进画面 / 对比 / 回放
```

- `app/main.py`：HTTP、上传校验、隐私边界、任务启动。
- `app/pipeline.py`：并行流水线、磁盘缓存、隔离基线任务。
- `app/geometry.py`、`consistency.py`、`stitch.py`、`metrics.py`：图像与指标。
- `app/editors/`、`scene.py`、`constraints.py`：模型适配与故障恢复。
- `web/`：无构建的移动端界面与 Service Worker。
- `data/in/`：原始上传，保留原文件与 EXIF，不通过 HTTP 提供。
- `data/out/JOB_ID/`：原子 manifest、band、anchor、`tN_raw.jpg`、`tN.jpg`、result。
- `data/out/.cache/`：精确缓存键以及避免再次调用文本模型的请求索引。

所有 manifest 写入都经过同一任务锁和临时文件替换。前端只能读取生成输出和缩放预览。定位优先级为手动地点覆盖、原图 EXIF、浏览器定位、无。浏览器定位仅作为拍摄位置的后备，应核对它是否与照片一致。可用 GPS、解析后的城市/州省/国家会用于历史推理及图像提示词；坐标不能证明该地块的历史。手动城市不会被伪装成精确 GPS，同名地点需用州省/国家消歧；未知手动文本仅显示、不进入模型提示词。

## 年份与地点历史

年份滑杆按 1 年移动，也可直接输入年份；默认 1925。每年以 **7 月 1 日** 为明确参考时点，避免把年内事件前后混成一幅图。1945 和 1950 会分别根据位置推理，不能只套用相同的年代风格，也不能把一场战争的状态套用到所有城市。

历史模型接收具体年份、拍摄位置和当前场景，返回当地历史时期、事件背景、地块是否已开发、建筑更替建议与不确定性。相机位置、方向和投影固定，建筑高度、轮廓、道路和土地用途允许按历史背景改变；尚未开发的地块可以呈现自然地貌或农田。锚点与全部瓦片使用同一份提示词。

当前推理使用模型知识，**未接入历史地图、地籍或档案检索**。界面会展示推测依据与待核实事项；城市级位置不能证明具体地块的历史。Demo 模式仍仅模拟色调，不代表建筑重建。完整契约见 [历史背景说明](docs/HISTORICAL_CONTEXT.md)。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/jobs` | multipart `image`, `target_year`, `lat`, `lon`, `place`, `heading`, `is_360` |
| GET | `/jobs/{id}/manifest` | 单一状态来源，`Cache-Control: no-store` |
| GET | `/jobs/{id}/preview` | 去除 EXIF 的工作图 |
| GET | `/jobs/{id}/tiles/{i}?raw=1` | 原始瓦片；去掉 raw 参数获取匹配版本 |
| GET | `/jobs/{id}/result` | 最终拼接结果 |
| GET | `/jobs/{id}/audio` | 原创 2 秒氛围音 |
| POST | `/jobs/{id}/baseline` | 后台串行重跑，返回 202，通过原 manifest 查看进度 |
| GET | `/replays` | 已完成的回放列表 |
| POST | `/preview` | HEIC 浏览器解码失败时的服务器 JPEG 预览 |
| POST | `/location/resolve` | 离线城市查询 |
| GET | `/health` | 提供方、配置状态与可选年份范围，无密钥 |

`target_year` 接受 1800 至当年的整数，优先于旧 `decade` 字段。旧四个年代请求及已存回放仍可读取；manifest 的 `target_year` 和 `anchor_year` 都是实际目标年份，`decade` 仅为归类。

## 测试与已测指标

```bash
uv run pytest -q
uv run ruff check app scripts tests
node --check web/app.js
node --check web/sw.js
```

自动化覆盖：规格中的 4 种瓦片宽度；窄图、超宽和 360；原始/匹配瓦片；时间戳；颜色匹配受控实验；缺失瓦片回退；零模型调用缓存命中；隔离串行基线；真实接口的请求格式；重试/熔断；隐私边界；非法上传和并发原子写入。

以下为 2026-09-12 在本机 **demo 色调模拟器** 上实际记录的指标（模拟器包含约 0.5 秒异步等待，用来验证渐进交互）。不是 AI 服务性能，不能作为重建质量证据：

| 工程示例 | 首块 / s | 总时长 / s | 串行 / s | 比值 |
|---|---:|---:|---:|---:|
| 城市街景 | 1.9130 | 2.8679 | 6.1963 | 2.161 |
| 校园街区 | 1.9765 | 3.0154 | 6.2509 | 2.073 |
| 360 环景 | 2.1925 | 4.7950 | 9.9622 | 2.078 |

本地模拟器本来就使用相同调色，城市示例 `seam_err.raw=0`、`after_color_match=0.35617`，因此**没有验证真实图像任务的接缝改善**。真实验收需要至少一份真实任务满足 `raw > after_color_match`，并记录实际图像服务的总时长与基线。

## 规格边界与待完成现场验收

- 为满足最多 8 块且仍有重叠，超宽全景工作宽度压缩至最多 7114 px（360 预留追加区域）；保留全部横向内容。小于一块宽度的输入缩放至 1024 px，不补画。
- 360 拼接时折回追加区域的贡献，避免简单裁切丢失首尾混合。
- 音频采用本地原创 WAV 而非 MP3，无外部素材授权和运行时下载。
- 系统 `<input capture>` 无法保证所有手机相机选择器暴露全景模式；可在系统相机先拍全景，再从相册选择。HEIC 预览由服务器兼容处理。
- 物理 iPhone Safari/Chrome 的滑杆、拖动、相机、传感器权限、方向符号、音频解锁仍需现场实机勾选。
- 真实 OpenAI/Gemini/fal 探针、真实接缝改善、真实速度比以及 3–4 个真实回放尚待服务密钥与现场验收。

不要把未通过的原规格 H0–H4 门槛视为完成。缺少密钥时已完成其余可独立验证的开发，不会伪造真实验收结果。

## 3 分钟演示提纲

1. **0:00–0:30**：同一地点的时间旅行；一句话说明「想象重建，非历史影像」。
2. **0:30–1:30**：优先使用已缓存的真实回放，说明「这是今天较早的一次运行，计时来自那次任务」；拖动、转动手机、滑杆比较。
3. **1:30–2:30**：展示真实首屏耗时、总时长、串行比；对比 raw 瓦片与匹配后的接缝数值，说明全局锚点和颜色匹配。
4. **2:30–3:00**：展示自己的全景上传与预览；网络和配额允许时继续真实生成。

只在准备好实拍回放后使用上述真实性能台词；工程示例需明确说明只是流程模拟。
