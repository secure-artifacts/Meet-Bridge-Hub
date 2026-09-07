# 固定扩展身份与一次性设置迁移

跨 Profile Native Messaging 需要固定 Chrome 扩展 ID。Meet Bridge N-1 的固定 ID 为：

`ancoaojdjchmllenalcmmkgndahancgp`

Chrome 会按扩展 ID 隔离 `chrome.storage`。若当前加载的是无 `key` 的旧开发版，旧设置不能由新 ID 静默读取。

迁移流程：先在未添加 `key` 的本版本重新加载扩展并导出设置；随后将 `manifest.fixed-id.json.template` 的 `key` 字段合并到 `manifest.json`，重新加载扩展并导入该文件。音频不导出，会议标签页不自动采集；用户需明确重新加入频道。

Native Host 安装器必须使用 `packaging/chrome-native-host/com.meetbridge.hub.macos.json.template` 生成最终清单，并替换二进制绝对路径。禁止放宽 `allowed_origins`，禁止使用通配符。
