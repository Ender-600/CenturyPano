# main Street View / world model 排查记录

排查日期：2026-09-12。修复分支：`fix/main-streetview-world-model`。
基线：`main` / `origin/main` = `59393d8`；对比分支：`feat/marble-worlds` / `origin/feat/marble-worlds` = `237fb36`。

## 已确认的原因与修复

| 问题 | 对比与复现证据 | 本分支修复 |
| --- | --- | --- |
| 启动配置被覆盖 | marble 使用 dotenv 默认优先级。main 的 `9f09a51` 改为 `override=True`，导致仓库 `.env` 覆盖进程环境、启动器已加载的 `--env-file` 和 `--data-dir`。两个隔离子进程测试均在修复前失败。 | 恢复进程/启动配置优先，仓库 `.env` 仅填补缺失项。 |
| 保存的全景/世界被 GPS 等待卡住 | `1b4149e` 合并后的嵌入查看器需要 `bootReady` 才显示资产，但完成恢复后又先等待初始 GPS，最后才同步视图。浏览器不响应定位请求时，已有全景和 SPZ 均不显示。marble 独立查看器在恢复任务时直接打开资产。 | GPS 在后台独立完成；已有资产恢复和父页面模式切换不等待定位。仍只在获得有效新位置后准备当前地点街景。 |
| 无效 Google 配置被标为可用 | 原 `/world-config` 仅判断 key 是否非空，但下载客户端会检查格式。排查初始 `.env` 的 key 被客户端以 `invalid_key` 拒绝，配置接口却报告 `available=true`。此问题在两个分支都存在。 | 状态接口与客户端共用本地校验；无效配置关闭 Street View 和预加载，创建计划提前返回 503，页面显示具体原因。 |

用户提供新 `.env` 后，Google 配置格式已有效，并已成功获取真实街景。供应商密钥及访问码不写入本记录或 Git。

Street View 下载、Marble 客户端和任务管理核心在这两个基线分支之间没有代码差异。main 将世界图像模型独立为 `WORLD_OPENAI_IMAGE_MODEL`；当前默认值与原 marble 模型相同，实测该模型可访问，不是本次失败原因。

## 本机运行环境差异

排查时同时有多个服务，端口不同会得到不同结果：

- `8001`：已配置世界服务，但返回旧后端的默认年份 1925。
- `8012`：返回 main 默认年份 1926，但 Street View、OpenAI、World Labs 均未配置。
- `8016`：本次从修复 worktree 启动，显式加载用户更新的 `.env`，使用独立数据目录。

上述是排查时的响应快照。修改 `.env` 或切换磁盘上的代码后，应重启相应后端进程；静态前端变化不代表 Python 进程也已重新加载。

## 验证

- 新增 7 个回归用例：配置优先级 2 个、街景配置预检 2 个、GPS 未响应时恢复全景/世界 2 个、页面错误提示 1 个；修复前均失败。
- 全量 Python：703 passed；两条既有测试客户端弃用提示。
- 全量前端：315 passed。
- `ruff check app scripts tests`、`node --check web/world/app.js` 和 `git diff --check` 通过。
- 新配置真实 Google 下载：CMU 显式测试点 `40.4433, -79.9436`，完整全景 3328×1664；提供方标注拍摄月份 2013-06，拍摄点距测试点约 15 米。
- OpenAI 模型访问查询返回 HTTP 200；Marble 余额接口成功。
- 经用户明确授权的一次历史全景编辑已完成，实际编辑约 25.95 秒，总计约 26.03 秒。产物完整 3328×1664，受保护资产接口返回 HTTP 200，浏览器已实际渲染。
- 同一计划的 Quick Draft 世界复用了该历史全景，记录 `image_edit=0, world=1`。生成阶段约 15.72 秒，世界任务资产就绪约 20.20 秒；实际消耗 150 Marble credits。
- 世界任务已返回 `ready`，SPZ 约 24.59 MB（2,276,736 个点）、全景 PNG 和 collider GLB 均保存成功。SPZ 与全景资产的鉴权下载接口返回 HTTP 200；两阶段验证总耗时约 56.59 秒。
- 浏览器已实际渲染 SPZ 世界，并验证 Street View → Immersive world 往返切换正常；保存的全景和世界可在设备定位尚未提供时打开。

真实生成的历史准确性和实体手机传感器尚未验收；连通与渲染成功不等于历史事实得到验证。

## 启动本修复版本

在修复 worktree 中安装依赖后运行：

```bash
python scripts/serve_worlds.py --env-file /Users/maxwell/hackcmu/.env --port 8016 --data-dir /private/tmp/centurypano-main-world-fix/data/worlds
```

本次 worktree 位于 `/private/tmp/centurypano-main-world-fix`，复用了原工作区已安装的 Python/npm 依赖。原工作区的分支及未提交菜单改动保持原状。部署时按 README 独立安装依赖。

## 端到端记录

本机运行记录：`data/probes/world-e2e/report.json`（忽略的运行数据，不提交）。
历史全景任务：`827448737b8c25f8d7256322e06b06f7`。
Quick Draft 世界任务：`aa2d24d2b58724d6c4ff38bc1b87ae93`。

两项任务均已完成，仅提交一次图像编辑和一次世界生成。OpenAI 图像编辑按实际用量单独计费，未推算未经账单核实的金额。
