# Marble 单世界实测

这是 M0 的真实生成与资产检查工具。现有全景服务保持独立；本工具不表示手机 AR 或历史准确性已完成。

在 `.env` 设置 `WORLDLAB_API_KEY`。从项目根目录执行：

```sh
.venv/bin/python scripts/probe_marble.py /absolute/path/photo.heic --year 1925
```

脚本固定使用 `marble-1.0-draft`，只提交一次付费世界生成。先检查 credits；按照当前普通图片 Draft 230 credits 的估价，余额不足时不提交，不购买或补充 credits。实际费用优先记录 operation 返回的 `cost.total_credits`。

图片执行 EXIF 方向校正，保留完整画幅及宽高比，最长边缩至 2048 像素，移除元数据后上传 JPEG。始终按普通图片 `is_pano:false` 提交，不能用本工具绕过完整球形全景的校验。输入图加目标年份直接交给 Marble；这里没有串联 GPT Image，也没有调用 Google 街景。

默认记录在被 Git 忽略的 `data/probes/marble/<run-id>/report.json`，包括原图和提交图的哈希、输入尺寸、年份、模型、提示词、operation ID、时间、世界资产和验证结果。输入图片、供应商响应、资产 URL 与生成文件都留在该目录；不要将它提交到公共仓库。

网络中断或轮询超时后，用记录中的目录继续：

```sh
.venv/bin/python scripts/probe_marble.py --resume data/probes/marble/<run-id>
```

恢复只读取已有 operation / world 并下载资产，绝不重新提交生成。如果首次 POST 结果不明且没有收到 operation ID，状态为 `submission_unknown`，必须先在 World Labs 账户核对，脚本拒绝自动再次付费。

隔离工作目录可显式加载原项目的配置：

```sh
/path/to/.venv/bin/python scripts/probe_marble.py /path/to/photo.heic \
  --env-file /path/to/project/.env --output /path/to/project/data/probes/marble/run-id
```

世界返回后，只下载最小可用 SPZ，以及存在的全景图和碰撞 GLB。不会请求额外的高质量网格导出。资产检查通过只表示下载及文件结构检查通过；它不代表 GPU 已渲染、真实尺度已校准、手机行走跟踪已运行，或场景是有史料支持的历史还原。

`generation_observed` 从 POST 开始计时，到本机首次观察到 operation 完成为止，包含上传、供应商等待和轮询间隔；这不是供应商独立计算时间。`total_to_assets` 包含图片准备和下载检查。恢复任务时也包含程序离线的间隔。查看器首帧和手机空间对齐仍需另测。

当前接口与价格依据：[World Labs OpenAPI](https://docs.worldlabs.ai/api/reference/openapi)、[计费说明](https://docs.worldlabs.ai/api/pricing)、[SPZ 渲染与坐标](https://docs.worldlabs.ai/api/rendering-spz)。

## 2026-09-12 首次真实结果

输入为用户已上传的室内横向手机全景，原尺寸 16352 × 3780，保留完整画幅缩至 2048 × 473，以普通图片提交。目标年份 1925，`disable_recaption:true`。本轮只提交一个私有 Draft 世界；没有生成标准世界、调用 GPT 或请求额外网格导出。

| 观测项 | 单次样本值 |
|---|---:|
| 输入准备 | 1.353 秒 |
| POST 提交至收到 operation | 4.411 秒 |
| POST 开始至观测到世界完成，包含上述提交 | 25.573 秒 |
| 资产下载与文件检查 | 1.795 秒 |
| 开始准备至资产检查完成 | 29.424 秒 |
| operation 实扣 | 230 credits |
| 余额前／后 | 7000／6770 credits |

25.573 秒已包含 4.411 秒提交，不应再重复相加。样本数 n=1，不能据此声称 P50/P95、户外场景时延或手机可行走首帧。按当时官方换算约 $0.184，未作余额充值。

实际返回 `100k`、`500k`、`full_res` 三种 SPZ。选用的 100k 文件为 1,116,358 字节，头部显示 SPZ v2、99,846 个点；只做了 gzip 内 SPZ 头部检查，没有完整解码或 GPU 渲染。全景 PNG 为 2304 × 1152、3,889,943 字节，完成图片解码；碰撞 GLB 为 1,620,724 字节，检查头部和文件长度。`semantics_metadata` 为 null，当前结果不提供可直接用于真实米制对齐的尺度与地面参数。

**视觉判断：历史化未通过。** 生成全景保留了电脑／显示屏、现代灯具、白板、现代家具和人物，虽然提示词要求替换现代元素并移除人物。它补全了场景，但不能作为 1925 年的历史效果展示。该判断来自本次生成全景的人工观察；未进行历史资料核验，未测三维遮挡和移动视差。

下一轮应对照“先编辑出经过检查的历史图像，再送入 Marble”，并把图像编辑耗时计入总等待。还需要真正的室外输入、SPZ 查看器解码与两个平台的手机空间对齐探针。本轮结果只缩小了 Draft 生成延迟的不确定性，没有解决整个产品的实时体验。

完整输入、操作记录和下载资产保留在本机忽略目录 `data/probes/marble/m0-20260912-draft/`，没有提交到 Git。

离线验证：已有回归及 API／恢复流程共 160 项测试通过；随后新增的资产检查测试 37 项通过，合计 197 项。Ruff 与 `git diff --check` 通过。这些自动化测试不覆盖真实手机渲染或历史质量。官方网页查看器在本轮浏览器会话中提示没有该私有世界的访问权限，因此没有用网页渲染结果补充 GPU 验收，也没有更改世界可见性。
