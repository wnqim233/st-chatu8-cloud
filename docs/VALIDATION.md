# 验证记录

版本：3.1.0-cloud.9。检查日期：2026-09-19。

**已完成源码复用校验、38 项模拟接口测试，以及两种后端的浏览器操作检查。Civitai Krea 2 已完成一张真实风景图测试；未验证 LLM/世界书到聊天回填的完整链路。**

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

当前自动测试为 38 项。`npm run check` 检查 20 个 JavaScript 文件语法、上游文件校验、7 个原模块指纹及聊天上下文模块的存储键差异、接入点和新增 HTML ID。

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

cloud.5 真实浏览器 API 验证：在用户授权下，使用其已保存配置的隔离 Chrome 副本、实际酒馆来源与插件 BrowserStore/任务引擎，生成一张 1024×1024 风景图。Krea 2 Turbo 主模型、两项 LoRA，8 步、CFG 1；平台预估与返回 cost.total 均为 17 Buzz，工作流 succeeded。发现 Civitai 图片下载需要 HTTP 跳转，修复为仅允许已知 Civitai blob 域名跟随跳转，并核对最终域名；不附带 Key 或浏览器凭据。使用同一任务 ID 恢复下载后 completed，JPEG 成功存入 IndexedDB 并导出核验，没有再次提交生成。新增两项跳转回归，总计 27 项通过。此测试只验证 API、LoRA 工作流和图片下载，不代表 LLM 提示词、世界书触发或自动插入聊天已实测。

cloud.6：新增配置迁移回归，验证模型、LoRA、尺寸与 Buzz 上限往返导入，目标 Key 和存储标识保留，非法版本拒绝；旧 JSON 导入保持兼容。个人配置和世界书迁移包仅写入本地 dist，不进入公开仓库。

cloud.6 验证结果：28 项自动测试通过；16 个 JS 语法检查及上游指纹检查通过；真实 Chrome 在 390×844 手机视口完成 20 项设置导入检查，包括旧版 JSON、云端参数、Key 保留与页面可见性。Windows 临时目录清理加入有限重试，处理 ENOTEMPTY 文件释放延迟。


cloud.7 排队验证：36 项 Node 测试通过，其中 8 项新回归覆盖五请求混合平台的 2 并发上限、任一名额完成或失败即补位、FIFO、排队去重、重开与两个调度器竞争、保存入队参数、取消等待、未知付费结果继续占位、预估超限后继续下一项、下载失败恢复、下载未结束时已经补位、排队时间不占生成超时。旧后端切换测试改为核对各任务访问正确平台，不依赖后台并行查询的完成顺序。

真实 Chrome 隔离测试使用真实 IndexedDB/Web Locks、设置 HTML、适配器、缓存和事件回调的模拟依赖，以及模拟平台响应：连续五次点击出现 2 个进行中和 3 个排队；通过实际按钮取消第 5 项；第 2 项先完成后第 3 项自动提交；刷新页面后继续处理剩余队列。总提交 4 次、4 个不同缓存条目、1 项取消，观测平台并发峰值为 2。390×844 手机宽度和 1280×900 桌面截图已查看，无横向溢出。此测试不调用真实平台，不代表手机休眠时仍可后台运行，也不代表在真实酒馆所有主题下完成了批量显示实测。

复现：运行静态预览服务，使用临时 Chrome profile 打开 `tests/queue-browser.html` 并启用 CDP 9232，然后执行 `node scripts/queue-smoke.mjs`；结果位于 `test-results/queue/`。测试源码包含固定假 Key，无用户配置和聊天资料。cloud.7 保持 86 个上游文件、7 个复用模块字节不变；JS 语法检查为 18 个文件。


cloud.8：38 项 Node 测试通过。新增 LoRA 全量替换、改权重、删除单项及清空映射与预估/付费工作流逐项一致性；尺寸默认 JSON 优先、显式跟随正文尺寸、非法保存不改变已保存参数及配置版本检查。

真实 Chrome 的设置页操作测试使用真实 IndexedDB，模拟外部接口，验证另一家隐藏表单 JSON 错误不阻止当前平台保存；编辑 LoRA 后保存、直接生成自动保存、任务卡按当前配置重新生成均得到预期的请求体。非法 JSON 或模拟存储失败时没有新付费 POST；刷新后重读参数一致。验证手机 390px 与桌面视口，截图已查看；原排队浏览器检查和旧配置导入回归继续执行。新增设置检查入口 `tests/settings-browser.html` 与 `scripts/settings-save-smoke.mjs`（临时 Chrome CDP 9234）。

另外对用户浏览器存储的隔离副本做了只读核对，并只读查询最近一个成功 Civitai 工作流：平台返回的三项 LoRA 与本地最新保存参数一致，已移除先前的第四项；因此不能将外观差异不明显归因于该次参数未发送。未提交新的真实生图任务；不导出 API Key，临时浏览器副本与页面随后删除，私人审计记录只留在本地 test-results，不进入仓库。

cloud.8 补充验证：旧配置导入 20 项断言通过；在加载完整上游设置 HTML、主题和导航的浏览器夹具中挂载新配置编辑器并检查 390px 手机截图，保存栏与当前后端标记可见。尚未操作用户真实手机。

cloud.9：40 项 Node 测试、22 项 JS 语法及上游完整性检查通过。使用用户实际私密设置文件在隔离浏览器中通过原 FileReader 导入两次，核对云端 Key（仅内存比较，不输出）、模型/LoRA JSON、插件设置（当前导航页除外）逐项一致，目标浏览器身份保留，没有迁移或提交任务。迁移文件不包含世界书文件或词库，原有词库记录数量不变，没有世界书写入或外部 API 请求。

手机显示与保存：完整上游设置弹窗在 390×844、360×640 和 844×390 尺寸验证，大工具栏随滚动离开，JSON 输入框命中测试不被遮挡且无横向溢出；JSON 下方按钮保存精确 LoRA 参数，错误 JSON 就地显示且不覆盖旧值。核对顶部、JSON 编辑及保存后截图。此前的自动保存、删除/清空 LoRA、存储失败阻止提交、刷新保留值及 20 项旧格式导入回归也通过。模拟 API 与浏览器尺寸测试，不代表已操作用户真实手机。
