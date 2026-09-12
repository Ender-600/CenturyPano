# CENTURY PANO · 前端设计 Demo

统一预览：<http://localhost:8000/designs/>

沿用现有 FastAPI 静态文件服务，无新增依赖、无构建步骤。服务未启动时，在项目根目录运行 `./scripts/serve.sh`。

| 方案 | 页面 | 视觉方向 |
| --- | --- | --- |
| 01 · 时间放映室 | `/designs/cinema/` | 炭黑、日落橙、大字号、电影画幅，强调沉浸和情绪 |
| 02 · 时间创作室 | `/designs/studio/` | 白灰、钴蓝、侧栏与设置面板，强调操作效率 |
| 03 · 时光邮局 | `/designs/postcard/` | 奶油黄、森林绿、珊瑚粉、明信片与票券，强调旅行趣味 |

预览页顶部可以切换方案、切换桌面和手机宽度，以及单独打开当前页面。URL 的 `#cinema`、`#studio`、`#postcard` 可以直接指定方案。

三套都支持本地照片选择、四档年代选择、今昔对比滑杆、沉浸预览、键盘平移与示例旅程。照片仅通过浏览器对象 URL 预览，不上传服务器。年代变化为 CSS 色调模拟，未连接真实生成、账户或档案存储；示例档案使用同一概念影像。原有 `/` 页面及后端生成流程未修改。

每套页面各自拥有 `index.html` 与 `style.css`；公共交互位于 `demo.js`，公共弹窗样式位于 `demo.css`，预览外壳位于 `gallery.js`、`gallery.css`。

## 素材

- 项目内素材：[assets/pittsburgh.png](assets/pittsburgh.png)
- 制作方式：imagegen 技能，通过内置 `image_gen` 工具生成，未使用 CLI。
- 内容性质：AI 生成的虚构匹兹堡概念城市图，不是实拍或历史影像。三套方案使用同一张图以便比较设计。

最终生成提示词：

> Use case: photorealistic-natural. Asset type: wide cinematic photograph used in three website design concept demos for a panorama time-travel app named CENTURY PANO. Generate one high-resolution 3:2 landscape image, 1536x1024 or larger. A beautiful fictionalized Pittsburgh riverside cityscape viewed at eye level from the pedestrian walkway of a monumental warm ochre steel truss bridge. The bridge framework creates an elegant diagonal leading from lower left foreground toward center-right distant vanishing point. Calm Allegheny River below, historic red-brick warehouses and Beaux-Arts buildings on the far bank, a few restrained distant contemporary skyline buildings, lush trees. Late-afternoon golden sunlight, moody warm film color, tactile steel and stone detail, subtle 35mm grain, high-end travel editorial photography. Show a rich open pale blue sky occupying upper 25 percent and a useful broad unobstructed midsection with bridge and city, well composed for wide 16:9 and tall 4:5 cropping. Beautiful detailed near-camera yellow bridge posts on the left, iron railing, layered river and architectural depth. Visually real and atmospheric, not an illustration or 3D rendering. This is a fictional AI-generated concept city image, not historical evidence. No people in foreground. No text, no captions, no logo, no watermarks, no typography or split-screen effects.

## 验证

- 通过 JavaScript 语法检查，静态资源路径检查。
- 浏览器验证方案切换、年代同步、键盘滑杆、预览开关、全景平移、示例选择和本地照片载入。
- 已检查桌面与手机排版。所有页面可以纵向滚动；统一预览页的手机按钮可检查 390px 宽度。
