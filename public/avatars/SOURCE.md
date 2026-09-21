# 头像图标来源与授权

这些 SVG 来自 **Microsoft Fluent Emoji**，取的是 `Color` 变体。

- 仓库：https://github.com/microsoft/fluentui-emoji
- 授权：**MIT License**（可自由用于商业/非商业项目，保留版权声明即可）
- 抓取日期：2026-09-21
- 文件命名：`<fluent 资产名>.svg`，与 `public/app.js` 里的 `AVATAR_FILE` 映射一一对应

## 为什么要换成图片

原来头像直接用 Unicode emoji 字符（`🐱🐶🦊…`），由**操作系统自己的 emoji 字体**渲染：

| 平台 | 实际使用的字体 | 观感 |
|---|---|---|
| Windows 11 | Segoe UI Emoji（Fluent 设计） | 用户喜欢的这套 |
| Android | Noto Color Emoji | 圆润、偏卡通 |
| iOS / macOS | Apple Color Emoji | 立体、光泽感 |

同一个字符在不同系统上画出来完全不一样，所以同一局游戏里
电脑端和手机端的头像会长得不同。换成图片后所有设备完全一致。

## 已知差异

Fluent Emoji 与 Windows 11 的 Segoe UI Emoji **不是同一份快照**，
18 个里有 17 个肉眼几乎一致，只有 `octopus.svg`（🐙）颜色不同：
系统渲染是橙色，Fluent Emoji 是粉紫色。

## 映射表（emoji → 文件）

| emoji | 文件 | Fluent 资产名 |
|---|---|---|
| 🐱 | cat.svg | Cat |
| 🐶 | dog_face.svg | Dog face |
| 🦊 | fox.svg | Fox |
| 🐼 | panda.svg | Panda |
| 🐨 | koala.svg | Koala |
| 🐯 | tiger_face.svg | Tiger face |
| 🦁 | lion.svg | Lion |
| 🐮 | cow_face.svg | Cow face |
| 🐷 | pig_face.svg | Pig face |
| 🐸 | frog.svg | Frog |
| 🐵 | monkey_face.svg | Monkey face |
| 🦄 | unicorn.svg | Unicorn |
| 🐙 | octopus.svg | Octopus |
| 🦉 | owl.svg | Owl |
| 🐧 | penguin.svg | Penguin |
| 🐢 | turtle.svg | Turtle |
| 🦈 | shark.svg | Shark |
| 🐝 | honeybee.svg | Honeybee |

## 重新抓取

```bash
BASE="https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets"
curl -sL "$BASE/Cat/Color/cat_color.svg" -o cat.svg
# 带空格的目录要 URL 编码，例如 "Dog face" -> "Dog%20face"
```
