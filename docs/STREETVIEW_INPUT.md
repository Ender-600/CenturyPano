# GPS 与 Street View 360° 图像输入

用户定义的输入是地面拍摄的 RGB 360° × 180° 全景照片。它与 Google Photorealistic 3D Tiles 的建筑网格不同，也与当前 OSM 粗几何生成的深度全景不同。正常产品应使用手机取得的位置；固定坐标仅用于明确开启的测试模式。

计划链路为：手机 GPS → 最近的 Street View 全景拍摄点 → RGB 全景历史化 → 以 `is_pano:true` 交给 Marble → 查看生成世界。手机 GPS 与街景相机通常不重合，前端必须区分这两个坐标；街景拍摄日期也不是目标历史年份。

新任务默认 Marble 1.1 标准质量，优先使用完整精度 SPZ；生成前仍可显式选 Draft。下方约 100k 点的 Draft 实测属于升级前结果，不能作为新版画质与耗时的验证。详见 [世界质量说明](WORLD_QUALITY.md)。

## 现在可以接入的接口

`app/worlds/streetview.py` 提供异步 `GoogleStreetViewClient`。构造时必须同时提供 Maps key 和 `ai_authorized=True`，否则立即报错且零网络请求。调用方式：

```python
async with GoogleStreetViewClient(api_key, ai_authorized=permission_verified) as client:
    result = await client.fetch_panorama(lat, lon, radius_m=50)

jpeg = result["image_bytes"]
metadata = result["metadata"]
```

返回的 `metadata` 区分 `requested_lat/requested_lon` 与实际 `lat/lon`，包含距离、拍摄年月、原始航向／倾角／滚转角、版权、原始图像尺寸与本次输出尺寸。图片保持原始全景朝向，不偷偷旋转到北向；`coordinate_alignment_verified` 始终为 `False`。报告问题链接仅允许官方固定域名和已知查询字段，未知响应字段、key、session、请求 URL 不返回。

`streetview_url(lat, lon)` 是无需 key 的 Google 官方全景查看入口，使用 `map_action=pano&viewpoint=...`。它打开 Google viewer，**不会返回可供模型输入的图片**。[Maps URLs 官方说明](https://developers.google.com/maps/documentation/urls/get-started)

## 瓦片获取与尺寸

取得 session 后，请求最近全景的 metadata，再请求该全景的瓦片。只访问固定的 `tile.googleapis.com` HTTPS API；不抓取 Google Maps 网页，也不调用未公开的街景端点。[Session 官方说明](https://developers.google.com/maps/documentation/tile/session_tokens)

```text
POST /v1/createSession
  {mapType: "streetview", language: "en-US", region: "US"}
GET /v1/streetview/metadata?lat=...&lng=...&radius=50&session=...&key=...
GET /v1/streetview/tiles/{zoom}/{x}/{y}?panoId=...&session=...&key=...
```

实现按官方六级金字塔中 z=5 的原始尺寸选择 z=3，较大图像降到 z=2 或 z=1，使原生输出宽度不超过 3840、总像素不超过 8,294,400，以满足后续历史图像编辑器输入限制。依据 `imageWidth/imageHeight` 除以 `2^(5-z)` 得到精确图像范围。以官方示例 13312 × 6656 为例，z=3 输出 3328 × 1664，需要 7 × 4 块 512 像素瓦片；32768 × 16384 的源图使用 z=1 输出 2048 × 1024。只剪掉右边／下边超出图像范围的瓦片补白，不把整个 3584 × 2048 画布压成 2:1。无法整除、不是完整 2:1、尺寸或瓦片规格不支持时明确拒绝，避免把不确定的投影冒充完整全景。[Street View Tiles 官方说明](https://developers.google.com/maps/documentation/tile/streetview)

真实 Google 测试确认：`createSession` 带可选的 `imageFormat:"jpeg"` 时返回 HTTP 400（Invalid Value）；移除该字段后返回 HTTP 200，服务自动选择 JPEG。因此请求只发送上述三个必要字段。最初的 session／metadata 验证使用 CMU 坐标 40.4433、-79.9436、搜索半径 100 米，返回距请求点 15.146 米、拍摄于 2013-06 的全景，原图 13312 × 6656，已通过本地 metadata 校验。后续已完成下面记录的瓦片、历史改图和三维生成端到端实测。

每次获取最多 50 个 HTTP 请求、最多 8 个并发、48 MiB 解码后下载数据，单 JSON 128 KiB、单瓦片 2 MiB，最终 JPEG 不超过 10 MiB。不重试、不跟随重定向、不读取环境代理，客户端本身不持久化缓存。任何缺失瓦片都会使整个获取失败。无覆盖不会自动切到 CMU 或扩大到另一个街区。用户开启「Prepare ahead as you walk」后，独立的预测流程会有界遍历前方相邻街景并复用后端保存的历史全景，详见 [预测步行](PREDICTIVE_WALKING.md)。

## 2026-09-12 端到端实测

测试地点为 CMU 附近 40.4433、-79.9436，目标年份 1925。计划 ID 为 `8d4b058b-c2fa-41d4-a306-92406dc1149c`，生成任务 ID 为 `ed8e4f476d5fe0af1cddc0501e391c9a`。

| 阶段 | 观测结果 |
| --- | --- |
| Google 全景 | 30 次请求：session、metadata、28 块瓦片；拼成 3328 × 1664 JPEG，1,353,683 字节 |
| 历史改图 | `gpt-image-2.5-sunburst`、medium，26.837 秒，输出保持 2:1 |
| Marble Draft | 世界生成 19.641 秒；生成任务启动至资产就绪 49.700 秒 |
| 调用与费用 | `image_edit`、`world` 各提交 1 次；150 World Labs credits，OpenAI 图像编辑另计 |
| 三维资产 | SPZ 99,846 个点、1,190,266 字节；浏览器已通过 GPU 显示，无 console error |
| 公网访问 | 页面和经过认证的任务请求均返回 HTTP 200 |

这是一个地点的一次样本，不能作为 SLA 或稳定延迟承诺；49.700 秒仅为生成任务启动至资产就绪，不代表从手机定位开始的全部等待时间。当前历史背景在 `PROVIDER=demo` 且无 K2／Gemini 配置时使用降级结果，仍附带 8 条 CMU 历史规则。实际改图保留了大量现代结构，呈现棕褐色风格，**历史准确性尚未验收**。本次已验证该全景的瓦片拼接、图像编辑、世界生成和浏览器显示；其他影像来源的金字塔、手机当前 GPS 定位及手机实机 6DoF 跟踪仍未验收。

## 配置与许可的边界

`GOOGLE_MAPS_API_KEY` 配置服务 key。`GOOGLE_STREETVIEW_AI_AUTHORIZED` 只能表示部署者已经核实拥有该用途的专门许可，涵盖图像提取、保存、历史改图与向外部 AI 服务转交；不能把用户勾选框或 key 本身当作该许可。此开关默认关闭，适配器不会由普通 Google 展示功能隐式启用。

Google 普通 Maps 条款 §3.2.3(a–c) 限制站外提取、缓存及依据 Google Maps 内容创建新内容。Maps API 能取到瓦片，不等于能将这些瓦片送 World Labs 生成并保存另一份世界。[Google Maps 条款](https://cloud.google.com/maps-platform/terms)

Google 的 Maps Imagery Grounding 为专门的生成影像能力，官网仍列为 Private Preview（美国地点），公开示例使用 Gemini Enterprise Agent Platform。是否允许导出完整 360° 全景并转交 World Labs，要以获准项目的接口和协议为准，不能由宣传页推定。[Google 官方介绍](https://mapsplatform.google.com/resources/blog/three-new-ways-to-build-with-real-world-imagery-and-ai/)

## 为什么要先历史化 RGB 全景

World Labs 的 `worlds:generate` 支持 `world_prompt.type="image"`、`image_prompt.source="data_base64"`、`extension="jpg"` 和 `is_pano:true`。已知完整全景会跳过全景生成阶段，直接用于构造世界；因此不应把现代全景配上年份文字就当作完成了历史改图。[World generation examples](https://docs.worldlabs.ai/api/world-generation-examples)

公开 Pano API 目前只文档化了 `pano:depth_to_rgb`，没有可据此调用的 RGB 全景编辑端点。Marble 网页 Pano Edit 的存在不代表该操作已提供公开 API。历史化应使用实际可用的图像编辑适配器，保留完整球形覆盖、首尾接缝、相机视点及史料来源，并在提交 Marble 前检查建筑结构和年代特征。[Pano API](https://docs.worldlabs.ai/api/reference/pano)，[Marble Pano Edit](https://docs.worldlabs.ai/marble/edit/pano-edit)

未获得 Google 相关用途许可时，可以使用自有或明确获得相应用途授权的完整全景进行开发；不能将 Google 普通网页截图的上传入口作为绕过许可的替代路径。
