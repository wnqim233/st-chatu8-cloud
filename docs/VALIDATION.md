# 验证记录

版本：3.1.0-cloud.4。检查日期：2026-09-19。

**已完成源码复用校验、25 项模拟接口测试，以及两种后端的浏览器操作检查。尚未用真实 Key 在完整酒馆实例中付费出图。**

| 检查 | 实际结果与范围 |
| --- | --- |
| 上游完整性 | 基于 `4e1e8f8a6cab1375d39eb806a292516dbb9c43be`；92 个原文件中 86 个逐字节相同，仅修改已声明的 6 个文件 |
| 世界书及 LLM | 条目选择、世界书处理、LLM 服务、LLM 请求、提示词编排、图片插入、任务队列共 7 个模块 SHA-256 未变；聊天上下文模块仅改独立存储键，还原键名后指纹相同；没有读取用户的实际世界书 |
| 原提示词函数 | 测试直接提取并执行上游 `prompt_replace`、`zhengmian` 等函数，通过实际适配器核对输出 |
| WaveSpeed | 提交、查询、重启恢复、图片下载、同一任务去重、超时不重复提交、下载失败重试、失败终态、Key 隐藏与用户隔离通过模拟请求测试 |
| Civitai | v2 工作流结构、AIR/LoRA、seed、负面词与尺寸、免费预估、预估超限阻止提交、付费任务幂等 ID、未知结果恢复、失败终态通过模拟请求测试 |
| 独立身份 | 执行打包配置片段核对插件 ID、资源路径与事件命名，核对缓存数据库和迁移源不指向原版；世界书仍使用酒馆资源 |
| 后端切换 | 同一提示词在两家分别建立任务；之后按任务记录中的 provider 查询，不因当前界面后端变化而查错平台 |
| 浏览器 | Qt WebEngine 的本地页面加载真实设置 HTML、样式、适配器、共享任务引擎和 IndexedDB；静态测试服务器的所有 /api/ 路径返回 404；模拟两家远程响应及原插件回调。WaveSpeed 出图回填 1 次；切换 Civitai 并免费预估后出图回填第 2 次；Key 输入清空、任务卡数量正确、无 JS 错误；刷新后两家 Key、任务和 Blob 图片恢复，期间没有新平台请求或服务端插件请求 |
| 手机布局 | 390 × 844 本地预览无横向溢出；另检查了桌面截图。不是用户真实手机或完整酒馆主题下的验证 |
| 安装包 | 打包脚本检查 ZIP CRC、必需文件和 SHA-256；安装包与完整源码包分别交付 |

复现命令：

```sh
npm test
npm run check
npm run package
```

浏览器模拟检查先运行 `npm run preview`，再用装有 PySide6 的 Python 运行 `scripts/browser_smoke.py`。测试访问 `127.0.0.1:8765`，不访问真实生图 API、不消耗额度；浏览器结果和截图位于本地 `test-results/`，不打入安装包。

当前自动测试为 25 项。`npm run check` 检查 16 个 JavaScript 文件语法、上游文件校验、7 个原模块指纹及聊天上下文模块的存储键差异、接入点和新增 HTML ID。

仍需真实环境核验的部分：实际酒馆版本及其他扩展兼容性、用户自己的 LLM 与预设、世界书条目命中、两家 API 账号权限及所选模型可用性、真实耗时与费用。按用户要求，暂不核对其世界书。

接口依据：

- [Civitai 官方 v2 OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json)：认证、工作流结构、`whatif`、`externalId`、任务状态、图片 URL 和 Buzz 字段。
- [Civitai 官方 SDK](https://github.com/civitai/civitai-app-starters/blob/main/packages/civitai-app-sdk/src/orchestrator/index.ts)：个人 Key 的 Bearer 用法、文生图参数、可用图片提取。
- [WaveSpeed 文档](https://wavespeed.ai/docs)：v3 模型提交、prediction 查询和输出格式。

代码依照查到的接口实现，模拟测试不代表平台对真实 Key 的联调已经通过。

浏览器直连预检（2026-09-19）：针对来源 `http://127.0.0.1:8000`，以 `Authorization, Content-Type` 请求头执行 OPTIONS。WaveSpeed 提交端点返回 204 和 `Access-Control-Allow-Origin: *`；Civitai v2 workflows 返回 200，允许该来源及所需请求头。没有发送真实 Key、没有付费生成。预检通过不代表生成结果 CDN、其他浏览器来源或账号权限已经完成实测。

cloud.3 导入回归：运行 `npm ci`、`npm run preview` 后，用 PySide6 Python 执行 `scripts/settings_smoke.py`。测试加载原版全部设置页、真实样式、jQuery，以及从 index.js 提取的实际文件导入、合并、导航、主题和导入后刷新函数。17 项断言通过：旧模式下云端页仍可访问、手动构造菜单已选中但面板未激活的状态后点击可恢复、两种云端模式下旧 JSON 导入成功、模式和处理器同步、世界书/LLM 测试字段保留、真实 IndexedDB 内两家 Key 保留、非法根对象拒绝。桌面和 390px 窄屏截图已检查，无横向溢出或 JS 错误。

此回归使用构造的旧版配置，尚未获取用户实际导入文件；原完整表单加载依赖酒馆会话，在夹具中仅模拟其异步完成、主题和模式填入，后端处理器记录调用。不能据此声称已在用户手机完整复现原始触发条件。结果位于 `test-results/settings-import.json`。

cloud.4：两项 Krea 2 回归通过，核对估价与提交的工作流完全一致，使用 imageGen/comfy/krea2/turbo 和指定 diffusionModel；验证 raw、diffusionmodel、LoRA 映射及非法尺寸/旧调度器拒绝。参数约束对照 https://orchestration.civitai.com/openapi/v2-consumers.json 的 ComfyKrea2TurboCreateImageGenInput、ComfyKrea2RawCreateImageGenInput、ComfySampler、ComfyScheduler。未使用真实 Key，未向平台发起预估或付费生成。
