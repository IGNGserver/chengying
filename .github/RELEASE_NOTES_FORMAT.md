# 澄影 Release 更新说明格式

每个版本使用一个独立文件：`.github/release-notes/<version>.md`。`<version>` 不带 `v`，并且必须与根目录 `VERSION` 和发布标签一致。

内容只写本次版本的变化，建议使用简短中文条目：

```markdown
- 新增：……
- 修复：……
- 兼容性：……
- 已知问题：……
```

不要把历史版本说明复制进新文件，也不要在 `.github/RELEASE_TEMPLATE.md` 中追加版本内容。正式版与 prerelease 共用同一份版本说明；发布类型由工作流决定。
