# 家庭积分管理系统 (Family Points)

一个**极简但完整**的家庭积分奖惩系统：成员管理、积分增减、任务与事件记录、看板统计，全部用 Python 标准库实现，**零依赖、低资源占用**，一台 128MB 的旧机器 / 低配 VPS 就能长期稳定运行。

> 家庭场景的"积分银行"：孩子做家务、完成作业、遵守约定 → 加分；赖床、超时、违约 → 扣分；积分可兑换零花钱或奖励。所有记录自动落库、自动备份，家长手机浏览器即可随时查看。

---

## 为什么需要它？

- **Excel 记账太乱**：积分、任务、扣分原因混在一起，回溯困难，多人（家长+孩子）无协作入口。
- **商业 SaaS 太重**：为家庭场景付费订阅不划算，数据还要托管在别人服务器上。
- **自部署最省心**：单文件后端 + 静态前端，复制到任意 Linux/Windows 服务器 `python3 server.py` 即跑，无数据库安装、无构建步骤。

## 功能特性

- **成员管理**：增删成员、显示名、头像（上传）、PIN 码登录态，家长/成员双角色。
- **积分流水**：加分/扣分/兑换三类操作，每条带原因、操作人、时间，支持筛选与回滚。
- **任务与事件**：预设任务模板、截止时间、重复规则，提交后家长审核通过才生效。
- **看板统计**：全员积分排行、趋势图、本周/本月变动，孩子一眼看懂"自己离目标还差多少"。
- **自动备份**：SQLite 数据库自动轮转备份（data/*.db.bak_*），数据不丢失。
- **PIN 锁定保护**：连续输错自动锁定，防止孩子"试密码"。
- **极低占用**：纯 Python 标准库（http.server + sqlite3），无框架、无 Node、无构建。

## 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 运行环境 | Python 3.6+（任意 OS） |
| 内存 | ≥ 128MB |
| 依赖 | **无**（仅标准库） |

### 方式一：直接运行（最快）

```bash
# 1. 上传源码到服务器（或 git clone）
git clone https://github.com/lovehaichina/family-points.git && cd family-points

# 2. 直接启动（默认监听 0.0.0.0:8787）
python3 server.py
```

浏览器访问 `http://服务器IP:8787` 即可。

### 方式二：systemd 守护 + Caddy 反代（推荐生产）

**systemd 服务** `/etc/systemd/system/family-points.service`：

```ini
[Unit]
Description=Family Points Server
After=network.target

[Service]
WorkingDirectory=/opt/family-points
ExecStart=/usr/bin/python3 /opt/family-points/server.py
Restart=always
RestartSec=3
Environment=FAMILY_HOST=127.0.0.1
Environment=FAMILY_PORT=8787

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now family-points
```

**Caddy 反代**（自动 HTTPS）：

```
family.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
caddy reload
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FAMILY_HOST` | `0.0.0.0` | 监听地址（反代时建议 `127.0.0.1`） |
| `FAMILY_PORT` | `8787` | 监听端口 |
| `FAMILY_DB` | `./data/family.db` | SQLite 数据库路径 |
| `FAMILY_AUTODEMO` | 空 | 置 `1` 则首次启动写入演示数据 |
| `FAMILY_PIN_LOCKOUT` | `60` | PIN 连续错误锁定秒数 |
| `FAMILY_SUBMIT_DEADLINE_HOURS` | `3` | 任务提交截止时限（小时） |
| `FAMILY_MEMBER_PIN_LOCKOUT` | `60` | 成员 PIN 锁定秒数 |

> 家长账号密码不通过环境变量硬编码，部署后通过管理接口 / 配置文件注入（详见 `使用说明_v3.md`）。

## 首次使用

1. 浏览器打开站点，进入**家长登录**页，按 `使用说明_v3.md` 初始化家长账号密码。
2. 在「成员管理」添加家庭成员，系统自动生成成员 PIN 码（默认 `1234`，可在成员详情修改）。
3. 在「任务管理」创建任务模板（如"洗碗 +5 分"），成员提交后家长审核。
4. 成员用 PIN 登录自己的页面，查看积分、提交任务、发起兑换。

忘记成员 PIN？运行 `python3 reset_pin.py` 重置。

## 目录结构

```
family-points/
├── server.py          # 后端主程序（单文件，约 134KB）
├── reset_pin.py       # PIN 重置工具
├── static/            # 前端静态资源
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── compat.css
├── data/              # 运行期生成：数据库 + 备份 + tokens（.gitignore）
└── 使用说明_v3.md      # 完整使用文档
```

## 安全说明

- 所有账号密码通过环境变量或配置文件注入，**不入库、不入 Git**。
- 数据库与令牌文件位于 `data/`，已加入 `.gitignore`。
- 生产环境务必置于 Caddy/Nginx 反代之后并启用 HTTPS。

## 常见问题

**Q：能用 Windows 跑吗？**
能。安装 Python 3 后直接 `python server.py`；监听 0.0.0.0 时局域网设备可访问。

**Q：数据会丢吗？**
不会。SQLite 数据自动轮转备份在 `data/` 下，且推荐配合你的服务器备份策略（如 restic/R2）定期异地备份。

**Q：支持多少人同时用？**
家庭场景（≤10 人）完全无压力；纯标准库 + SQLite，并发能力取决于机器。

## License

[GPL-3.0](LICENSE) © 2026 luohai
