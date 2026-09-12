# CenturyPano 手机空间追踪客户端

这两个原生客户端为现有 `/world/` 页面提供视觉惯性位姿。iPhone 使用 ARKit，Android 使用 ARCore；世界仍由网页内的 Spark / Three.js 渲染。服务商密钥继续留在服务器，摄像头图像不经桥接上传。

## iPhone 安装

1. 用 Xcode 打开 `ios/CenturyPano.xcodeproj`，选择 `CenturyPano` scheme。
2. 在 Xcode Settings → Accounts 登录 Apple ID；在 Signing & Capabilities 选择你的开发团队并开启自动签名。
3. 通过 USB 连接并解锁 iPhone，信任电脑。在 iPhone 设置 → 隐私与安全性中按系统提示启用开发者模式。
4. 在 Xcode 选择这台 iPhone 为运行设备，点击 Run。
5. 在客户端中粘贴当前 HTTPS 演示链接。若链接含独立演示访问码，保留 `#access=` 片段；不要输入 Google、OpenAI 或 World Labs 密钥。

项目最低 iOS 16。需要支持 ARKit 世界追踪的实体设备；模拟器不能测量真实位移。无签名构建命令和权限说明见 [iOS README](ios/README.md)。

## Android 安装

用 Android Studio 打开 `android/`，或按 [Android README](android/README.md) 用 Gradle 构建。产物为 `android/app/build/outputs/apk/debug/app-debug.apk`，可安装到支持 ARCore 的 Android 手机（最低 API 24）。

```sh
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

## 实际行走

在客户端中打开已生成世界，进入视窗设置的「真实行走」。若没有米制元数据，先点「测量比例」，拖动画面用准星选中已知实际距离的两个端点，然后输入实际间距（米）。这只是用户参照校准；生成建筑本身可能存在尺度失真。

回到三维画面，调整虚拟起点与水平朝向，然后在设置中点「启用真实行走」，允许相机并等待追踪稳定。实际移动和转手机分别改变三维相机位置、朝向。原地转手机不会当作行走，朝侧面看也不会改变真实位移方向。追踪丢失后视点冻结，站稳后点「重设起点」。普通 Safari 和 Chrome 没有此原生桥接，只支持环视与方向跟随。

## 本次验证（2026-09-12）

- iOS 模拟器和通用真机目标无签名构建通过；模拟器安装、启动、HTTPS 演示加载、设置抽屉、应用与网页两层定位授权流程通过。没有把模拟器坐标当作实地位置；相机追踪仍待真机。
- iPhone 签名安装尚未完成：本机 Xcode 缺少可用的开发团队账号及 `com.centurypano.motion` 的 provisioning profile。仅有本地签名证书不能安装。
- Android debug APK、8 项 JVM 测试及 lint 通过；尚未连接实体 Android。
- 位移、朝向、尺度、陈旧和乱序帧、追踪丢失、重新设起点等逻辑由自动测试覆盖。没有将模拟输入或模拟器当成实机精度证明。
- 本次整合后 `node --test tests/test_world_*.mjs` 共 134 项通过，包含同期定位／年份选择回归；`git diff --check` 通过。
- 浏览器以已有 CMU 1925 真实 SPZ 验证两点求交、距离输入和比例应用；测试参照距离没有当作现场测量。没有追加模型生成费用。

真机验收依次检查：原地转动；测量 1 米前进/后退；边走边侧看；横竖屏；遮住相机后冻结；切后台后不会自动恢复；重设起点后继续。具体坐标规则和几何限制见 [真实行走说明](../docs/REAL_WALKING.md) 与 [桥接协议](BRIDGE.md)。
