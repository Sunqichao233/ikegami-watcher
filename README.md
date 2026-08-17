# 池上自動車教習所 予約システム — 逆向分析笔记

> 最后更新：2026-07-31
> 目标：从网络预约系统中提取可预约时段（空き枠），最终实现自动监控 / 自动预约。

---

## 1. 系统概况

| 项目 | 值 |
|---|---|
| 站点标题 | 池上自動車教習所-インターネット予約システム |
| 前端栈 | jQuery 3.3.1 + Bootstrap + DataTables + bootbox + blockUI |
| 路径前缀 | `/el32/`（PC 版）、`/common-el30/`（公共资源）、`/30080001/`（本校定制 CSS） |
| 关键 CSS | `/el32/css/pc/reserve.css` |
| 关键 JS | `/el32/js/pc/common.js` |
| 服务端渲染 | 是（模板留下大量空白缩进，疑似 JSP / Thymeleaf 循环） |

---

## 2. 页面结构

预约日历由**三张 `table` 组成，互为转置**，靠 `.kirikae-btn`（切替按钮）切换横竖布局：

| 表 | class | 结构 |
|---|---|---|
| 表 1 | `set w-100 baseTable` | 日期表头（竖排，`tr.date` 每行一天） |
| 表 2 | `set yoyakuTable baseTable` | **主数据表**：行 = 日期，列 = 时限 |
| 表 3 | `set w-100 baseTable` | 转置版：行 = 时限，列 = 日期 |

**同一份数据在页面里存在两份**，解析时取一份即可（推荐 `.yoyakuTable`）。

### 日期表头的 class

- `td.view` — 平日
- `td.view.saturday` — 周六
- `td.view.sunday` — 周日

一屏固定显示 **7 天**。

---

## 3. 时限（コマ）映射

固定 12 限，`data-zigen` 即时限号：

| zigen | 时间 | zigen | 时间 |
|---|---|---|---|
| 1 | 9:00 | 7 | 15:00 |
| 2 | 10:00 | 8 | 16:00 |
| 3 | 11:00 | 9 | 17:00 |
| 4 | 12:00 | 10 | 18:00 |
| 5 | 13:00 | 11 | 19:00 |
| 6 | 14:00 | 12 | 20:00 |

---

## 4. 格子状态：`td.status{N}` ★核心★

| class | 含义 | 内部元素 | 确认度 |
|---|---|---|---|
| `status0` | **不可预约 / 満員** | 无链接，内容 `&nbsp;` 或两位数字 | 高 |
| `status1` | **可预约（空き枠）** | `<a class="simei">` | **高** ✅ |
| `status3` | **已预约（自分の予約）** | `<a class="cancel">`，文本为项目名如「ＡＴ模擬」 | 高 |
| `status7` | 疑似「当前时段」 | 无链接 | 低 ❓ |
| `status8` | 疑似「已过时间」 | 无链接 | 低 ❓ |
| `status2/4/5/6` | 未观测到 | — | 未知 ❓ |

> `status7` / `status8` 的推断依据：2026-07-31 那一屏中，当天 1〜5 限（9:00–13:00）为 `status8`，6 限（14:00）为 `status7`，7 限之后为 `status0`。符合「已过 / 当前 / 未来」的时序。**待用 CSS 颜色定义确认。**

### 链接类型

```html
<!-- 可预约 -->
<a class="simei" href="#"
   data-zigen="7" data-yoyaku="20260823"
   data-time="15:00" data-date="8月23日" data-week="(日)">&nbsp;</a>

<!-- 已预约（可取消） -->
<a class="cancel" href="#"
   data-zigen="7" data-yoyaku="20260801"
   data-time="15:00" data-date="8月1日" data-week="(土)">ＡＴ模擬</a>
```

**`data-*` 属性一览**（两种链接完全一致）：

| 属性 | 示例 | 说明 |
|---|---|---|
| `data-zigen` | `7` | 时限号 1–12 |
| `data-yoyaku` | `20260823` | 日期 `YYYYMMDD` |
| `data-time` | `15:00` | 开始时刻 |
| `data-date` | `8月23日` | 显示用日期 |
| `data-week` | `(日)` | 星期 |

`simei` 疑为「指名」（指名予約 = 指定教官）。**待确认是否还有非指名的预约入口。**

---

## 5. 未解之谜

### ❓ `status0` 里的两位数字

部分 `status0` 格子显示 `06` / `07` / `08` / `09` / `10`，无链接、不可点。

已观测样本：

```
2026-08-01  9限(17:00) → 06
2026-08-02  7限→07  8限→08  9限→10  10限→09
2026-08-04  9限→08  10限→07
2026-08-06  8限→06  9限→09  11限→10
2026-08-22  1限→06  2限→09  6限→07  8限→10
2026-08-23 10限→06
```

数值集中在 **06–10** 这个窄区间。推测方向：

- 車両番号 / 指導員番号（可能性较高 — 范围窄且固定）
- キャンセル待ち人数（可能性低 — 数值偏大）
- 空き台数（可能性低 — 同上）

**下一步**：在浏览器里看这些格子实际渲染成什么样（悬停有无 tooltip？颜色？）。

### ❓ 其他待确认

- [ ] `status2/4/5/6` 分别是什么
- [ ] 预约提交的真实 URL 与参数（POST body、CSRF token 字段名）
- [ ] 翻周 / 切换教习项目的请求方式
- [ ] Session 有效期与超时行为
- [ ] 一次能预约几限、有无每日上限

---

## 5.5 ★★ 会话模型与 EC05 ★★ 最关键的一节

### 登录页明示的两条硬约束

```
≪ご利用上の注意≫
・ブラウザの戻る、進む、更新ボタンは利用できません。
・複数ブラウザで当システムを利用することは出来ません。
```

翻译与含义：

| 原文 | 含义 | 对自动化的影响 |
|---|---|---|
| 戻る・進む・**更新**ボタンは利用できません | 后退 / 前进 / **刷新** 均会破坏会话 | **`F5` 和 `location.reload()` 全部禁用** |
| **複数ブラウザ**で利用することは出来ません | 一个账号同时只允许一个会话 | **脚本会话与人工会话会互相踢掉** |

### EC05 的重新定性

原先怀疑是「维护」或「限流」，**现已推翻**。

> 用户报告：「每次刷新都会报这个错误」
> 登录页明示：「更新ボタンは利用できません」

两者完全吻合 → **EC05 是刷新导致的会话／令牌失效**，不是服务端拒绝服务。

这套系统（`powered by e-license.jp`）几乎可以肯定使用了
**同步令牌模式（Synchronizer Token Pattern）**：每次页面渲染下发一个一次性 token，
提交后作废。按 F5 = 重放已作废的 token = `EC05`。

### 结论 — 对方案的根本性影响

| 判断 | 结论 |
|---|---|
| 账号 / IP 有没有被封？ | ❌ 没有。这是好消息 |
| 「降低轮询频率」能解决吗？ | ❌ **不能**。这不是频率问题，是机制问题 |
| 无头浏览器定时 `reload()` 可行吗？ | ❌ **根本不可行**。第一次刷新就 EC05 |
| 脚本与本人同时登录可行吗？ | ❌ 不可行。単一セッション制約 |

### 正确的数据刷新方式

**必须走系统认可的导航路径**，而不是刷新：

1. 点击页面上的「次の週 / 前の週」「再検索」等按钮 → 服务端下发新页面 + 新 token
2. 或复现该按钮触发的 POST 请求，**并携带当次页面里的最新 token**

→ 因此 §7.6（抓取内联脚本）从「有用」升级为 **「必须」**。
不拿到 token 字段名和导航请求，任何自动化都无从谈起。

---

## 5.6 登录接口

```
POST /el32/pc/login
Content-Type: application/x-www-form-urlencoded
```

| 字段 | 类型 | 值 / 约束 |
|---|---|---|
| `schoolCd` | hidden | `mSg1DWxRvAI-brGQYS-1OA==` ← 本校固定值 |
| `studentId` | text | 教習生番号，`maxlength=7` |
| `password` | password | `maxlength=16` |

关于 `schoolCd`：⚠️ **早期判断有误，已修正 —— 不是固定值，不能硬编码。**

实测两次取值：

```
登录页      : mSg1DWxRvAI-brGQYS-1OA==
nextWeek 请求: jqUVluUZJZA-brGQYS-1OA==
              ^^^^^^^^^^^ 变      ^^^^^^^^^^^^^ 不变
```

以 `-` 分段看：`{变化段}-brGQYS-1OA==`，后两段恒定，首段每次不同。
推测首段含会话标识或随机 IV。

→ **必须从当前页面的 `input[name=schoolCd]` 动态读取**，每次请求都用最新值。

登录按钮是 `<button type="button" id="login">`（**非 submit**），
说明提交由 JS 接管 —— 很可能在提交前追加 token 或做加密。
→ 又一个必须抓 §7.6 的理由。

> 🔒 **本文件严禁写入教習生番号与密码。** 凭据请放入 `.env` 或系统凭据管理器，
> 并确保 `.env` 已加入 `.gitignore`。

---

## 5.7 ★ API 端点全表 ★

取自预约页内联脚本的变量声明。画面编号 `p03a` = 预约日历
（对照：登录页表单 id 为 `p01AForm`，即 `p01` = 登录）。

### 预约日历相关（前缀 `/el32/pc/reserv/p03/p03a/`）

| 变量 | 路径 | 用途 | 对自动化的价值 |
|---|---|---|---|
| `nextWeekUrl` | `…/nextWeek` | **下一周** | ⭐⭐⭐ 替代刷新的正规导航 |
| `lastWeekUrl` | `…/lastWeek` | **上一周** | ⭐⭐⭐ 同上 |
| `simeiUrl` | `…/simei` | **点击空位**（第 1 步） | ⭐⭐⭐ 与 `a.simei` 完全对应 |
| `confirmUrl` | `…/confirm` | **确认预约**（第 2 步） | ⭐⭐⭐ |
| `cancelConfirmUrl` | `…/cancelConfirm` | 取消确认（第 1 步） | ⭐⭐ |
| `cancelUrl` | `…/cancel` | 执行取消（第 2 步） | ⭐⭐ |
| `carChangeUrl` | `…/carChange` | 切换**車種** | ⭐⭐ 决定日历内容 |
| `instructorChangeUrl` | `…/instructorChange` | 切换**指導員** | ⭐⭐ 同上 |
| `busUrl` | `…/bus` | 送迎バス预约 | — |

### 其他

| 变量 | 路径 | 用途 |
|---|---|---|
| `sendMailUrl` | `/el32/pc/send/mail/nav` | **邮件通知设置** ⭐⭐⭐ 见下 |

### 功能开关

| 变量 | 值 | 推测 |
|---|---|---|
| `completeMsgViewFlg` | `'1'` | 完成提示的显示开关 |
| `el25Flg` | `''` | 某可选模块，本校未启用 |

### 由此确认的三件事

**① 预约是两步流程，取消也是**

```
点击空位 → POST simei → 显示确认画面 → POST confirm → 完成
已约项目 → POST cancelConfirm → 确认画面 → POST cancel → 完成
```

→ 自动预约必须**串起两个请求**，且第二步大概率携带第一步下发的新 token。

**② 翻周有专用端点，无需刷新**

`nextWeek` / `lastWeek` 正是 §5.5 所说的「系统认可的导航路径」。
油猴脚本应触发这两个，而非 `location.reload()`。

**③ `status0` 里的 06–10 数字 —— 谜题基本解开**

存在 `instructorChange`（指導員切替）功能，说明日历是按**指導員**维度组织的。
那些两位数字极可能是**指導員番号**（或車両番号，因同时存在 `carChange`）。
→ 待用页面实际渲染效果确认。

---

## 5.8 ★★★ 官方邮件通知 —— 已确认存在且已全部启用 ★★★

入口：`/el32/pc/send/mail/nav`（**仅 POST**，需从登录后菜单进入）
画面名：**送信種別の設定**

### 五种邮件

| 种别 | 直译 | 推定含义 | 空位相关 |
|---|---|---|---|
| 朝スケメール（6必ず） | 早间日程 | 每日 6:00 发送当日预约日程 | — |
| 仮免サクラメール | 仮免合格 | 临时驾照考试合格通知（サクラサク = 合格） | — |
| **乗れるよメール** | 能上车了 | **出现可预约空位时通知** | ⭐⭐⭐ |
| **見てみてメール** | 看一看 | **有新名额放出，提示查看日历** | ⭐⭐⭐ |
| **すぐ来てメール** | 马上来 | **当日临时取消 → 立即通知**（≈ キャンセル待ち） | ⭐⭐⭐ |

**当前状态：五项全部已勾选启用。**

### 影响：脚本从「主力」降级为「补充」

官方通知是**事件驱动**，取消发生的瞬间推送，性能上碾压任何轮询：

| 对比 | 官方邮件 | `monitor.py` |
|---|---|---|
| 实时性 | 事件驱动，即时 | 轮询，最长延迟 = 间隔 |
| 会话冲突 | 无 | 単一セッション制約 |
| 页面改版 | 不受影响 | 直接失效 |
| EC05 风险 | 无 | 有 |
| **可靠性** | ⚠️ **见下** | ✅ 自己可控 |

### ⚠️ 官方邮件的唯一弱点（页面自己写明的）

```
【重要】メールは、回線や通信設備の混雑状況等により
遅延または不達となる場合があります（※）。
ご予約内容はメモを取るなど確実な方法で管理されることをお薦めいたします。
```

**系统自己承认邮件可能延迟或送不到。**

→ 因此最优解是**两者并用**：官方邮件为主，`monitor.py` 作兜底与主动扫描。

### 🔧 必须验证的事（勾选 ≠ 收得到）

- [ ] **邮箱地址已正确登记**（勾选种别与登记地址是两件事）
- [ ] 若用日本手机邮箱（docomo / au / softbank）→ 设置**受信許可**，
      放行 `e-license.jp` 域名，否则会被运营商静默拦截
- [ ] 检查垃圾邮件文件夹
- [ ] 实际收到过至少一封，确认链路通畅

---

## 5.9 ★★ nextWeek 实测请求（已抓包）★★

```http
POST /el32/pc/reserv/p03/p03a/nextWeek HTTP/1.1
Host: www.e-license.jp
Content-Type: application/x-www-form-urlencoded
Origin: https://www.e-license.jp
Referer: https://www.e-license.jp/el32/pc/reserv/p03/p03a
Cookie: JSESSIONID=<会话ID>.tomcat-el32-1
Sec-Fetch-Dest: document
Sec-Fetch-Mode: navigate
```

请求体：

```
schoolCd=jqUVluUZJZA-brGQYS-1OA%3D%3D
lastScreenCd=
dateInformationType=
groupCd=1
instructorTypeCd=0
page=1
changeInstructorFlg=0
carModelCd=301
instructorCd=0
infoPeriodNumber=
nominationInstructorCd=0
kamokuCd=0
selectTime=
```

### 参数释义

| 参数 | 实测值 | 推测含义 | 备注 |
|---|---|---|---|
| `schoolCd` | `jqUVluUZJZA-brGQYS-1OA==` | 学校标识（加密） | ⚠️ 每次变，须动态取 |
| `lastScreenCd` | 空 | **上一画面代码** | 疑似防刷新机制核心 |
| `groupCd` | `1` | 组别 | |
| `carModelCd` | `301` | **車種代码** | 结合已预约的「ＡＴ模擬」，推测 301 = AT 车 |
| `instructorCd` | `0` | 指導員 | `0` = 不指定 |
| `nominationInstructorCd` | `0` | 指名指導員 | 对应 `simei` 功能 |
| `kamokuCd` | `0` | 科目 | `0` = 全部 |
| `instructorTypeCd` | `0` | 指導員種别 | |
| `changeInstructorFlg` | `0` | 指導員变更标志 | |
| `page` | `1` | 页码 | |
| `dateInformationType` | 空 | | |
| `infoPeriodNumber` | 空 | | |
| `selectTime` | 空 | 选定时刻 | 预约时才填 |

### ⭐ 三个决定性结论

**① 没有 CSRF token**

请求体里**不存在**任何 `_csrf` / `token` / `_token` 字段。
会话控制**完全依赖 `JSESSIONID`**。

→ 这大幅简化了自动化：只要维持一个 Cookie，就能复现全流程。
→ 也说明 §5.5 里「同步令牌模式」的猜测**不成立**，需修正（见下）。

**② EC05 的机制修正**

既然没有 token，防刷新靠的应是**服务端会话状态机** ——
服务端记录「当前应处于哪个画面」，`lastScreenCd` 参数用于校验流转是否合法。
按 F5 时浏览器重发上一个 POST，画面状态对不上 → EC05。

→ 结论不变：**不能刷新**。但原因是状态机而非 token 重放。

**③ `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`**

翻周**不是 AJAX，是整页表单提交跳转**。
响应是完整 HTML 页面，直接解析即可，无需处理 JSON。

---

## 5.9b ★★★ confirm 请求 —— 参数映射完全解开 ★★★

```http
POST /el32/pc/reserv/p03/p03a/confirm
Referer: https://www.e-license.jp/el32/pc/reserv/p03/p03a
```

```
schoolCd=mSg1DWxRvAI-brGQYS-1OA%3D%3D
lastScreenCd=
dateInformationType=20260824      ← 变了
groupCd=1
instructorTypeCd=0
page=4                            ← 变了
changeInstructorFlg=0
carModelCd=301
instructorCd=0
infoPeriodNumber=4                ← 变了
nominationInstructorCd=0
kamokuCd=0
selectTime=12%3A00                ← 变了
```

### ⭐ 决定性发现：HTML 属性直接映射到请求参数

与 §4 记录的 `<a class="simei">` 对照：

```html
<a class="simei" data-zigen="4" data-yoyaku="20260824"
   data-time="12:00" data-date="8月24日" data-week="(月)">
```

| HTML `data-*` | → | 请求参数 | 值 |
|---|---|---|---|
| `data-yoyaku` | → | `dateInformationType` | `20260824` |
| `data-zigen` | → | `infoPeriodNumber` | `4` |
| `data-time` | → | `selectTime` | `12:00`（URL 编码为 `12%3A00`） |
| — | → | `page` | `4` ← 与 zigen 相同，疑似同源 |

**完全吻合**：8月24日 4限 12:00 正是 §6 快照 B 中记录的空位之一。

→ **结论：解析出 `a.simei` 后，可直接由其 `data-*` 构造预约请求，无需中间步骤。**

### 与 nextWeek 的差异

| 参数 | nextWeek | confirm |
|---|---|---|
| `dateInformationType` | 空 | `20260824` |
| `infoPeriodNumber` | 空 | `4` |
| `selectTime` | 空 | `12:00` |
| `page` | `1` | `4` |
| 其余 9 个参数 | 完全相同 | 完全相同 |

→ **两个端点共用同一套参数模板**，只是「选中项」相关字段填不填的区别。
→ 可写一个统一的参数构造函数，按需填充。

### ⚠️ 关于 `schoolCd` 的再修正

三次观测：

```
登录页    : mSg1DWxRvAI-brGQYS-1OA==
nextWeek : jqUVluUZJZA-brGQYS-1OA==
confirm  : mSg1DWxRvAI-brGQYS-1OA==   ← 与登录页相同！
```

**不是「每次都变」**，而是存在**多个有效编码**（首段不同，后两段恒定）。
推测：加密含随机成分，但服务端只校验解密结果。

→ 实践上仍**建议动态提取**（从当前页面的 `input[name=schoolCd]`），
   但即使复用旧值大概率也能通过。

### ❓ 待确认：confirm 是第几步

原推测流程为 `simei` → `confirm`，但 confirm 已携带完整的日期/时限/时刻，
更像是**点击空位后的第一步**（进入确认画面）。

那么 `simeiUrl` 的作用需重新判断：
- 可能是「指名予約」（指定教官）的**独立入口**
- `a.simei` 的 class 名可能只是样式，与端点无关

→ 待办：在确认画面上点「予約する」，抓取**最终提交**的请求。

---

## 5.10 邮件通知入口：需 POST

```
GET /el32/pc/send/mail/nav  →  405 Method Not Allowed
```

该端点**只接受 POST**，无法用地址栏直接访问。

→ 必须在登录后的页面上找到指向它的**菜单项或按钮**（form submit）。
→ 待办：登录后在菜单里找「メール設定」「お知らせ」等入口。

---

## 6. 数据快照

### 快照 A：2026-07-31 〜 08-06

当前阶段无任何可预约空位（全 `status0`）。已预约 1 件：

| 日期 | 时限 | 内容 |
|---|---|---|
| 2026-08-01 (土) | 7限 15:00 | ＡＴ模擬 |

### 快照 B：2026-08-21 〜 08-27 ★有空位★

| 日期 | 可预约时限（`status1`） |
|---|---|
| 08-21 (金) | 无 |
| 08-22 (土) | 无 |
| 08-23 (日) | 1, 7, 8, 9, 11 |
| 08-24 (月) | 1, 4, 7, 8, 9, 10 |
| 08-25 (火) | 1, 3, 4, 6, 7, 8, 9, 10, 11, 12 |
| 08-26 (水) | 1, 2, 3, …（数据截断，未完整） |
| 08-27 (木) | 未取得 |

> **观察**：空位集中在 8 月下旬的平日，周五・周六几乎全満。8/25(火) 几乎全天可约。

---

## 7. 提取方法

### 7.1 导出表格 HTML（去噪版）

浏览器 F12 → Console：

```js
copy([...document.querySelectorAll('table')]
  .map(t => t.outerHTML.replace(/\s(style|data-immersive[\w-]*)="[^"]*"/gi,''))
  .join('\n<!-- ==== -->\n'))
```

> ⚠️ **必须先关闭沉浸式翻译等插件**，否则注入的 base64 字体会占满输出。

### 7.2 直接提取空位（推荐 — 输出最小）

```js
copy(JSON.stringify([...document.querySelectorAll('.yoyakuTable a.simei')].map(a => ({
  date:  a.dataset.yoyaku,
  zigen: +a.dataset.zigen,
  time:  a.dataset.time,
  week:  a.dataset.week
})), null, 1))
```

### 7.3 提取已预约

```js
copy(JSON.stringify([...document.querySelectorAll('.yoyakuTable a.cancel')].map(a => ({
  date:  a.dataset.yoyaku,
  zigen: +a.dataset.zigen,
  time:  a.dataset.time,
  item:  a.textContent.trim()
})), null, 1))
```

### 7.4 状态分布统计（快速摸清有哪些 status）

```js
copy(JSON.stringify([...document.querySelectorAll('.yoyakuTable td[class^=status]')]
  .reduce((m,td) => {
    const k = td.className;
    (m[k] ??= {n:0, hasLink:false, samples:[]});
    m[k].n++;
    if (td.querySelector('a')) m[k].hasLink = true;
    const t = td.innerText.trim();
    if (t && m[k].samples.length < 5 && !m[k].samples.includes(t)) m[k].samples.push(t);
    return m;
  }, {}), null, 1))
```

### 7.5 待跑：拿 CSS 语义

```js
fetch('/el32/css/pc/reserve.css').then(r=>r.text()).then(t=>
  copy((t.match(/\.status\d+[\s\S]*?\}/g)||[]).join('\n')))
```

### 7.6 待跑：拿页面内联脚本（预约提交逻辑）

```js
copy([...document.querySelectorAll('script:not([src])')]
  .map(s=>s.textContent).join('\n//========\n'))
```

### 7.7 待跑：拿表单字段（学员 ID / CSRF）

```js
copy([...document.querySelectorAll('form')].map(f =>
  f.method+' '+f.action+'\n'+[...f.elements].map(e=>`  ${e.name}=${e.value}`).join('\n')
).join('\n\n'))
```

---

## 8. 策略与待办

### 8.1 可行方案对比（据 §5.9 再次修订）

| 方案 | 可行性 | 说明 |
|---|---|---|
| 无头浏览器定时 `reload()` | ❌ 不可行 | 刷新即 EC05 |
| **纯 HTTP 请求（requests / axios）** | ✅ **可行** | 无 CSRF token，只需维持 JSESSIONID |
| **油猴脚本 + 点击「次の週」** | ✅ **推荐** | 零会话冲突，最安全 |

> §5.9 确认无 CSRF token 后，纯 HTTP 方案从「有条件」升级为「可行」。
> 但它仍会**踢掉你本人的登录**（単一セッション制約），
> 因此日常使用仍推荐油猴方案；纯 HTTP 适合无人值守场景。

### 8.1b 纯 HTTP 方案要点

```
1. POST /el32/pc/login          → 取得 JSESSIONID
2. 从响应 HTML 提取 schoolCd     ← 每次都要重新提取
3. POST …/p03a/nextWeek         → 带 Cookie + 最新 schoolCd
4. 解析响应 HTML 里的 a.simei    → 得到空位
5. 循环 3–4 翻周
```

铁律：

- ❌ 绝不重复提交同一个请求（等同于刷新）
- ✅ `schoolCd` 每次从上一个响应里重新提取
- ✅ 带上 `Referer: …/reserv/p03/p03a`
- ✅ 复用同一个 Session 对象保持 Cookie

### 8.2 推荐方案：油猴脚本

核心设计：

1. **绝不调用 `location.reload()`** — 这是红线
2. 改为**模拟点击页面上的「再検索」/「次の週」按钮**触发服务端重新下发页面
3. 页面更新后解析 `a.simei`，与上次快照 diff
4. 发现新空位 → 声音提醒 + 桌面通知 + 高亮
5. 间隔 **10–15 分钟 + 随机抖动**（教习所空位来自他人取消，是小时级事件，秒级轮询无意义）
6. 检测到 EC05 页面 → **立即停止**并告警，不自动重试

### 8.2b 最终方案：官方邮件 + 脚本兜底

```
主力  ：官方邮件通知（すぐ来て / 乗れるよ / 見てみて）—— 已全部启用
兜底  ：monitor.py 低频扫描 —— 应对邮件延迟/不达，并主动看更远的周
补充  ：窓口でキャンセル待ち登録 —— 受付能看到系统未放出的名额
```

脚本的定位随之改变：

- ❌ 不再需要高频轮询（邮件已覆盖实时性）
- ✅ 改为**低频 + 扫描更远周次**（邮件通常只覆盖近期，脚本可扫 8–12 周）
- ✅ 建议 `--interval 3600`（1 小时）甚至每天跑几次即可

---

### 8.3 待办

**🔴 安全 — 立即处理**
- [ ] **正常登出一次**，销毁已泄露的 JSESSIONID（曾贴在聊天中）
- [ ] 今后分享 cURL 前删除 `-b` / `Cookie` 行

**🥇 第一优先 — 确保官方邮件真的收得到**
- [x] ~~找到邮件设置入口~~ ✅ 已找到（§5.8）
- [x] ~~确认有空位通知种别~~ ✅ 三种，且已全部勾选
- [ ] **确认邮箱地址已正确登记**（勾选 ≠ 收得到）
- [ ] 若为日本手机邮箱 → 放行 `e-license.jp` 域名（受信許可設定）
- [ ] 检查垃圾邮件箱
- [ ] 实测收到至少一封

**🥈 第二优先 — 补齐剩余请求**
- [x] ~~nextWeek 请求~~ ✅ 已取得（§5.9）
- [ ] Network → 点一次**空位**（`a.simei`）→ Copy as cURL（**去掉 Cookie**）
- [ ] Network → 走完**确认画面**（`confirm`）→ Copy as cURL
- [ ] 确认 `lastScreenCd` 在什么情况下非空
- [ ] 弄清 `carModelCd=301` 等代码表（有哪些车种可选）

**恢复访问**
- [ ] 重新登录（**不要按 F5**，从首页正常进入）
- [ ] 确认 EC05 随之消失 → 验证 §5.5 的判断

**结构补全**
- [ ] 跑 §7.5，确认 `status0/1/3/7/8` 的颜色语义
- [ ] 确认 06–10 数字 = 指導員番号 还是 車両番号
- [ ] 找出「次の週」按钮的选择器（油猴脚本要点它）

**实现**
- [ ] 编写油猴监控脚本（仅在无官方通知时）

---

## 8.4 ★ 实现：`ikegami-watcher.user.js`（推荐）

油猴脚本。**在「次の週 / 前の週」之间往返导航**，以合法路径达成"刷新"效果，
绕开 EC05（§5.5）。跑在已登录的浏览器里，无会话冲突。

### 安装

1. 装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本 → 粘贴 `ikegami-watcher.user.js` 全文 → 保存
3. 登录预约系统，进入日历页 → 右下角出现面板 → 点「开始」

### 为什么必须用油猴而不是 Console

翻周是**整页跳转**（§5.9 `Sec-Fetch-Mode: navigate`），
Console 里粘的脚本会随页面卸载而消失。
油猴脚本每次页面加载都会重新注入，靠 `localStorage` 跨页面保持状态。

### ⚙ 监控条件设置（v1.4.0 起，图形界面）

点面板上的 **⚙** 按钮打开设置窗，**不必改代码**。配置存于
`localStorage.ikg_rules`，跨页面与重启保持。

**上半部：星期 × 时限 网格**

```
      9  10 11 12 13 14 15 16 17 18 19 20
 日   ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■
 月   □  □  □  □  □  □  □  □  □  □  ■  ■
 火   □  □  □  □  □  □  □  □  □  □  ■  ■
 …
 土   ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■  ■
```

点格子切换，绿色 = 监控。7 × 12 = 84 个组合任意勾选。
快捷预设：`全选` `全清` `平日夜间 19–20` `周末全天` `反选`。

**下半部：特定日期区间**

每条 = 起止日期 + 该区间内要监控的时限（可单独勾选，或点「全天」）。
可添加多条，**优先级高于星期表**。适合暑假、连休等能整天来的时期。

**判定优先级**：特定日期区间 → 星期表。
命中区间的日期在现况推送里标 `◎`。

> 保存时会一并**重置已见快照**（`ikg_seen`）——
> 条件变了，之前"已通知过"的记录不再适用，否则新纳入的时段不会告警。

### 脚本顶部 `CFG`

| 项 | 默认 | 说明 |
|---|---|---|
| `sweepWeeks` | `2` | 往返跨度。2 = 本周↔下周；3 = 本周→+1→+2→折返 |
| `intervalMs` | `60000` | 导航间隔，建议 ≥ 30 秒 |
| `jitterMs` | `15000` | 随机抖动 ±，避免固定节奏 |
| `weekdayZigen` / `weekendZigen` / `fullDayRanges` | — | **仅作首次使用的初始值**，之后由 ⚙ 界面接管 |

> ⚠️ 改 `CFG` 里的时段配置**不会覆盖**已保存的设置。
> 要让代码里的值重新生效，需在设置窗点「重置为默认」。

> 日期补全：`td.view` 只有「8月21日」没有年份。脚本先从该行任意
> `a[data-yoyaku]` 取完整日期作锚点，再按天数偏移推算其余各天；
> 整周无任何链接时，退回「推定年份 + 页面月日」。
> 星期则优先从 `data-week`（`(土)`）解析，失败才由日期推算。

### 状态机

```
页面加载 → 扫描 a.simei → 按条件筛选 → 与 localStorage 快照 diff
        → 有新的则通知 → 等待 interval → 点「次の週」或「前の週」
        → 整页跳转 → 回到「页面加载」
```

`sweepWeeks=2` 时的导航序列：`next → prev → next → prev → …`

### 面板按钮

| 按钮 | 作用 |
|---|---|
| **⚙** | 打开监控条件设置（星期 × 时限网格 + 特定日期区间） |
| **测试** | 发一条固定内容的测试消息，验证各渠道配置是否正确 |
| **现况** | 把**当前这一周**的完整空位情况推送到各渠道（不响铃、不影响监视状态） |
| **📋** | 复制全部日志到剪贴板 |
| **🗑** | 清空日志 |
| **开始 / 停止** | 启停自动往返监视 |

### 日志

**三个位置**：

1. **面板日志区** —— 最新在最上方，黄色为错误
2. **浏览器 Console**（F12）—— 搜 `[ikegami]`，含完整请求 URL 与原始响应
3. **`localStorage.ikg_log`** —— 结构化存储，最多 300 条

> ⚠️ 翻周是整页跳转，面板会重建。因此日志**同时写入 localStorage**，
> 页面加载后自动恢复，跨页面保留完整历史（v1.3.0 起）。
> 每次页面载入会插入一条 `━━━ 页面载入 vX.Y.Z` 分隔线。

**发送结果的日志格式**：

```
✓ Server酱 — HTTP 200 (243ms)
✗ Server酱 — code=40001 bad sendkey (198ms)
   ↳ {"code":40001,"message":"bad sendkey","data":null}
```

注意脚本会**检查业务错误码**而非只看 HTTP 状态 ——
Server酱 / PushPlus 失败时常返回 `HTTP 200` 但 `code != 0`。

| 日志 | 含义 | 处理 |
|---|---|---|
| `✓ … HTTP 200` | 成功 | — |
| `✗ … code=4xxxx` | 业务错误（key 错、额度用尽） | 看 `↳` 里的 message |
| `✗ … HTTP 404` | 接口地址错（Server酱新旧版判断失误） | 核对 SendKey 前缀 |
| `✗ … 连接失败` | **油猴拦截了跨域请求** | 检查脚本设置里的域名白名单 |
| `⚠ … GM_xmlhttpRequest 不可用` | `@grant` 未生效 | 确认脚本头部完整粘贴 |

**「现况」推送的内容示例**

```
08/21(金)  ―
08/22(土)  ―
08/23(日)  9 15 16 17 19時  ★5
08/24(月)  9 12 15 16 17 18時
08/25(火)  9 11 12 14 15 16 17 18 19 20時  ★2
08/26(水)  9 10 11 12時
08/27(木)  ―  [予約:15時]
─────────────
空位 31 件 / 命中条件 7 件

★ 08/23(日) 9 15 16 17 19時
★ 08/25(火) 19 20時
```

- 数字为**小时**（9 = 9:00，19 = 19:00）
- `★N` = 该日有 N 个符合筛选条件的空位
- `[予約:…]` = 你已预约的时段
- `―` = 当日无空位

### 通知渠道

**本机**（默认已开，无需配置）

| 方式 | 原理 |
|---|---|
| 声音 | `AudioContext` 合成蜂鸣，不依赖音频文件 |
| 桌面通知 | `GM_notification` / `Notification` API |
| 标题闪烁 | 改 `document.title`，回到页面自动停 |

**微信**

| 服务 | 配置项 | 获取方式 | 限制 |
|---|---|---|---|
| **PushPlus** | `pushplus` | [pushplus.plus](https://www.pushplus.plus) 微信扫码 → 复制 token | 免费版每日 200 条 |
| **Server酱³** | `serverchan` | [sct.ftqq.com](https://sct.ftqq.com) 微信扫码 → SendKey | 免费每日 5 条 |
| **企业微信机器人** | `wecom` | 群设置 → 群机器人 → 添加 → Webhook 地址 | 免费无限，需企业微信 |

**手机弹窗**

| 服务 | 配置项 | 获取方式 | 特点 |
|---|---|---|---|
| **Bark** | `bark` | App Store 装 Bark → 复制 URL | iOS 首选，`barkLevel:'critical'` 可穿透静音 |
| **ntfy** | `ntfy` | 装 ntfy App 订阅 topic → `https://ntfy.sh/你的topic` | 开源免费，iOS/Android 通用 |
| **Telegram** | `telegram` | @BotFather 建 bot | 跨平台 |
| **Discord** | `discord` | 频道设置 → 整合 → Webhook | 有 Discord 就最省事 |

> 跨域说明：这些请求走 `GM_xmlhttpRequest` + `@connect *`，
> 因此**不受同源策略限制**。这是必须用油猴而非 Console 的第二个理由。

### 安全设计

- 检测到 `EC05` / `システムエラー` → **立即自停** + 蜂鸣告警，绝不硬重试
- 找不到导航按钮时，兜底构造表单 POST（参数从页面现有 input 读取，见 §5.9）
- 非日历页时不动作

---

## 8.5 实现：`monitor.py`

已实现纯 HTTP 轮询脚本，无需浏览器。

```powershell
pip install -r requirements.txt

$env:IKEGAMI_ID="你的教習生番号"
$env:IKEGAMI_PW="你的密码"

python monitor.py --once           # 先试一次
python monitor.py --weeks 8        # 持续监控，向后扫 8 周
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--once` | — | 扫描一次后退出 |
| `--weeks N` | 4 | 向后扫描几周 |
| `--interval N` | 900 | 轮询间隔秒（含 ±120 秒随机抖动） |
| `--state PATH` | `state.json` | 状态文件位置 |
| `--ignore-quiet` | — | 忽略静默时段 |

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `IKEGAMI_ID` / `IKEGAMI_PW` | ✅ | 教習生番号与密码 |
| `IKEGAMI_CAR_MODEL` | — | 車種代码，默认 `301` |
| `IKEGAMI_WEEKDAY_ZIGEN` | — | 平日时限，如 `11,12` |
| `IKEGAMI_WEEKEND_ZIGEN` | — | 周末时限，空 = 全天 |
| `IKEGAMI_FULLDAY` | — | 全天区间，如 `20260808-20260816` |
| `IKEGAMI_QUIET_FROM` / `_TO` | — | 静默时段（JST 小时），默认 `0` / `7` |
| `SERVERCHAN_KEY` / `BARK_URL` / `NTFY_URL` / `PUSHPLUS_TOKEN` / `WECOM_WEBHOOK` / `TELEGRAM_URL` / `DISCORD_WEBHOOK` | — | 推送渠道，至少填一个 |

### 实现要点

- 每次响应后**重新提取 `schoolCd`**（§5.9b）
- 检测到 `EC05` / `システムエラー` → 抛 `SessionKilled`，**退避 30 分钟**，绝不硬重试
- 翻周之间 sleep 1.5–3.5 秒随机
- 两张转置表的空位按 `date-zigen` 去重
- 状态存 `state.json`，只对**新增**空位告警
- **静默时段**（JST 0:00–7:00）内直接退出／挂起，不扫描也不通知
- 推送前检查业务错误码，而非只看 HTTP 状态
- 凭据只走环境变量，不落盘（`.gitignore` 已排除 `.env` / `state.json`）

### ⚠️ 已知限制

| 限制 | 说明 |
|---|---|
| **単一セッション制約** | 脚本运行时会踢掉浏览器登录，反之亦然 |
| 登录后入口未验证 | `open_calendar()` 直接 POST `p03a`，可能需要先过菜单页 |
| 未实现自动预约 | 仅监控。`confirm` 之后的最终提交端点尚未抓到 |

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-07-31 | 建立文档。确认表格结构、12 时限映射、`data-*` 属性。观测到 `status0/3/7/8` |
| 2026-07-31 | **确认 `status1` = 可预约**，携带 `<a class="simei">`。记录 8/21–8/27 快照 |
| 2026-07-31 13:31 | 遭遇 EC05 错误（メンテナンス／アクセス集中）。初判为限流或维护 |
| 2026-07-31 | **推翻上条判断**。登录页明示「更新ボタンは利用できません」「複数ブラウザ不可」→ EC05 实为**刷新导致的会话失效**。取得登录接口 `POST /el32/pc/login` 与 `schoolCd` 固定值。方案改为「油猴 + 模拟点击导航」 |
| 2026-07-31 | 取得**全部 API 端点**（§5.7）。确认预约/取消均为两步流程；确认 `nextWeek`/`lastWeek` 可替代刷新；发现 `sendMailUrl` → **官方邮件通知可能使本项目大部分作废**（§5.8） |
| 2026-07-31 | 抓到 **nextWeek 完整请求**（§5.9）。三项关键结论：**① 无 CSRF token**，会话仅靠 JSESSIONID → 纯 HTTP 方案可行；② EC05 机制修正为「服务端会话状态机 + `lastScreenCd`」而非 token 重放；③ 翻周是整页表单跳转而非 AJAX。**修正 §5.6：`schoolCd` 每次变化，不可硬编码** |
| 2026-07-31 | 抓到 **confirm 请求**（§5.9b）。**参数映射完全解开**：`data-yoyaku`→`dateInformationType`、`data-zigen`→`infoPeriodNumber`、`data-time`→`selectTime`。确认 nextWeek 与 confirm 共用同一参数模板。**实现 `monitor.py`**（§8.5） |
| 2026-07-31 | **找到官方邮件通知**（§5.8）。三种空位相关邮件（すぐ来て／乗れるよ／見てみて）**已全部启用**。方案重定位：官方邮件为主，脚本降为兜底（§8.2b）。待验证邮箱是否真能收到 |
| 2026-07-31 | 实现 **`ikegami-watcher.user.js`**（§8.4）。以「次の週↔前の週」往返导航替代刷新；筛选条件为平日 19:00/20:00 + 周末全天；支持声音／桌面通知／标题闪烁／Bark／Telegram／Discord／自定义 Webhook |
| 2026-08-03 | 油猴脚本 v1.3.0：新增 `fullDayRanges`（8/8–8/16 全天监控）、日志跨页面持久化、发送结果诊断（检查业务错误码而非仅 HTTP 状态）、「现况」与「复制日志」按钮 |
| 2026-08-03 | **`monitor.py` 改造为常驻版**：加入推送渠道、JST 静默时段（0:00–7:00）、与油猴一致的筛选逻辑 |
| 2026-08-03 | 油猴脚本 **v1.4.0：图形化条件设置**。星期 × 时限 7×12 勾选网格 + 多条特定日期区间（每条可独立选时限）。配置存 `localStorage.ikg_rules`，取代原先写死在 `CFG` 里的 `weekdayZigen` / `weekendZigen` / `fullDayRanges` |
