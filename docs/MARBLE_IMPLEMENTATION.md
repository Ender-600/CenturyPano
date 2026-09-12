# 单街区历史世界：当前实现

> 此文记录先前的粗几何／深度实验，现仅在测试模式保留。当前默认流程已按用户要求改为手机实时 GPS → Google Street View RGB 360° 全景 → 历史图像编辑 → Marble；见 [Street View 接入说明](STREETVIEW_INPUT.md)。本页的旧实验耗时和费用不代表新路线。

这是当前 `/world/` 入口的使用说明：选择一个街区，检查带来源的建筑变化，再生成一个可在浏览器中查看的世界。

```text
明确选择的位置 + 精确年份
    → OSM 现代建筑轮廓 + CMU 官方建筑年代资料
    → 可审阅的现代/历史粗模型 + 用户补充实体编辑
    → 历史几何的球形深度 PNG
    → World Labs depth_to_rgb 历史 RGB 全景
    → Marble Draft 单个世界
    → SPZ 下载检查 + Spark 浏览器查看
```

这是有几何条件的想象重建，未完成历史准确性、真实场地尺度或手机 AR 验收。OSM 覆盖与查看器功能，不代表生成世界能完整覆盖同样的米数。

## 启动与入口

在当前项目根目录执行，需要 Python 3.11+、`uv`、Node.js 和 npm：

```bash
uv sync --python 3.11
npm ci
uv run python scripts/serve_worlds.py --env-file .env --port 8001
```

首次使用时先从 `.env.example` 创建 `.env`；已有配置直接使用。打开 [历史街区工作台](http://127.0.0.1:8001/world/)。`npm ci` 是此入口的必需步骤：Three.js 和 Spark 从本机 `node_modules` 提供，不依赖运行时 CDN，也没有额外打包步骤。旧全景图像页面仍在 `/`，通常使用原来的 8000 端口启动方式。

如果代码位于独立工作目录而配置仍在原项目，显式选择配置文件：

```bash
uv run python scripts/serve_worlds.py \
  --env-file /Users/maxwell/hackcmu/.env --port 8001
```

相对 `.env` 或其他配置路径同样适用。默认数据目录是当前代码目录下的 `data/worlds/`；可加 `--data-dir /absolute/path/world-data` 改到其他位置。保持单个 Uvicorn worker。

在本地配置中设置：

```dotenv
WORLDLAB_API_KEY=服务器端WorldLabs密钥
# 远程演示需要自行设置一个独立随机访问码；不要填供应商密钥。
WORLD_ACCESS_TOKEN=单独生成的随机访问码
```

只查看 OSM 粗模型和编辑计划不需要 World Labs 密钥；“生成历史世界”需要服务器密钥与可用积分。共享历史背景函数可按现有配置使用 K2/Gemini，但其文本不会直接改动几何。

本机 `localhost` / `127.0.0.1` 页面会通过受限制的本地会话接口自动获得访问码；未设置 `WORLD_ACCESS_TOKEN` 时服务器为本次进程随机生成。远程页面需要输入独立的 `WORLD_ACCESS_TOKEN`。浏览器不会获得 `WORLDLAB_API_KEY`，访问码通过同源请求的 `Authorization` 头发送，不能把供应商密钥当访问码使用。

手机远程演示可把 HTTPS 隧道指向 `http://127.0.0.1:8001`，然后打开隧道地址下的 `/world/`。这提供网页访问；手机定位需要安全上下文，定位输入也只用于选区，未实现 AR 空间对齐。

## CMU 1925 年示例

默认选区中心为 `40.4433, -79.9436`，半径 100 米、目标年份 1925。可请求实时 OSM，或明确点击“载入 CMU 地图快照 · 2026-09-12”。快照来自真实 OSM 查询，数据时间为 `2026-09-12T09:14:48Z`，并非手画矩形或 1925 年地图。失败的实时查询不会偷偷替换成示例。

当前快照在渲染范围内包含 **5 个现代体块、4 个移除项、1 个未知项**：

| 建筑 | 1925 年计划 | 依据与限制 |
|---|---|---|
| Gates and Hillman Centers | 移除现代体块 | CMU 记录 2009 年夏完成；不据此推断 1925 年是空地。[CMU 建筑资料](https://www.cmu.edu/cdfd/buildings/gates-hillman/index.html) |
| Purnell Center for the Arts | 移除现代体块 | 两份 CMU 记录分别为 1999 年项目、2000 年完成；不伪装成统一精确日期。[工程年表](https://www.cmu.edu/cdfd/greenaway/index.html)、[设施清单](https://www.cmu.edu/fms/files/BuildingPictures/BuildingPictures/BuildingListing.htm) |
| Cyert Hall | 移除现代体块 | 设施清单记录 1983 年。[CMU 设施清单](https://www.cmu.edu/fms/files/BuildingPictures/BuildingPictures/BuildingListing.htm) |
| Warner Hall | 移除现代体块 | 设施清单列出 1966、1996 年，两者均晚于目标年份。[CMU 设施清单](https://www.cmu.edu/fms/files/BuildingPictures/BuildingPictures/BuildingListing.htm) |
| Doherty Hall | 未知，暂保留现代轮廓 | 1908 年建筑及 2002、2008 年扩建尚未对应到各部分轮廓；保留只是未核实的体量占位。[设施清单](https://www.cmu.edu/fms/files/BuildingPictures/BuildingPictures/BuildingListing.htm)、[扩建年表](https://www.cmu.edu/cdfd/greenaway/index.html) |

库中另有 Tepper Quad、Wean、Newell-Simon 等资料。它们不会因为名称相似就套用到其他城市；Newell-Simon 的不同建设阶段不能简单按最近开放年份整体删除。Tepper Quad 的 2018 年开放资料也不等于整个 Tepper 学院名称下的所有建筑都建于 2018 年。[CMU Tepper 开放记录](https://www.cmu.edu/news/stories/archives/2018/september/tepper-quad-opening.html)

轮廓源自 OSM，历史年份来自人工整理并绑定到建筑名称和校园范围的官方资料；这是一个有限的证据库，尚无通用历史地籍检索。OSM 的 `start_date` 仍标为社区数据，不自动作为已核实史料触发删除。

坐标系以选择的位置为原点：`+X` 向东、`+Y` 向上、`+Z` 向南，单位为米。查询半径为 50–150 米；渲染最多 80 个体块，每个轮廓最多 32 个顶点，末点不能重复首点，坐标限制为 ±150 米。过大的完整建筑轮廓会省略并记录原因，不裁出虚假的外墙。此示例的 Cohon 轮廓因此被省略；Gates/Hillman 简化在 3 米偏差、3% 面积变化以内。高度可能来自 OSM、按层数估算或明确假设为 12 米。

原观察点靠近或位于建筑内，程序以原始 OSM 轮廓检查后移到 `40.44312865645815, -79.94347001450294`，偏移 `[11, 1.6, 19.053]`。这只是避开已绘制建筑的虚拟相机点，未验证地形、通行性或现场安全。

## 审阅与补充旧建筑

工作台先显示现代粗模型、历史粗模型、深度全景、每项变化及资料来源。历史几何没有经过确认的新增/替换证据时，不会自行生成一个“曾存在的旧楼”。可在“补充旧建筑与结构变化”中导入 JSON。

以下是**格式示例，坐标与体块为虚构，不代表 CMU 历史建筑**。使用前需要替换为自己的几何与资料链接：

```json
{
  "edits": [
    {
      "building_id": "example-unverified-structure",
      "action": "add",
      "label": "格式示例：待核实的旧建筑",
      "footprint": [[80, 80], [90, 80], [90, 90], [80, 90]],
      "height_m": 6,
      "reason": "请用这项建筑变化的实际依据替换此说明。",
      "source_url": "https://example.com/replace-with-your-historical-source",
      "source_title": "占位资料：尚未核实"
    }
  ]
}
```

| 动作 | `building_id` | 几何含义 |
|---|---|---|
| `add` | 新 ID | 必填新 `footprint`、`height_m`，可选 `label` |
| `replace` | 已有 ID | 用必填的新轮廓、高度替换当前历史实体；也可恢复已移除实体为另一形状 |
| `remove` | 已有 ID | 从历史实体列表移除 |
| `keep` | 原现代实体 ID | 恢复原现代轮廓，用于撤销删除/替换；这不证明其在目标年份存在 |

每项都需要 `reason`（最多 1200 字符）、`source_title`（160 字符）、HTTPS `source_url`（2048 字符，不含账号密码）；标签最多 160 字符。高度为 1–150 米。每次 1–20 项操作；一条计划编辑链累计最多 200 项编辑、300 条来源记录。导入的每个几何都校验点数、边界和简单多边形；最终实体列表还检查相机不在楼内。失败会拒绝整批操作，原计划保持不变。

补充资料统一标记 `user_supplied_unverified`，即使资料标题声称“官方已核实”也不升级可信度。服务不会抓取用户链接。新计划保留原现代轮廓、原来源以及 `edit_history` 中的前一条变化记录，不覆盖已有官方资料的内容。

## 生成、查看与恢复

审阅后点击“生成历史世界”。服务先把粗几何渲染成 2:1 球形深度 PNG，调用 World Labs `pano:depth_to_rgb` 生成 RGB 全景，再把完整球形全景以 `is_pano:true` 送入 `marble-1.0-draft`。正常链路是两个不同生成阶段，每阶段最多提交一次；两者都会使用服务账户积分。界面分别展示返回的费用，未知费用保持未知，不用旧 M0 的费用代替本链路总价。

返回资产包括可用的历史全景、最小可用 SPZ，以及提供方返回时才有的碰撞 GLB。Spark 在浏览器中解码 SPZ；可拖动查看，通过 WASD 或方向按钮移动虚拟相机。文件检查通过不等于 GPU 首帧成功、碰撞有效、真实尺度正确或历史外观合格。

每个付费阶段先持久化提交状态，收到 `operation_id` 后另存回执，再开始轮询。同一冻结计划与模型复用任务。关闭网页不会取消远端生成；同一浏览器会话刷新后读取已有任务。正常停止服务器会保存暂停状态，重启或安全恢复继续已受理的 operation 和资产下载，不重复提交该阶段。尚未开始的下一阶段可在恢复过程中首次提交。

若 POST 结果不明且缺少持久化 operation ID，任务进入 `submission_unknown`，不自动重试付费请求。需要先在 World Labs 核对受理情况。积分不足也不会自动购买、充值或不断重复提交。恢复接口只对 `can_resume` 的任务开放。

## 接口与文件

除公开配置与受限本地会话接口外，计划、任务和资产接口均需要独立访问码。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/world-config` | 提供方是否配置、年份范围与示例位置 |
| GET | `/world-session` | 仅同源本地请求取得访问码 |
| POST | `/world-plans` | `lat`, `lon`, `year`, `radius_m`, `source`, `heading_deg` |
| GET | `/world-plans/{id}` | 审阅计划、变化、资料和不确定性 |
| POST | `/world-plans/{id}/edits` | 上述 `{"edits":[...]}`，创建编辑后的计划 |
| GET | `/world-plans/{id}/assets/{filename}` | 现代/历史 GLB 与深度 PNG |
| POST | `/world-jobs` | `plan_id`，模型固定为 `marble-1.0-draft` |
| GET | `/world-jobs/{id}` | 阶段、计时、费用与可用资产 |
| POST | `/world-jobs/{id}/resume` | 仅继续可安全恢复的任务 |
| GET | `/world-jobs/{id}/assets/{filename}` | 当前任务登记的资产 |

`data/worlds/plans/` 保存计划和粗模型，`data/worlds/jobs/` 保存冻结计划、提交回执、阶段记录和生成资产。这些运行记录不应提交到公共仓库。公开的 CMU OSM 快照与来源库位于 `app/worlds/data/`，附有 OSM 数据时间、出处和 ODbL 标注。

## 验证范围与本次结果

374 项 Python 测试、27 项前端测试和 Ruff 通过，覆盖真实 OSM 快照到粗模型/深度渲染、CMU 年代绑定、未知阶段保留、实体编辑、提供方协议、一次提交与恢复、资产验证和页面请求边界。离线测试与粗模型预览不能证明真实生成质量。

2026-09-12，使用上述 CMU 1925 年未编辑计划完成一次真实链路。任务 `3af9219cfc577ab8c87dc78cb01a7360` 的生成与资产保存已完成，粗模型按证据移除四个现代体块的检查通过；**生成图像的历史视觉验收失败**，不能把它展示为已经还原的 1925 年 CMU。

| 观测项 | 本次记录 |
|---|---|
| 任务与输入计划 | CMU 1925；现代 5 个体块，移除 4 个，未知保留 1 个 |
| depth_to_rgb 观测时长 / 实扣积分 | 21.450941 秒 / 80 credits |
| Draft 观测时长 / 实扣积分 | 15.591062 秒 / 150 credits |
| 开始至资产保存完成 | 148.583057 秒，约 2 分 29 秒 |
| 生成 POST 次数 | 深度阶段 1 次，世界阶段 1 次 |
| 总实扣 / 余额前后 | 230 credits；6770 → 6540 |
| 粗模型结构检查 | 四项现代建筑移除通过；保留体块的历史轮廓仍未核实 |
| 历史外观检查 | 未通过：历史全景出现现代多车道马路、大型广告和现代街区外观 |
| SPZ 浏览器显示 | Chrome / WebGL2 / ANGLE Metal / Apple M1 Pro GPU 显示实际 SPZ，检查虚拟移动、桌面 1280×900 和移动视口 390×844；另有 SwiftShader 软件渲染检查 |
| SPZ 视觉质量 | 画面模糊，历史外观不合格；成功解码显示不等于质量验收通过 |
| 浏览器首帧 / 手机实机 | 首帧未单独计时；移动视口检查不是实体手机 GPU、传感器或 AR 验收 |

两次生成阶段的观测时长合计约 37 秒，**不是全链路用时**。148.583057 秒包含中途处理接口响应结构兼容、服务器重启与等待的时间，不能作为稳定延迟或 P50/P95。这次运行补齐了深度结果 `assets.imagery.pano_url` 的读取兼容；恢复使用已持久化的 operation，没有再次提交已受理阶段。

失败表明：轮廓删改进入深度并不保证生成图像服从目标年代和校园语义；当前平地没有道路、原建筑前身或历史土地用途证据，模型会补出不受约束的内容。此任务保存了 `review.status=rejected`，接口的历史准确性状态为 `failed_visual_review`，页面明确提示失败。桌面与移动视口截图只能作为查看器联调证据，不作为历史还原成果。

本轮之后已修复提示词：使用筛选后的可读字段，把地点和年份放在最前；不再截取含大量 Unicode 转义的整段 JSON；只有同时位于 CMU 地理范围并绑定 CMU 资料的计划才使用校园身份。提示词不再声称深度提供道路方向，并明确限制现代道路标线、高速公路及广告元素。`GENERATION_PROFILE='depth-history-v2'` 纳入新计划缓存和生成哈希，避免新配置复用旧版本的生成结果。

**修复后的提示词尚未追加付费实测。** 以上计时、费用、SPZ 和失败结论均属于修复前这一次任务；不能据代码修改宣称视觉质量已经改善。旧任务的付费记录与冻结提示词保持原样，不会因升级版本自动重新提交生成；后续效果需要另行生成并独立检查。

“一个街区”指输入计划的范围。单个生成世界能走多远、背面/遮挡处是否合理、能否扩展更远尚未有保证；本入口未实现自动扩展、多世界无缝拼接、地理配准、碰撞行走或手机真实 6DoF/AR。平坦地面、屋顶和未确定旧地用途也仍是限制。

## 与旧 M0 的区别及参考

[MARBLE_PROBE.md](MARBLE_PROBE.md) 描述的是旧 M0：一张普通图片直接生成 Draft，并记录了当时的室内样本。它没有 OSM/史料计划、深度到 RGB 阶段或本次 Spark 页面；其时长、积分和视觉判断不能移用于当前街区链路。[MARBLE_IMPLEMENTATION_PLAN.md](MARBLE_IMPLEMENTATION_PLAN.md) 保留早期路线与未来手机 AR 研究计划；当前可运行入口与边界以本文为准。

接口和编码依据：[World Labs OpenAPI](https://docs.worldlabs.ai/api/reference/openapi)、[官方深度 PNG 示例](https://github.com/worldlabsai/worldlabs-api-examples/tree/main/web-chisel-depth-png)、[SPZ 渲染与坐标](https://docs.worldlabs.ai/api/rendering-spz)、[计费说明](https://docs.worldlabs.ai/api/pricing)。公开地图查询使用 [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)。

地图署名：© OpenStreetMap contributors，数据依 [ODbL](https://www.openstreetmap.org/copyright) 提供；CMU 建筑年代资料的具体链接随每项变化记录展示。
