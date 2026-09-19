# st-chatu8 WaveSpeed / Civitai 适配记录

本版本直接基于 [damoshen123/st-chatu8](https://github.com/damoshen123/st-chatu8) 的 `4e1e8f8a6cab1375d39eb806a292516dbb9c43be`，上游版本 3.1.0。

修改者：Codex，受工作区所有者委托。日期：2026-09-19。原作者：从前跟你一样。沿用项目的 [Aladdin Free Public License](LICENSE)，原版权、声明、署名和许可证保留。分发或修改本版本须遵守该许可证；不提供额外保证。

本次修改目的：保留上游现有功能，作为独立前端扩展增加 WaveSpeed 和 Civitai 文生图支持；无需服务端插件。版本 3.1.0-cloud.2。

| 上游文件 | 修改内容 |
| --- | --- |
| `index.js` | 导入共用生图适配器；为现有模式切换、设置加载和图片尺寸弹窗添加接入；新安装默认选 WaveSpeed；关闭本地适配版的上游覆盖更新入口；隔离 extensionName、数据库、图片目录与事件；资源路径按安装位置解析 |
| `settings.html` | 增加 WaveSpeed / Civitai 共用侧栏入口，标明云端独立版 |
| `html/settings/main.html` | 增加 WaveSpeed 与 Civitai 模式选项 |
| `style.css` | 引入新增页面样式 |
| `manifest.json` | 标记独立版身份和版本，保留原作者，主页指向独立版仓库，上游来源记录在本文，关闭自动更新 |
| `README.md` | 在保留上游原始说明的前提下，前置独立版的正确安装入口 |

新增 `wavespeed/`、`shared/`、`html/settings/wavespeed.html` 为浏览器直连适配；新增测试、安装文档和打包脚本。共用上一版已测试的任务与 API 逻辑；`server/` 仅作为历史兼容及测试代码保留在源码包，不是安装依赖。没有重写 LLM 或世界书系统。

上游 92 个文件的 SHA-256 记录在 `docs/upstream-sha256.json`；其中 86 个文件保持逐字节一致。打包主文件内的世界书条目选择、世界书处理、LLM 服务、LLM 请求、提示词编排、图片插入与任务队列共 7 个模块保持逐字节一致。聊天上下文模块仅把聊天元数据存储键从 `st-chatu8` 换为 `st-chatu8-cloud`，校验时只还原该存储键再与上游比对。原指纹记录在 `docs/reused-modules-sha256.json`。

直接复用的链路：

1. 原世界书搭载、条目选择、角色绑定和触发测试（“发送数据”页）。
2. 原 LLM 配置、上下文预设、变量替换与提示词输出解析。
3. 原角色与服装设置、正文手势、自动触发、图片标签和编辑操作。
4. 原 `GENERATE_IMAGE_REQUEST` / `GENERATE_IMAGE_RESPONSE` 调用链；事件字符串增加独立前缀。
5. 原 `prompt_replace`、分角色提示词函数、`zhengmian`、任务队列和 `setItemImg` 图片缓存。

初期独立原型已经退出交付版本，仅在工作目录 `backups/` 保存备份，不参与加载或安装包。最终安装包是本上游适配版本。

Civitai 使用官方 v2 Orchestration 文生图接口，支持 Checkpoint AIR、LoRA、免费预估和预估 Buzz 上限。它复用 `shared/` 中的任务状态、查询和恢复逻辑，浏览器下载后调用原缓存接口。Key 放在当前浏览器独立 IndexedDB 中，不加入原配置导出。
