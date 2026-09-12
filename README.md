# CENTURY PANO

同一个地方，另一个时代。顶部四个模式依次为全景相机、自己的历史全景、Street View 历史全景和 Marble 沉浸世界。默认打开全景相机，四个模式共享年份滚轮，默认 **1926**，可选择 1800 年至当年的任意整数年份。

**想象重建，非历史影像。** HackCMU 2026 · Traveling。

## 当前可运行版本

已实现移动端四模式界面、FastAPI 图像流水线、多提供方照片编辑、精确年份与地点历史推理、天气变体、热点说明、地图档案、磁盘缓存、渐进瓦片、前后对比、手机转动跟随和离线照片回放；同时支持 Google Street View 360° 历史改图、Marble 三维世界、GPS／原生行走和沿路全景预加载。模式与合并行为见 [四模式说明](docs/FOUR_MODES.md)。

仓库自带的是 **工程示例**：程序绘制的街景插画经过本地色调变换，没有调用 AI，不是实拍照片，不代表历史重建画质。真实模型效果、真实模型性能、iPhone 的实体传感器验收需在配置密钥后完成，不能把下方本地数值作为 Gemini 的结果。

## 本地启动

需要 Python 3.11+ 和 Node.js/npm，推荐使用 `uv`。前端没有构建步骤；Three.js 和 Spark 从本机 npm 依赖提供，不依赖运行时 CDN。

```bash
uv sync --python 3.11
npm ci
cp .env.example .env
PROVIDER=demo uv run python scripts/seed_demo.py
./scripts/serve.sh
```

打开 <http://localhost:8000>。在默认相机模式拍摄或上传后自动进入照片历史模式，预览、滚动选择年份，再明确点击生成。第三个模式从当前位置的 Google Street View 单独生成历史全景；第四个模式明确生成 Marble 世界，并可复用相同历史全景。切换 Tab 或滚动年份不会自动开始付费生成。菜单中仍可打开工程示例和照片档案。

`seed_demo.py` 只允许 `PROVIDER=demo`，会生成城市、校园街区、360 三份插画回放和各自的串行基线。重复上传相同输入、精确年份、位置、提示词版本和提供方会命中缓存，保留原始指标并显示回放标记。离线前需要在同一浏览器至少完整打开一次所需回放，确认时光档案显示「已存本机」。

## 全屏视窗前端

全景铺满手机屏幕，年份和操作轻量悬浮。支持左右探索、原图 / 过去 / 今昔对比和纯净模式。上传预览保持原图，生成后展示后端渐进瓦片与最终拼接结果。结果页切换年份会先恢复同一张照片的预览，由用户明确开始新一轮生成；存档使用去除 EXIF 的原始工作图，并保留已知拍摄坐标或手填城市。

拍照、城市与 360° 设置、历史背景、生成数据和下载位于右上角菜单。上传时读取照片 GPS；「使用当前位置」主动请求设备定位。手填城市优先于照片位置与设备定位。离开生成页面后，同一浏览器的时光档案可以重新打开正在进行的任务。纯净模式隐藏控件，点击右上角眼睛或按 Escape 恢复。

手机转动跟随覆盖首页、照片预览和生成结果，并在切换页面时保持开启。请使用 HTTPS 链接：iPhone 首次点击画面中央「点按开启转动视窗」并允许访问；不需要显式权限请求的手机浏览器会自动监听。将手机竖起、后置摄像头朝前，再左右转动。右上角菜单可以暂停或重新设置当前朝向。画面使用手机相机朝向的水平投影，支持横竖持握；拖动、切换横竖屏和暂时离开页面后重新建立方向基准，避免跳动。

Node 回归测试运行实际前端脚本，覆盖方向计算、模拟传感器、权限请求、拒绝重试、首页 / 预览 / 结果 / 回看、横竖屏、拖动、纯净模式与暂停恢复，以及精确年份与地点功能；这些测试不替代实体手机验收。

## 历史街区工作台启动

完整四模式界面使用主服务的 `/`；`/world/` 保留独立 Street View／Marble 查看器，兼容既有分享和原生客户端。也可以用 `uv run python scripts/serve_worlds.py --port 8001` 启动同一个后端。

第三个模式需要 `GOOGLE_MAPS_API_KEY`、`OPENAI_API_KEY` 和已有 Street View AI 用途配置；第四个模式另外需要 `WORLDLAB_API_KEY`。世界图片模型由 `WORLD_OPENAI_IMAGE_MODEL` 单独配置，照片模型仍由 `PROVIDER` 和对应配置决定。配置样例见 `.env.example`，访问码遵循原有世界接口鉴权。

世界数据保存在 `data/worlds/`，可通过 `WORLD_DIR` 指定。不要把供应商密钥、访问码或生成资产提交到 Git。手机跟随与行走见 [查看器说明](docs/WORLD_VIEWER.md)、[真实行走](docs/REAL_WALKING.md) 和 [沿路预加载](docs/PREDICTIVE_WALKING.md)。原有世界代理仍只开放世界相关接口；完整应用需要连接主服务。

## 前端设计 Demo

已采纳的设计参考是 [全屏视窗](http://localhost:8000/designs/window/)，主页面已按此风格连接精确年份与地点历史生成流程。仍可打开 <http://localhost:8000/designs/> 比较全部四套方案。独立 Demo 使用概念图与本地色调模拟；主页面首页使用同一张概念图，上传预览和生成结果使用实际照片与后端输出。代码与素材说明见 [web/designs/README.md](web/designs/README.md)。

## 连接真实模型

把密钥写入本地 `.env`，不要写入前端或提交到 Git。变更配置后重启服务器。

```dotenv
PROVIDER=gemini
PROVIDER_FALLBACK=fal
GEMINI_API_KEY=你的密钥
XAI_API_KEY=你的密钥
FAL_KEY=你的密钥
K2_API_KEY=你的IFM密钥
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
GEMINI_TEXT_MODEL=gemini-3.6-flash
GROK_IMAGE_MODEL=grok-imagine-image-2.0
K2_BASE_URL=https://api.ifm.ai/v1
K2_MODEL=IFM/K2-Horizon-375B-A23B
MAX_CONCURRENCY=6
```

这里的 K2 是 HackCMU 赞助方 **IFM K2**。未配置完整 K2 时可使用 Gemini 文本模型；历史推理不可用时采用精确年份通用约束，并明确标记地点历史尚未确认。VLM 失败使用默认场景，锚点失败仍继续瓦片。真实图像服务失败时不会偷偷退回本地色调变换：失败瓦片使用原图并标记 `done_partial`。

如需使用 Grok Imagine，将 `PROVIDER` 改为 `grok`，并配置 `XAI_API_KEY`；默认模型为 `grok-imagine-image-2.0`，也可通过 `GROK_IMAGE_MODEL` 覆盖。

先验证单次调用，再准备实拍回放。下列命令会使用所配置服务并产生对应服务用量；基线会额外完整运行一次。

```bash
uv run python scripts/probe_providers.py /absolute/path/panorama.jpg
uv run python scripts/make_replay.py /absolute/path/panorama.jpg 1945 --place "Pittsburgh, Pennsylvania, US"
# 省略基线：附加 --no-baseline
# 单独补跑串行基线：
uv run python scripts/baseline.py JOB_ID
```

官方接口参考：[Gemini 图片编辑](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[Grok Imagine 图片编辑](https://docs.x.ai/developers/rest-api-reference/inference/images)、[fal img2img](https://fal.ai/models/fal-ai/flux/dev/image-to-image/api)、[IFM 快速开始](https://docs.ifm.ai/#/quickstart)、[IFM JSON 输出](https://docs.ifm.ai/#/structured-output)。

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
                          冻结统一提示词 → Gemini 锚点
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

四个模式共享目标年份，默认 1926。年份滚轮逐年移动，支持触摸、鼠标和键盘，也保留精确输入。已生成图像保留实际生成年份；选择另一个目标年份需要明确生成新版本。每年以 **7 月 1 日** 为明确参考时点，避免把年内事件前后混成一幅图。1945 和 1950 会分别根据位置推理，不能只套用相同的年代风格，也不能把一场战争的状态套用到所有城市。

历史模型接收具体年份、拍摄位置和当前场景，返回当地历史时期、事件背景、地块是否已开发、建筑更替建议与不确定性。所有历史模式默认允许按历史背景改变建筑高度、轮廓、道路和土地用途；相机位置、方向和投影固定。照片流水线的 `STRUCTURE_LOCK` 默认关闭，显式设置为 `1` 才启用原有结构锁实验。尚未开发的地块可以呈现自然地貌或农田，锚点与全部瓦片使用同一份提示词。

当前推理使用模型知识，**未接入历史地图、地籍或档案检索**。界面会展示推测依据与待核实事项；城市级位置不能证明具体地块的历史。Demo 模式仍仅模拟色调，不代表建筑重建。完整契约见 [历史背景说明](docs/HISTORICAL_CONTEXT.md)。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/jobs` | multipart `image`, `target_year`, `lat`, `lon`, `place`, `heading`, `is_360` |
| GET | `/jobs/{id}/manifest` | 单一状态来源，`Cache-Control: no-store` |
| GET | `/jobs/{id}/preview` | 去除 EXIF 的工作图 |
| GET | `/jobs/{id}/tiles/{i}?raw=1` | 原始瓦片；去掉 raw 参数获取匹配版本 |
| GET | `/jobs/{id}/result` | 最终拼接结果 |
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
node --test tests/*.mjs tests/*.cjs
```

自动化覆盖：规格中的 4 种瓦片宽度；窄图、超宽和 360；原始/匹配瓦片；时间戳；颜色匹配受控实验；缺失瓦片回退；零模型调用缓存命中；隔离串行基线；真实接口的请求格式；重试/熔断；隐私边界；非法上传和并发原子写入。

以下为 2026-09-12 在本机 **demo 色调模拟器** 上实际记录的指标（模拟器包含约 0.5 秒异步等待，用来验证渐进交互）。不是 AI 服务性能，不能作为重建质量证据：

| 工程示例 | 首块 / s | 总时长 / s | 串行 / s | 比值 |
|---|---:|---:|---:|---:|
| 城市街景 | 1.9130 | 2.8679 | 6.1963 | 2.161 |
| 校园街区 | 1.9765 | 3.0154 | 6.2509 | 2.073 |
| 360 环景 | 2.1925 | 4.7950 | 9.9622 | 2.078 |

本地模拟器本来就使用相同调色，城市示例 `seam_err.raw=0`、`after_color_match=0.35617`，因此**没有验证真实图像任务的接缝改善**。真实验收需要至少一份真实任务满足 `raw > after_color_match`，并记录 Gemini/fal 实际总时长与基线。

## 规格边界与待完成现场验收

- 为满足最多 8 块且仍有重叠，超宽全景工作宽度压缩至最多 7114 px（360 预留追加区域）；保留全部横向内容。小于一块宽度的输入缩放至 1024 px，不补画。
- 360 拼接时折回追加区域的贡献，避免简单裁切丢失首尾混合。
- 音频采用本地原创 WAV 而非 MP3，无外部素材授权和运行时下载。
- 系统 `<input capture>` 无法保证所有手机相机选择器暴露全景模式；可在系统相机先拍全景，再从相册选择。HEIC 预览由服务器兼容处理。
- 物理 iPhone Safari/Chrome 的滑杆、拖动、相机、传感器权限、方向符号、音频解锁仍需现场实机勾选。
- 真实 Gemini/fal 探针、实拍全景、真实接缝改善、真实速度比以及 3–4 个真实回放尚待密钥和照片。

不要把未通过的原规格 H0–H4 门槛视为完成。缺少密钥时已完成其余可独立验证的开发，不会伪造真实验收结果。

## 3 分钟演示提纲

1. **0:00–0:30**：同一地点的时间旅行；一句话说明「想象重建，非历史影像」。
2. **0:30–1:30**：优先使用已缓存的真实回放，说明「这是今天较早的一次运行，计时来自那次任务」；拖动、转动手机、滑杆比较。
3. **1:30–2:30**：展示真实首屏耗时、总时长、串行比；对比 raw 瓦片与匹配后的接缝数值，说明全局锚点和颜色匹配。
4. **2:30–3:00**：展示自己的全景上传与预览；网络和配额允许时继续真实生成。

只在准备好实拍回放后使用上述真实性能台词；工程示例需明确说明只是流程模拟。
