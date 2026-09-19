# 安装智绘姬 · 云端独立版

**当前版本 3.1.0-cloud.3 是普通酒馆前端扩展。无需安装服务端插件，无需修改 `enableServerPlugins`。** 浏览器直接调用 WaveSpeed / Civitai；世界书、LLM、人物预设、正文手势和图片操作复用原智绘姬代码。

## 用 Git 安装

1. 先在原智绘姬导出配置以备需要。到酒馆“扩展 → 管理扩展”停用原智绘姬，然后刷新页面。不需要卸载原版。
2. 在“扩展 → 安装扩展”粘贴 `https://github.com/wnqim233/st-chatu8-cloud` 并安装。原作者的地址只会安装原版。
3. 刷新后启用“智绘姬 · 云端独立版（WaveSpeed / Civitai）”。两版可以同时安装，但请只启用其中一个并刷新页面；它们仍沿用原项目的聊天图片标签和界面实现。
4. 在“主要设置”选择 WaveSpeed 或 Civitai。进入对应生图页，填写 Key、模型参数并保存。WaveSpeed 可点“读取文生图模型 / 验证 Key”；Civitai 可点“保存配置并免费预估 / 验证 Key”。
5. 在原有“LLM”页配置提示词生成用模型。在“发送数据”页选择酒馆已有世界书及条目，不必重新上传已有世界书文件。
6. 使用原手动入口测试正文 → LLM → 提示词 → 图片。需要自动配图时，再开启原有“自动 LLM 请求生图”和“自动点击生成”。

发布 Git 仓库时，把完整源码包解压后的目录内容放到仓库根目录，确保根目录直接有 `manifest.json` 和 `index.js`，不能额外套一层 `st-chatu8-source`。建议仓库名为 `st-chatu8-cloud`；资源路径也能按实际安装目录解析。保留 LICENSE 与原作者署名，不要上传真实 Key。

如果你只有手机浏览器而没有酒馆的扩展安装权限，仍需要该酒馆的管理员安装扩展；这与开启服务端插件无关。

## 不使用 Git 时

把安装 ZIP 中的 `st-chatu8-cloud` 文件夹放入自己的酒馆扩展目录并刷新。不要覆盖原 `st-chatu8` 文件夹。源码里的 `server/` 只保留上一版后端及回归测试支持，**无需安装或运行它**；当前安装包也不含服务端插件。

## 原版设置与世界书

独立版使用 `st-chatu8-cloud` 设置项和独立数据库，不自动读取、删除或迁移原版的缓存。需要旧预设时，可以使用原有配置导出/导入功能；导入后重新选择 WaveSpeed / Civitai 模式。原缓存图片不会自动复制到独立版。

酒馆世界书文件仍属于酒馆，两个插件都能按需选择。世界书选择、条目开关、角色绑定和触发测试仍在“发送数据”页。提示词预设使用原 `{{正文}}`、`{{上下文}}`、`{{世界书触发}}` 等占位符，LLM 输出仍应符合原图片标签格式。

原自动入口的正文长度门槛与手势行为保留；短正文未自动触发时，请先试手动入口。

## WaveSpeed 与 Civitai

WaveSpeed 默认模型 `wavespeed-ai/z-image/turbo`，参数 `{"size":"1024*1024"}`。更换模型时按平台文档调整 JSON、尺寸映射和负面词字段。

Civitai 使用官方 Orchestration v2 的 `textToImage` 工作流：

- Checkpoint 使用完整 AIR，例如 `urn:air:sdxl:checkpoint:civitai:101055@128078`。这是官方 SDK 示例，使用前需确认账号与平台支持该模型在线生成。
- 参数示例：`{"width":1024,"height":1024,"steps":25,"cfgScale":5,"scheduler":"eulerA","quantity":1}`。负面词用 `negativePrompt`；省略 seed 时随机；输出格式可为 `png`、`jpeg`、`webP`。
- LoRA 通过 `additionalNetworks` 配置，例如 `{"urn:air:sdxl:lora:civitai:模型ID@版本ID":{"strength":0.8}}`，换成真实且与主模型兼容的 AIR。
- 每次提交前免费预估 Buzz，超过设定上限或无法预估时不提交付费任务。默认预估上限 100 Buzz，可调整；最终扣费以平台为准。

本次新增的两种后端只接文生图；其他视频、图生图及编辑功能保持原后端用途。

## 保存与恢复

Key、任务与下载结果保存在当前浏览器 IndexedDB，独立于原版设置；生成后也会调用原插件缓存流程，是否另存酒馆取决于缓存设置。API Key 不会加入原插件配置导出。更换浏览器、设备、酒馆访问地址，或清理网站数据后，需重新填 Key；请先保存重要图片。

刷新页面后点击“查询任务”。已有任务只查询原 ID，不自动重新付费生成。若提交断线且未收到 ID，先核对平台历史；Civitai 应补填 v2 workflow ID。保存图片失败可重试下载；关闭页面期间不会在浏览器中继续查询或下载。

现代浏览器使用 Web Locks 协调同一存储范围内的请求；不支持该功能的旧浏览器仅在当前页面去重，请避免多个页面同时自动生成。

截至 2026-09-19，两家接口的实际 OPTIONS 检查允许测试酒馆来源跨域访问。具体账号、模型和结果图片域名仍需真实 Key 联调；网络或平台跨域策略变化时会提示错误并保留已有任务。

## 验证与源码

已完成 23 项模拟测试，以及真实浏览器 IndexedDB 保存、刷新恢复、后端切换与手机宽度布局检查。没有使用用户 Key 执行付费生图，没有核对用户自己的世界书，也未声称完整酒馆实例已联调通过。详见 [验证记录](docs/VALIDATION.md)。

开发命令：`npm test`、`npm run check`、`npm run package`，不需要安装 npm 依赖。

接口资料：[WaveSpeed 文档](https://wavespeed.ai/docs)、[Civitai v2 OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json)、[Civitai 官方 SDK](https://github.com/civitai/civitai-app-starters/blob/main/packages/civitai-app-sdk/src/orchestrator/index.ts)。

## 从 cloud.2 更新 / 导入旧配置后页面空白

在酒馆的扩展管理中更新「智绘姬 · 云端独立版」，然后刷新页面；无需卸载、重置设置或再次导入。更新到 `3.1.0-cloud.3` 后重新打开 WaveSpeed / Civitai 页。

此版修复菜单高亮与内容面板不同步，以及旧配置导入后未刷新生图模式的问题。云端设置入口始终保留；已选择 WaveSpeed / Civitai 时，导入旧后端配置会保留当前云端模式。世界书、LLM、人物和主题等配置仍沿用原版导入方式。浏览器内的 Key 和任务不会因导入其他安装的存储标识而切换；设置 JSON 本身不包含这两家的 Key。
