# 桌面端签名(采购前置,别拖到上线)

流水线是 [`.github/workflows/jin-desktop.yml`](../../.github/workflows/jin-desktop.yml)。**位置已经留好了,缺证书不判红**(产出未签名包 + 告警),所以证书采购不会卡住桌面端的构建验证。

但**上线前必须补齐**,否则:

| 平台 | 不签名的后果 |
|---|---|
| **macOS** | 没做 notarize,**Gatekeeper 直接拒绝启动**。不是警告,是打不开。 |
| **Windows** | SmartScreen 拦截警告,用户要点「仍要运行」。新证书需要累积信誉,越早开始签越好。 |

## macOS(要花钱,周期最长)

1. **Apple Developer Program**,99 USD / 年 —— 公司主体注册要 **D-U-N-S 编号**,没有的话申请要 1–2 周,**这是最长的前置周期**。
2. 证书类型:**Developer ID Application**(在 App Store 外分发就是这个,不是 Mac App Distribution)。
3. 导出 `.p12`,base64 后存成 secret。
4. 公证要一个 **App-Specific Password**(在 appleid.apple.com 生成)。

需要的 secrets:

| Secret | 说明 |
|---|---|
| `APPLE_CERTIFICATE_P12` | Developer ID 证书,`base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 p12 时设的密码 |
| `APPLE_ID` | 开发者账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 专用密码,用于公证 |
| `APPLE_TEAM_ID` | 10 位 Team ID |

## Windows

- **OV 代码签名证书**:几百块/年,签发要几天。
- **EV 证书**:贵一截,但**开箱即过 SmartScreen**(OV 要慢慢攒信誉)。面向 C 端用户建议直接上 EV。
- EV 证书通常绑硬件 token / HSM,**CI 里签名要用云签名服务**(Azure Trusted Signing / DigiCert KeyLocker),不能简单塞个 pfx。这个坑要在选型时就想到。

需要的 secrets:`WINDOWS_CERTIFICATE_PFX`、`WINDOWS_CERTIFICATE_PASSWORD`(若走云签名则换成对应服务的凭据)。

## 现在的状态

- [x] CI 的 Windows / macOS 构建 job 已就位(`apps/desktop` 还没进 main 时自动跳过)
- [ ] Apple Developer Program 账号(**采购,先启动 D-U-N-S**)
- [ ] Windows 证书(**先定 OV 还是 EV**,EV 要连带定云签名方案)
- [ ] secrets 灌进仓库
- [ ] 真机安装验证(签名生效后跑一次)
