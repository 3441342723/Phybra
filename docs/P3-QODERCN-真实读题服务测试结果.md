# P3：QODERCN 真实读题服务测试结果

- 测试日期：2026-11-28
- 仓库：`D:\physics-workbench-muyansun`，分支 `main`，HEAD `f4d6298`
- 任务来源：`QODERCN-P3-真实读题服务测试任务.md`
- 结论摘要：**线上真实"服务端读题"链路已打通并完成 7 题逐题回归**；用户报告的 `HTTP 500` 根因是**本地 Vite 代理没有上游 Function（Deno 缺失）**，不是产品或云端函数缺陷。发现 4 项产品侧问题（2 中 / 2 低），均不产生错误物理答案。

---

## 0. 测试性质区分（重要）

| 类别 | 内容 | 是否调用真实云端模型 |
| --- | --- | --- |
| 本地契约测试 | `pnpm test`（26 文件 / 475 用例通过）、`pnpm run typecheck`（无错误）、`pnpm run test:function`（`FIXTURE: ALL PASSED`）、`pnpm run build`（成功，仅 >500 kB chunk 警告） | **否**。`dev/function-fixture.ts` 是 credential-free 契约 fixture，不是真实读题服务 |
| 线上真实模型测试 | 已发布站点 `https://physics-workbench-0nigdkgdgmj.qoder.zone/` 的"服务端读题"界面，逐题提交 → POST 202 + jobId → GET 轮询 → 终稿 → 审阅 → 应用 → 求解 → 撤销 | **是**。函数日志记录 `interpret_start` / `interpret_accepted` / `interpret_done`，含 `sessionId: sess_*`、`model: fast` |

本轮所有"读题成功"结论均来自第二类。未设置 `VITE_AI_DEMO=1`，未切换演示模式，未修改 AI 面板文案、错误映射或前端请求逻辑。

---

## 1. 环境检查（步骤 1）

```text
git status --short   → 8 个已修改文件 + 4 个未跟踪文件（全部保留，见 §7）
git rev-parse --short HEAD → f4d6298
git diff --check     → 无空白错误（仅 LF→CRLF 提示）
deno --version       → deno: command not found
```

- `vite.config.ts`：`server.proxy = { '/functions/v1/app': 'http://127.0.0.1:8000' }`，`server.port = 5173`。
- `dev/function-local.ts`：仅 `Deno.serve({ hostname: "127.0.0.1", port: 8000 }, handler)`，**依赖 Deno**。
- 本机未安装 Deno（`$USERPROFILE/.deno/bin`、Program Files 均无），也没有可用的本地 `QWEN_API_KEY` / `QODER_PAT` 环境变量。

**判定：本地后端运行环境缺失。** 按任务文件要求，未改用演示模式、未把 fixture 当真实服务，转到线上站点做真实用户界面验证。

---

## 2. HTTP 500 根因诊断（步骤 2）

### 2.1 复现证据

本地 5173 端口已被占用，本次自建的 Vite 开发服务器运行在 `127.0.0.1:5174`（未终止用户原有进程）。

```text
POST http://127.0.0.1:5174/functions/v1/app/interpret
Content-Type: application/json
X-Scene-Contract-Revision: fields-and-stages-v6
body: {"text":"test"}

→ status=500  bytes=0   （响应体 0 字节）
```

Vite 日志（`/tmp/vite-dev.log`）：

```text
18:03:57 [vite] http proxy error: /functions/v1/app/interpret
Error: connect ECONNREFUSED 127.0.0.1:8000
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1634:16)
```

`127.0.0.1:8000` 无 TCP 监听者。

### 2.2 根因

1. `functions/handler.ts` 的 `failure()` **只会返回** `InterpretError` 自带状态码、`CloudAgentsError` 映射码，或 `503 service_unavailable`（仅含类名/代码名）。**该函数在任何分支都不会返回 500。**
2. 因此"500 + 空响应体"来自 **Vite 开发代理的上游连接失败页**，而非边缘函数。
3. `src/ai/client.ts` 的 `mappedError()` 在响应体非 JSON / 无 `error` 字段时走兜底分支：`读题服务暂不可用（HTTP ${status}）`——与用户看到的文案完全一致（无错误码后缀）。

**结论：这是本地开发环境缺少 Function 上游导致的代理错误，不是线上产品缺陷。** 线上函数日志在同一时间窗内 **零 5xx**（见 §5）。

### 2.3 修复方式

- 本地：安装 Deno 后执行 `deno run --allow-net=127.0.0.1:8000 dev/function-local.ts`，再启动前端；健康检查 `http://127.0.0.1:8000/functions/v1/app?name=Physics` 应返回 `{"ok":true,"message":"Hello, Physics!"}`。**本轮因 Deno 缺失未能执行，如实记录为阻塞。**
- 线上：发布当前构建（见 §3），健康检查与契约版本均已核对通过。

未为了"消除 500"而修改任何前端文案、错误映射或请求逻辑。

---

## 3. 线上部署与版本核对（步骤 4 前置）

诊断初期发现线上运行的是**过期构建**：健康检查虽 200，但 `X-Scene-Contract-Revision` 为 `null`，前端 bundle 为 `index-DZF9aATr.js`，不含 `fields-and-stages-v6`。经用户明确批准（选择"发布当前构建再验证"）后，将当前 `dist` + `functions/` 发布到**同一私有站点**：

| 项 | 值 |
| --- | --- |
| projectId | `01a1fcc6-3d55-764e-9fbc-862d35791416` |
| siteId | `01a1fcc6-3d58-7dba-9bb2-0d1c3944332d` |
| actionId | `d159d5d1-4750-460d-9445-b179f2eff9e2` |
| 发布结果 | `published: true` / `committed: true` |
| 访问范围 | `private`（未改变） |
| 后端能力 | `functions, qoder, storage`，`status: ready` |
| 发布后 bundle | `index-z4p0wKWI.js`（含 `fields-and-stages-v6`） |

发布后健康检查（已登录浏览器会话，同源 fetch）：

```text
GET /functions/v1/app?name=Physics
→ 200  {"ok":true,"message":"Hello, Physics!"}
→ X-Scene-Contract-Revision: fields-and-stages-v6
```

未出现 `sites_gateway_login_required`（浏览器已登录 Qoder Sites）。

### 3.1 读题通道与凭据

- 站点**未配置 `QWEN_API_KEY`**，Qwen 通道处于禁用状态；实际走 **Cloud Agents 通道**（`QODER_PAT` 为平台保留凭据，仅在服务端读取）。
- 函数输出日志逐条确认通道：`{"event":"interpret_start","model":"fast","enabledModels":[...],"hasImage":false,"textChars":60}`、`{"event":"interpret_accepted","sessionId":"sess_*"}`、`{"event":"interpret_done","sessionId":"sess_*"}`。
- 日志中**只有字符数 `textChars`，没有题面原文**；没有题图 Base64；没有模型原始输出；没有任何 Secret / Token / Bearer 值。
- 前端构建产物与源码中不含凭据；`VITE_AI_ENDPOINT` 未设置，客户端走同源 `/functions/v1/app/interpret`。

### 3.2 界面模式核对

AI 面板徽标在**每一次**提交前均读取确认为 `服务端读题`（`badge ok`），不是`本地演示模式（不调用云端 AI）`，也不是`本地修订示例（非 AI 识别）`。

---

## 4. 逐题回归结果（步骤 3 / 步骤 5）

通用说明：

- 每题**单独提交**，提交前记录 `localStorage['phy.scene.v2']` 作为基线，生成期间核对场景未被改写。
- 耗时为浏览器实测（点击"生成场景草稿"→ 草稿渲染完成）。
- HTTP 链路：第 1 题在浏览器网络面板逐条核对（POST 202 → 7 次 GET 202 pending → GET 200 终稿）；其余各题由函数请求日志确认 POST 均为 202、终稿 GET 为 200，**全窗口零 5xx**。
- `known / assumed / unknown / uncertain / warnings` 完整性按 `src/ui/AiPanel.tsx:134-161` 的渲染规则核对（warnings 渲染为徽标，uncertain 渲染为已知量行内徽标）。
- 本轮 7 题 + 2 次补充提交的 `uncertain` 均为空数组（无"不确定"徽标）。

### 4.1 第 1 题 · 自由落体（步骤 3 指定题）

**题面**：`一个小球从距地面45 m高处由静止释放，取g=10 m/s²，忽略空气阻力，求落地时间和落地瞬间的速度。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202** + `jobId`（`7249bfa8…`）；GET 轮询 7 次 **202 pending**；终稿 GET **200** |
| 耗时 | 约 **31.9 s** |
| 错误码 | 无 |
| 合法 SceneDraft | **是**（`parseSceneDraft` 通过，契约 `fields-and-stages-v6`） |
| known | 3 项，全部含原文依据：初始高度 45（"距地面45 m高处"）、初速度 0（"由静止释放"）、重力加速度 -10（"取g=10 m/s²"） |
| assumed | 3 项：水平坐标原点 0、水平初速度 0、重力场范围 global，均附理由 |
| unknown | 2 项：落地时间、落地瞬间速度（待求量 `landing`） |
| uncertain / warnings | 0 / 0 |
| 生成期间原场景 | **未改变**（957 字节基线一致） |

**应用后场景**：`ball` 位于 `(0, 45)`，`vel (0,0)`，`mass: null`；`uniform_gravity` 全局场 `vector (0,-10)`；`gravity: null`。无错误默认值、无错误路径、单位正确。

**求解结果**：

1. 首次点击"检查并求解"被阻塞：`小球 · 质量 / 请填写有限数值。`（`missing_required`）
2. 手动补 `m = 1 kg`（题面未给质量）后：**落地时间 3 s、水平射程 0 m、落地速度大小 30 m/s（水平 0、竖直 -30）** —— 与解析解一致。

**撤销**：连续撤销 2 次（补质量 + 应用草稿）后，`phy.scene.v2` 与提交前基线**逐字节一致**（`rev 3`，标题恢复为原滑行题）。

**发现**：见 §6 F1。

---

### 4.2 第 2 题 · 基础运动（平抛）

**题面**：`一个小球从20 m高处以10 m/s的水平速度抛出，取g=10 m/s²，忽略空气阻力，求落地时间、水平射程和落地速度。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202**（日志 09:52:31，`textChars: 60`）→ GET 202 pending → 终稿 **200** |
| 耗时 | 约 **41.5 s** |
| 合法 SceneDraft | **是** |
| known | 3 项含依据：抛出点高度 20、水平初速度 10、重力加速度 10 |
| assumed | 2 项：抛出点水平坐标 0（含坐标系说明）、竖直初速度 0（"题面为水平抛出"） |
| unknown | 3 项：落地时间、水平射程、落地速度大小（待求量 `q-landing`） |
| uncertain / warnings | 0 / 0 |
| 生成期间原场景 | **未改变** |

**应用后场景**：`kind: projectile`，`pos (0,20)`，`vel (10,0)`，`mass: null`，`gravity: 10`，`asks: [{id: q-landing, kind: landing, y: 0}]`。电荷/场/碰撞/阶段：本题不涉及，未凭空添加（`fields: []`）。

**求解结果**：同样先被质量阻塞；补 `m = 1 kg` 后 **落地时间 2 s、水平射程 20 m、落地速度大小 22.4 m/s（水平 10、竖直 -20）** —— 正确（√500 ≈ 22.36）。

**撤销**：恢复至基线，逐字节一致。

**发现**：F1（同第 1 题）。

---

### 4.3 第 3 题 · 斜面摩擦

**题面**：`质量为2 kg的物块放在倾角30°的斜面上，静摩擦因数μs=0.7，动摩擦因数μk=0.2，取g=10 m/s²，判断物块是否会滑动。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202**（日志 09:53:47，`textChars: 67`）→ 终稿 **200** |
| 耗时 | 约 **46.2 s** |
| 自动修正 | 面板提示 **"AI 草稿已自动修正一次格式，请核对题目条件后应用。"**（服务端格式修复通道生效，原题文字保持不变） |
| 合法 SceneDraft | **是** |
| known | **5 项全部含依据**：g 10 m/s²、质量 2 kg、倾角 30°、μs 0.7、μk 0.2 |
| assumed | 2 项：物块初始位置 0（斜面低端，注明"不影响滑动判断"）、初速度 0 |
| unknown | 1 项：物块是否会滑动（待求量 `slide`，`kind: friction_state`） |
| uncertain / warnings | 0 / 0 |
| 生成期间原场景 | **未改变** |

**应用后场景**：`block mass 2`，`attach {support: slope, s: 0}`；`incline angleDeg 30, length: null`；`contacts {mu_s: 0.7, mu_k: 0.2}`；命名参数 `m / theta / g / mu_s / mu_k` 与绑定齐全。**静/动摩擦因数均正确保留，未被合并或省略。**

**求解结果**：

1. 首次被阻塞：`斜面 · 长度 / 缺少支撑面长度`（`missing_required`）—— 滑动判断本身不需要长度。
2. 手动补 `L = 5 m` 后：**`|tanθ|=0.577 ≤ μ_s=0.7，静摩擦自锁，物体保持静止`；首段加速度（沿面）0 m/s²；到达端点的时间 —（保持静止，不会到达端点）** —— 判断正确。

**撤销**：恢复至基线，逐字节一致。

**发现**：见 §6 F2。

---

### 4.4 第 4 题 · 电荷和电场

**题面**：`质量为0.02 kg、带正电荷q=1×10^-4 C的小球，以4 m/s的水平速度进入宽度为0.8 m的匀强电场区域。电场方向竖直向上，场强E=1000 N/C，取g=10 m/s²，求出场时间、竖直位移和出场速度。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202**（日志 09:55:23，`textChars: 108`）→ 终稿 **200** |
| 耗时 | 约 **49.7 s** |
| 合法 SceneDraft | **是** |
| known | **6 项全部含依据**：质量 0.02、电荷量 0.0001、水平初速度 4、电场区宽度 0.8、场强 1000、重力加速度 -10 |
| assumed | 6 项：入射点 x=0、入射点 y=0、入射竖直速度 0、场区中心 x=0.4、**场区近似高度 4（明确注明"题目未给出电场上、下边界，取足够覆盖预期轨迹的矩形近似"）**、场区中心 y=0 |
| unknown | 3 项：出场时间（`field_exit`）、竖直位移（`custom`）、出场速度大小（`custom`） |
| uncertain / warnings | 0 / 0 |
| 生成期间原场景 | **未改变** |

**应用后场景（电荷与场完整保留）**：

- `charge: +0.0001`，`charged: true`，`mass: 0.02`，`vel (4,0)`，`pos (0,0)`
- `uniform_electric`：`shape rect`，`center (0.4, 0)`，`width 0.8`，`height 4`，`vector (0, 1000)`（竖直向上，正确）
- `uniform_gravity`：`global`，`vector (0, -10)`
- `asks`：`exitTime` 为 `kind: field_exit` 且 `fieldId: electricField`
- 命名参数 `m / q / v0 / d / E / g`，绑定含 `fields.electricField.shape.width ↔ d`、`fields.electricField.vector.y ↔ E`

**求解结果（无需补任何值）**：

```text
场区穿越 · 1 次
首次出场时间 0.2 s      场内用时 0.2 s
场内位移 Δx 0.8 m       场内位移 Δy -0.1 m
出场位置 (0.8, -0.1)    vx 4 m/s   vy -1 m/s
速率 4.12 m/s           速度方向（相对 +x）-14 °
合力 Fx 0 N             合力 Fy -0.2 N
```

与解析解一致：`a_y = qE/m − g = 5 − 10 = −5 m/s²`，`t = 0.8/4 = 0.2 s`，`Δy = −0.1 m`，`v = √17 ≈ 4.12 m/s`。**电荷符号、场方向、场区边界、单位均正确。**

**撤销**：恢复至基线，逐字节一致。

**发现**：见 §6 F3（两个 `custom` 待求项显示"此问题已保留，当前没有对应的专用求解"，而数值其实已在场区穿越块给出）。

---

### 4.5 第 5 题 · 电荷反号（原题面引用"上一题"）

**题面（按任务文件原文提交）**：`将上一题中的电荷改为q=-1×10^-4 C，其他条件不变，重新求小球出场时的竖直位移和速度方向。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202**（日志 09:56:45，`textChars: 49`）→ 终稿 **200** |
| 耗时 | 约 **50.7 s** |
| 合法 SceneDraft | **是** |
| known | 1 项含依据：电荷量 q = **-0.0001** |
| assumed | **0 项（未虚构任何条件）** |
| unknown | 6 项：小球质量、初始水平位置、初始竖直位置、初速度水平分量、初速度竖直分量、出场竖直位移与速度方向 |
| uncertain | 0 |
| warnings | **3 条明确拒绝虚构**：① "未提供上一题题干/题图，无法确定场区类型、场强、边界、质量、初速度及出场条件；未计算竖直位移或速度方向。" ② "未虚构场强、场区边界、初速度或质量；请补充上一题条件后重建场景。" ③ "电荷已改为负值，若原题为匀强电场，电场力方向将与正电荷相反；但缺少原场方向，不能据此给出数值结果。" |
| 生成期间原场景 | **未改变** |

**应用后场景**：`charge: -0.0001`、`charged: true`；`mass / pos.x / pos.y / vel.x / vel.y` **全部为 null**；`fields: []`（未凭空造场）；标题 `上一题电荷改为 q=-1×10^-4 C（题干缺失，待补全）`；`asks` 保留原问题文字。**负电荷符号正确保留。**

**求解结果**：列出 5 条 `missing_required`（质量 / 位置.x / 位置.y / 速度.x / 速度.y），**没有任何虚构数值或默认 0**。符合"未知量不能默认为 0"的设计约束。

**撤销**：恢复至基线，逐字节一致。

#### 4.5.1 补充验证 · 把上一题条件写全后重新提交（非任务原题面）

为验证**电荷反号后的物理方向**，将第 4 题条件显式写全并把电荷改为负值后重新提交：

`质量为0.02 kg、带负电荷q=-1×10^-4 C的小球，以4 m/s的水平速度进入宽度为0.8 m的匀强电场区域。电场方向竖直向上，场强E=1000 N/C，取g=10 m/s²，求出场时间、竖直位移和出场速度方向。`

- HTTP POST 202 → 终稿 200，耗时约 **51.2 s**；warnings 1 条（"电场区竖直范围为建模示意值，不替代真实边界条件"）。
- known 6 项含依据（电荷量 **-1×10^-4 C**）；assumed 5 项（场区竖直中心 -1 m、高度 2.5 m 均标注"题面未给高度，取足够覆盖轨迹的示意值"）。
- 场景：`charge -0.0001`、`uniform_electric rect center (0.4,-1) width 0.8 height 2.5 vector (0,1000)`、`uniform_gravity global (0,-10)`。
- **求解结果**：`出场时间 0.2 s、Δy -0.3 m、vy -3 m/s、速率 5 m/s、方向 -36.9 °、Fy -0.2 N`。
- 与解析解一致：`a_y = qE/m − g = −5 − 10 = −15 m/s²`，`Δy = −0.3 m`，`v = 5 m/s`。**证明电荷反号后电场力方向正确反转（对比第 4 题 Δy −0.1 m / 4.12 m/s / −14 °）。**
- 同样存在 F3（`y_exit`、`dir_exit` 显示"当前场模型支持指定时刻、进出场和能量查询"）。

---

### 4.6 第 6 题 · 碰撞（完全弹性正碰，含阶段）

**题面**：`质量为0.1 kg的小球A以10 m/s向右运动，撞上质量为0.2 kg且静止的小球B，发生完全弹性正碰，求碰撞后两个小球的速度。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202** → GET 202 pending → 终稿 **200** |
| 耗时 | 约 **51.2 s** |
| 合法 SceneDraft | **是** |
| known | 5 项全部含依据：A 质量 0.1 kg、A 初速度 10 m/s、B 质量 0.2 kg、B 初速度 0 m/s、**恢复系数 1（"完全弹性正碰"）** |
| assumed | 5 项，均标注为示意值：A 初始 x −0.05 m、B 初始 x 0.05 m（间距 0.1 m 不小于两半径之和）、A/B 碰撞半径 0.01 m、碰后播放时长 1 s（"非题面测量值，仅用于展示"） |
| unknown | 2 项：碰撞后 A 的速度、碰撞后 B 的速度（`kind: collision`） |
| uncertain / warnings | 0 / 0 |
| **阶段** | **完整保留 4 个选项**：`主场景` / `完全弹性正碰 (main)` / `碰后小球A的运动 (A_after，自动带入前阶段碰后速度)` / `碰后小球B的运动 (B_after，自动带入前阶段碰后速度)` |
| 生成期间原场景 | **未改变** |

**应用后场景**：A `pos(-0.05,0) vel(10,0) mass 0.1 R 0.01`；B `pos(0.05,0) vel(0,0) mass 0.2 R 0.01`；`collision {restitution: 1, afterCollision: 1}`；`fields: []`、`gravity: null`（符合碰撞模型"无外场"约束）。

**求解结果（无需补任何值）**：

```text
碰撞事件 · 1 次      首次碰撞时刻 0.008 s
小球A 碰前 vx 10 m/s → 碰后 vx -3.33 m/s
小球B 碰前 vx 0 m/s  → 碰后 vx  6.67 m/s
两球所受冲量大小 1.33 N·s
碰前系统动量 px 1 kg·m/s   碰后系统动量 px 1 kg·m/s
碰前总动能 5 J             碰后总动能 5 J
碰撞损失的动能 8.88e-16 J（浮点残差）
```

与解析解一致：`vA' = −10/3 ≈ −3.33 m/s`，`vB' = 20/3 ≈ 6.67 m/s`；动量与动能守恒。

**阶段应用验证**：在阶段下拉框选择 `碰后小球A的运动` 并应用 → 场景变为**单球 A**，`vel.x = -3.333333333333332`（**自动带入前阶段碰后速度**），标题 `碰后小球A的运动`，`rev 5`。阶段链路正确。

**撤销**：连续撤销 2 次（阶段应用 + 主场景应用）后恢复至基线，逐字节一致。

---

### 4.7 第 7 题 · 不支持领域（弹簧）

**题面**：`一个轻质弹簧连接两个物块，劲度系数k=100 N/m，求系统振动周期和最大压缩量。`

| 项 | 结果 |
| --- | --- |
| HTTP | POST **202** → 终稿 **200** |
| 耗时 | 约 **46.6 s** |
| 合法 SceneDraft | **是**（结构合法，但明确标注不支持） |
| known | 1 项含依据：弹簧劲度系数 100 N/m |
| assumed | 6 项：g 0 m/s²（"按水平光滑面振动处理"）、支撑面 horizontal、A/B 的 μs 与 μk 均 0（光滑水平面） |
| unknown | 6 项：物块A质量、物块B质量、初始压缩量 x0、初始相对速度 v0、系统振动周期 T、弹簧最大压缩量 x_max |
| uncertain | 0 |
| warnings | **4 条，明确声明不支持**：① "题面未给出两物块质量、初始压缩量或相对初速度，因此振动周期和最大压缩量均无法唯一确定。" ② **"当前 scene schema 未提供弹簧单元，劲度系数 k 仅以参数记录；弹簧连接关系未在 bodies/supports/contacts/links 中显式建模。"** ③ "最大压缩量依赖初始机械能（初始压缩量 x0 或相对初速度 v0），请在补充条件后重新建模。" ④ "轻质弹簧质量已忽略。" |
| 生成期间原场景 | **未改变** |

**是否伪造成普通力学场景：否。** 原问题文字完整保留；`k` 仅作为命名参数记录；两物块 `mass: null`、`pos.x: null`、`attach.s: null`，支撑面 `length: null`；`asks` 中 `period` 与 `maxCompression` 均为 `kind: custom`（无专用求解器）；`mA / mB / x0 / v0` 参数值全部为 `null`，**未猜测任何数值**。

**求解结果：明确拒绝，无虚构答案。**

```text
物体            多物体目前支持两个小球的光滑碰撞。
重力加速度 g    g 必须为正数
水平支撑面 · 长度  缺少支撑面长度
```

`period` / `maxCompression` 无专用求解，**没有输出任何振动周期或最大压缩量数值**。

**撤销**：恢复至基线，逐字节一致。

**发现**：见 §6 F4。

---

## 5. 取消 / 失败 / 超时 / 续取（步骤 3、步骤 6 要求）

### 5.1 取消请求（真实云端任务在途）

- 提交**新题面**（`一个小球从距地面80 m高处由静止释放…`，日志 10:02:40 POST 202，`textChars: 44`），约 2 s 后点击"取消请求"（当时面板按钮为`生成中… / 取消请求 / 取消`，确认处于 busy 状态）。
- 等待 **40 s**（超过正常生成时长）后核对：
  - `phy.scene.v2` 与提交前基线**逐字节一致**；
  - **无迟到草稿写入**（面板无 `draft-row`、无阶段下拉框）；
  - 面板**恢复可用**：按钮回到`生成场景草稿`（非`生成中…`），题面文字保留；
  - 函数日志中该 POST 之后**没有任何 GET 轮询** → 客户端确实停止轮询；云端任务仍自行完成，与面板提示"关闭面板不会中断云端生成，重新提交同一题面可续取结果"一致。

> 说明：首次尝试取消时复用了第 1 题原题面，服务端走 `interpret_resumed` 在约 6 s 内直接返回终稿，未进入 busy 状态；因此改用全新题面重做，上述结论来自第二次有效取消。

### 5.2 失败 · 题图超过上限

- 通过文件输入上传 **716800 字节（700 KB）** PNG。
- 面板提示：`题图超过 600 KB 上限，请压缩或裁剪后再上传`。
- **未发出任何网络请求**，场景逐字节不变。

### 5.3 失败 · 服务端错误契约

同源 fetch（已登录会话）探测不存在的任务：

```text
GET /functions/v1/app/interpret?job=0000…0000
→ 404  {"ok":false,"error":"job_not_found"}
```

客户端 `mappedError` 将其映射为`读题任务已失效，请重新提交题目`。函数请求日志中该条记录为 404，**这是本轮唯一非 2xx/202 的业务响应，且为主动探测**。

### 5.4 超时

- 本轮 7 题 + 2 次补充提交全部在 **31.9–51.2 s** 内返回终稿，**未触发** `POST_TIMEOUT_MS = 95 s` 或 `AI_TIMEOUT_MS = 360 s`。
- 未人为制造超时（不修改前端请求逻辑）。
- 本地 HTTP 500 场景下客户端兜底文案为`读题服务暂不可用（HTTP 500）`，场景不变（§2 已复现确认）。

### 5.5 重复题面续取（额度保护）

重复提交第 1 题原题面时，函数日志记录 `{"event":"interpret_resumed",...}` 并直接返回终稿（约 6 s），**未重复消耗每日额度**（`resumed: true` 跳过 `limiter.record()`）。

### 5.6 线上状态码汇总

函数请求日志窗口 `2026-11-28T09:04:16Z … 10:04:16Z`（两页，共 43 条）：

- POST `/app/interpret`：全部 **202**
- GET `/app/interpret?job=`：**202**（pending）→ **200**（终稿）
- GET `/app`（健康检查）：**200**
- 主动探测的无效 job：**404**
- **5xx：0 条**

---

## 6. 发现的问题与严重级别

| 编号 | 严重级别 | 现象 | 证据位置 | 复现步骤 |
| --- | --- | --- | --- | --- |
| **F1** | **中** | 题面未给质量时草稿正确留 `mass: null`，但场求解器强制要求有限质量，导致**纯运动学题（自由落体/平抛）无法直接求解**；且草稿 `unknown` 列表未把 `mass` 列为待补充，用户看不到需要补什么 | `src/solver/fields.ts:44`（`missing_required`）、`src/solver/spatial.ts:45`；第 1、2 题面板 | 提交第 1 题 → 应用 → 检查并求解 → 出现`小球 · 质量 / 请填写有限数值。`；手动补 m=1 kg 后才得到 3 s / 30 m/s |
| **F2** | **中** | 校验器对**所有**支撑面强制要求 `length`，使"未给斜面长度的滑动判断题"被阻塞，尽管该判断与长度无关 | `src/model/validate.ts:51`；第 3 题面板 | 提交第 3 题 → 应用 → 检查并求解 → 出现`斜面 · 长度 / 缺少支撑面长度`；补 L=5 m 后才得到静摩擦自锁结论 |
| **F3** | 低 | AI 把已由 `field_exit` 覆盖的量（竖直位移、出场速度大小/方向）另标为 `custom` 待求，结果区显示"此问题已保留，当前没有对应的专用求解"，而**同一屏的场区穿越块已给出这些数值** → 重复待求项与提示自相矛盾 | 第 4 题、第 5b 题结果区 | 提交第 4 题 → 应用 → 求解 → 对比`匀强电场 · 场内位移 Δy -0.1 m`与下方`竖直位移 —` |
| **F4** | 低 | ① 弹簧题中 AI 按水平光滑面振动设 `gravity: 0`，但校验器要求非圆周题型 `g > 0`，产生额外阻塞项；② 劲度系数 `k` 的单位记为 `none`（工作台无 N/m 单位类型） | `src/model/validate.ts:42`；第 7 题场景 `params.k.unit = "none"` | 提交第 7 题 → 应用 → 求解 → 出现`g 必须为正数`；查看命名参数 k 的单位为无量纲 |
| **F5** | 环境阻塞（非产品缺陷） | 本地 Deno 缺失 → `dev/function-local.ts` 无法启动 → Vite 代理 `ECONNREFUSED 127.0.0.1:8000` → 前端显示`读题服务暂不可用（HTTP 500）` | §2 复现证据 | 无 Deno 环境下启动 `pnpm dev` 并提交任意题面 |

**没有发现**：错误默认值（未知量一律 `null`，未出现默认 0 / 9.8 冒充题面值）、错误对象引用路径、错误单位、电荷符号丢失、场方向反转错误、碰撞恢复系数丢失、阶段丢失、错误时覆盖原场景。

### 6.1 F1–F4 本地修复与复验（2026-11-28）

以下结果来自当前工作区的本地回归，尚未替代新的 Qoder Sites 线上发布复验：

- **F1 已修复**：二维和三维纯重力运动在质量为 `null` 时继续求运动学量；能量/功仍返回“需要质量”的明确状态。带电、电磁或其他依赖质量的轨迹仍保留质量阻塞。提示词同步要求：纯重力运动不把质量列为待补条件，质量确实影响所求量时才列入 `unknown`。
- **F2 已修复**：仅包含 `friction_state` 的斜面题允许 `length: null`，求解器不再使用示意默认长度；端点、运动状态和能量查询仍要求支撑面长度。
- **F3 已修复**：`field_entry/field_exit` 已输出的进出场时间、位置、位移、速度和方向不再重复生成 `custom` 待求项；兼容模型偶尔生成重复项时，结果区会指向结构化场区结果。
- **F4 已修复**：custom-only 的不支持题不再因 `g=0` 或缺失支撑长度增加无关阻塞；弹簧劲度系数以 `stiffness` / `N/m` 保留量纲，但仍明确不提供弹簧求解。
- **严格引用校验**：服务端 `extractDraft()` 使用 `strictReferences: true`；无法解析的 `known`、`assumed`、`unknown` 路径和路径形态的 `uncertain` 条目会返回 `ai_draft_invalid`，自然语言不确定性说明仍转为 warning。

复验命令及结果：`pnpm test`（27 个文件、486 项通过）、`pnpm run typecheck`（通过）、`pnpm run build`（通过，仅有既存大包体积警告）、`pnpm run test:function`（`FIXTURE: ALL PASSED`）、`git diff --check`（通过）。

---

## 7. 工作区与合规性

- **未提交、未推送、未创建 PR**；HEAD 仍为 `f4d6298`。
- `git status --short` 显示的用户改动**全部保留**；本轮仅在其上增加 F1–F4 的求解器、校验器、提示词、契约和回归测试修改，并新增 `tests/f4-custom.test.ts` 与本节修复记录，未使用强制重置或清理命令。
- 站点描述符原文件结构损坏且绑定到不可访问的旧站点，已**重命名备份**为 `.高中物理工作台.qoder.site.bak`（未删除），由 `prepare_site` 重新生成绑定到现有站点 `01a1fcc6…` 的有效描述符。**未创建替换站点，未改变私有访问范围。**
- 未设置 `VITE_AI_DEMO=1`；未修改 AI 面板文案、错误映射或前端请求逻辑；未把本地 fixture 当作真实读题服务。
- 本报告**不含**任何 Secret、Token、Bearer 值、题图 Base64 或完整模型原始输出。函数日志审计确认服务端只记录 `jobId / sessionId / model / hasImage / textChars`，不记录题面原文与凭据。
- 本报告中的 `jobId` 仅保留前 8 位用于对应日志，`sessionId` 以 `sess_*` 概括。

---

## 8. 完成标准对照

| # | 标准 | 结果 |
| --- | --- | --- |
| 1 | Function 健康检查成功 | **线上通过**（200 `{"ok":true,"message":"Hello, Physics!"}`，契约 `fields-and-stages-v6`）；**本地未通过**，原因为 Deno 缺失（F5，如实记录为阻塞） |
| 2 | 正常服务端界面完成 ≥1 道文字题 | **通过**（第 1、2、3 题，徽标均为`服务端读题`） |
| 3 | 完成 ≥1 道电荷/电场题 | **通过**（第 4 题 +1×10^-4 C；第 5b 题 −1×10^-4 C，方向反转已验证） |
| 4 | 完成 ≥1 道碰撞或阶段题 | **通过**（第 6 题，4 个阶段，`A_after` 自动带入 −3.333 m/s） |
| 5 | 不支持题明确拒绝 | **通过**（第 7 题：warnings 声明 schema 无弹簧单元，求解器拒绝，无虚构周期/压缩量） |
| 6 | 错误、取消、超时不覆盖原场景 | **通过**（取消在途任务、700 KB 题图、404 `job_not_found` 均验证场景逐字节不变；超时本轮未触发，未人为制造） |
| 7 | 报告无 Secret / Token / 题图 Base64 / 完整模型原始输出 | **通过** |
| 8 | 明确区分本地契约测试与真实云端模型测试 | **通过**（§0） |

**总体判定：线上真实 AI 读题链路验证通过。** 本地真实 Function 验证因 Deno 缺失而阻塞，未以任何方式伪造通过。F1–F4 已在当前工作区完成本地修复和回归；发布后仍需按 §6.1 的线上步骤重新验证。F5 仍是本机缺少 Deno 的环境问题，不应通过修改产品逻辑掩盖。

---

## 9. F1–F4 独立复查（2026-11-28）

任务来源：`QODERCN-P3-F1-F4-BUG-RECHECK.md`。本节为**追加**的独立复查记录，上文 §1–§8（含 §6.1 修复方自述）保持原样，历史线上证据未被改写为当前证据。

**与 §6.1 自述结论的差异**：§6.1 称 F1–F4 四项"已修复"。本轮独立复查实测确认 **F1、F2、F4 成立**，但 **F3 只部分成立**——结果区提示的正则覆盖不全，仍存在 3 个可复现缺陷（DEF-R1/R2/R3），其中 DEF-R2 的触发措辞正是 §4.4 线上真实模型的实际输出。

### 9.1 前置状态

```text
git rev-parse --short HEAD → f4d6298（未提交、未推送、未创建 PR、未发布站点）
git status --short         → 21 个已修改文件 + 7 个未跟踪文件，全部保留
git diff --check           → exit 0，无空白错误（仅 LF→CRLF 提示，不算失败）
```

复查对象是工作区中**未提交的 F1–F4 修复**：`src/solver/fields.ts`、`src/solver/spatial.ts`、`src/solver/incline.ts`、`src/solver/index.ts`、`src/model/validate.ts`、`src/model/types.ts`、`src/model/units.ts`、`functions/draft-schema.ts`、`functions/interpret.ts`、`functions/scene-prompt.ts`、`functions/handler.ts`，以及 `tests/`（含新增未跟踪的 `tests/f4-custom.test.ts`）。未执行 `git reset --hard` / `git clean -fd`，未覆盖或删除用户改动，未设置 `VITE_AI_DEMO=1`，未修改 UI 文案、错误映射或请求逻辑。

### 9.2 第一阶段：本地自动检查

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `git diff --check` | 无空白错误（仅 4 条 LF→CRLF 提示） | 0 |
| `pnpm test` | **27 个测试文件 / 486 项通过**，与预期基线一致（无减少） | 0 |
| `pnpm run typecheck` | `tsc -b --noEmit` 无错误 | 0 |
| `pnpm run build` | 成功，产物 `dist/assets/index-CqzYvgpy.js` 1,661.43 kB（gzip 555.93 kB）；仅 >500 kB chunk 体积警告（按要求只记录，不作为功能判定依据） | 0 |
| `pnpm run test:function` | 末行 **`FIXTURE: ALL PASSED`**；含"日志不含题图 base64 / 不含凭据字段 / 不含模型原始输出 / 保留安全诊断字段"四项 PASS | 0 |
| `pnpm exec vitest run tests/fields.test.ts tests/spatial.test.ts tests/incline.test.ts tests/ai-scene-contract.test.ts tests/f4-custom.test.ts tests/ai-repair.test.ts` | **6 文件 / 177 项通过** | 0 |

**本轮另构造的定向专项用例**：按任务文件列出的每个情形新建 **37 项**用例实际运行（编号 F1-a…F1-h、F2-a…F2-f、F3-a…F3-e、F4-a…F4-h、S-a…S-j），**37/37 通过**（其中 4 项用于暴露 DEF-R1…DEF-R4 的实际行为，断言按"记录真实输出"而非"假设已修复"编写）。临时文件 `tests/zz-recheck-scratch.test.ts` 在检测结束后**已删除**，未留在工作区（`git status` 已复核）。

> 环境：Windows 10.0.26200 / Node v22.14.0 / pnpm 9.15.0 / vitest 2.1.9。本地仍无 Deno（`deno: command not found`），`dev/function-local.ts` 无法启动，本地真实 Function 通道仍为**环境阻塞**（ENV-1），不计入 F1–F4 产品判定。

### 9.3 F1：纯重力运动不应被质量为空阻塞 —— **PASS**

改动点：`src/solver/fields.ts` 把 `mass` 移出无条件必填循环，新增 `projectileCompatible`（全局竖直重力 + 无绳杆 + 无 `field_entry`/`field_exit`）；`src/solver/spatial.ts` 新增 `kinematicsOnly`（质量未知且 q=0 且场仅为 `uniform_gravity`/`point_mass`），以单位质量继续求运动学量，并把 `energy` 降级为 `mass_required`。

| 用例 | 输入 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| F1-a | 2D 全局竖直重力场，自由落体 h=45 m、g=10、`mass: null`，ask `landing` | `ok=true`；`land_t=3`、`land_range=0`、`land_v=30`（水平 0 / 竖直 −30）；**无 `bodies.*.mass` 阻塞**；`energy.status = mass_required` | 符合预期 |
| F1-b | 2D 平抛 h=20、vx=10、`mass: null` | `ok=true`；`land_t=2`、`land_range=20`、`land_v=22.3607` | 符合预期 |
| F1-c | 2D `mass: null` + `energy_at` 与 `work_between` | `ok=true`；两条能量答案 `value=null`，note=`请在物体属性中填写大于 0 的质量，才能计算以焦耳表示的能量和功。`**未伪造焦耳值** | 符合预期 |
| F1-d | 3D 纯重力 `mass: null`，`at_time t=3` | `ok=true`；`evalAt(3) = {y:0, vy:-30, ay:-10, s:45}`；`energy.status = mass_required` | 符合预期 |
| F1-e | 带电小球 + 匀强电场，`mass: null` | `ok=false`，`missing_required bodies.<id>.mass / 请填写有限数值。` | 符合预期（仍要求真实质量） |
| F1-f | 带电小球 + 匀强磁场，`mass: null` | `ok=false`，`missing_required bodies.<id>.mass` | 符合预期 |
| F1-g | 两球弹性正碰，A `mass: null` | `ok=false`，`missing_required bodies.A.mass` | 符合预期（**未偷填 1 kg**） |
| F1-h | 纯重力场但含 `field_exit` ask，`mass: null` | `ok=false`，`missing_required bodies.<id>.mass` | 保守行为，见 OBS-1 |

**任务 F1 第 4 点（unknown 是否列质量）**：`functions/scene-prompt.ts` 建模约束第 2 条已改为"纯重力运动学且质量不影响所求时，未给质量保留 null，不列为待补条件，也不得阻塞运动求解；若所求能量/功、碰撞结果或带电轨迹确实依赖质量且题目未给出，则把对应 `bodies.<id>.mass`（分阶段使用完整 stages 路径）列入 unknown，不能猜数值"。`tests/ai-scene-contract.test.ts` 的 DEF-048 用例对该提示词文本断言并通过。线上真实模型是否遵守属**模型行为**，需部署后验证（见 §9.7）。

### 9.4 F2：只问摩擦状态不应被支撑面长度阻塞 —— **PASS**

改动点：`src/model/validate.ts` 新增 `frictionOnlyQuery`（asks 全为 `friction_state`）与 `customOnlyQuery`，仅这两种情况免除 `supports.*.length` 必填；`src/solver/incline.ts` 在 `length=null` 时令 `L = Infinity`，**不再回落到 `geometry.ts` 的示意默认长度 4 m**。

| 用例 | 输入 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| F2-a | 斜面 30°、μs=0.7、μk=0.2、`length=null`、asks=[`friction_state`] | `validateScene` 阻塞为空；`solve ok=true`；`friction` 文本含"静止"；`accel=0`（note"质量可约去，结果与 m 无关"）；`end_t=null`（"物体保持静止，不会到达端点"）；**所有答案值有限或 null，无 Infinity** | 符合预期 |
| F2-b | 同上但会滑动（μs=0.2） | `friction` 文本：`|tanθ|=0.577 > μ_s=0.2（或已有初速度），物体滑动；首段加速度 a=-3.27 m/s²`；`accel=-3.2679`；`end_t=1.7493 s`（note"到达轨道起点端"）、`end_v=5.7166 m/s`（note"沿面位置 s=0 m，运动截至端点"）。端点取自**真实几何端 s=0**（题给 s0=5 滑向斜面底端），**未使用示意总长度** | 符合预期 |
| F2-c | `length=null`、asks=[`end_of_support`] | `ok=false`，`missing_required supports.<id>.length / 缺少支撑面长度` | 符合预期 |
| F2-d | `length=null`、asks=[`friction_state`, `end_of_support`]（混合） | `validateScene` 与 `solve` 均阻塞于 `supports.<id>.length`——**未因含一个摩擦判断而整体放行** | 符合预期 |
| F2-e | `length=null`、asks=[`at_time t=1`] | `ok=false`，阻塞 `supports.<id>.length` | 符合预期 |
| F2-f | `length=null`、asks=[]（无待求） | `validateScene` 仍阻塞 `supports.<id>.length`——常规场景未被放宽 | 符合预期 |

### 9.5 F3：field_entry/field_exit 不应重复产生矛盾 custom —— **FAIL（部分通过）**

改动点：`functions/scene-prompt.ts` 增加"field_entry/field_exit 会输出进出场时间、世界坐标 x/y、场内位移 Δx/Δy、速度分量、速率和速度方向；题面询问这些量时只建立对应 ask，不要另建 custom 重复同一问题"；`src/solver/index.ts` 对 custom 待求新增正则判定：

```ts
const duplicatesFieldQuery = scene.asks.some(a=>a.kind==='field_entry'||a.kind==='field_exit')
  && /(?:出场|进场|离场|场区)/.test(question)
  && /(?:位置|位移|速度|速率|方向)/.test(question);
```

统一场景设置：匀强电场 `rect(center 0.4,0, w0.8, h4)`、`vector (0,1000)`，叠加全局重力 `(0,-10)`；小球 `m=0.02 kg`、`q=+1e-4 C`、`v=(4,0)`；`fieldPlayback.exit='field'`、`fieldId` 指向电场；asks = 一个 `field_exit` + 一个（或两个）`custom`。所有用例 `solve` 均 `ok=true`，custom 答案 `value` 一律为 `null`（**没有任何伪造数值**）。

| 用例 | custom.question | 实际 note | 判定 |
| --- | --- | --- | --- |
| F3-a | `出场时的竖直位移和速度方向？` | `该问题已由场区进出场结果覆盖，请查看对应进场/出场待求量的时间、位置、位移和速度字段。` | 符合预期 |
| F3-b | `出场时间` | `此问题已保留，当前没有对应的专用求解；请查看相关阶段或补充建模。` | **FAIL** → DEF-R1 |
| F3-c | `竖直位移（小球离开电场时相对进入点的竖直位移）` | `此问题已保留，当前没有对应的专用求解…` | **FAIL** → DEF-R2 |
| F3-c | `出场速度大小（小球离开电场时的合速度）` | `该问题已由场区进出场结果覆盖…` | 符合预期 |
| F3-d | `出场后继续上升到最高点的速度` | `该问题已由场区进出场结果覆盖…` | **FAIL（误报）** → DEF-R3 |
| F3-e | `第九次经过某点时的条件？` | `此问题已保留，当前没有对应的专用求解…`，`label` 保留原问题文字，`value=null` | 符合预期（未被宽泛正则误删，未伪造答案） |

任务 F3 第 1 点（提示词优先 `field_entry`/`field_exit`、结构化结果含可用字段）：提示词已更新，`tests/ai-scene-contract.test.ts` 对提示词文本与"已覆盖"note 均有断言并通过 → **该子项 PASS**。
任务 F3 第 2 点（不得继续显示矛盾提示）：**未达成**，见 DEF-R1 / DEF-R2。
任务 F3 第 3 点（真正无专用求解的 custom 保留 question 与 warnings）：**PASS**（F3-e）。

**结论：F3 整体判 FAIL。**

### 9.6 F4：不支持弹簧题必须保留、明确拒绝且量纲正确 —— **PASS（含 1 项 S3 残留）**

改动点：`src/model/types.ts` 的 `UnitKind` 增加 `'stiffness'`；`src/model/units.ts` 增加 `stiffness: { 'N/m': { si: 1, label: 'N/m' } }`；`functions/draft-schema.ts` 的 `UNIT_KINDS` 同步增加；`src/model/validate.ts` 用 `customOnlyQuery` 免除无关的 `gravity` 与 `length` 阻塞；提示词声明"stiffness 的 SI 单位为 N/m，仅用于保留弹簧劲度系数等不支持题目的量纲，不代表当前已支持弹簧求解"。

| 用例 | 输入 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| F4-a | 两物块 + 水平光滑面 + `gravity=0` + `length=null` + asks 全为 `custom`（周期 / 最大压缩量）+ `params[k]=100 stiffness` | `validateScene` 阻塞仅 `bodies: 多物体目前支持两个小球的光滑碰撞。`；**无 `gravity` 阻塞、无 `supports.*.length` 阻塞** | 符合预期 |
| F4-b | 同上，`solve` | `ok=false`（多物体 blocker）；**未输出任何周期或压缩量数值** | 符合预期 |
| F4-c | 单位换算 | `Object.keys(UNITS.stiffness) === ['N/m']`；`toSI(100,'N/m','stiffness') === 100`；`fromSI(100,'N/m','stiffness') === 100` | 符合预期（不再伪装成无量纲） |
| F4-d | 非 custom-only（asks=[`end_of_support`]）物块场景，`gravity=0` | 阻塞含 `gravity: g 必须为正数` | 符合预期（常规约束未被放宽） |
| F4-e | 同上，`gravity=null` | 阻塞含 `gravity: 缺少重力加速度 g（可填 9.8 或 10）`，code=`missing_required` | 符合预期 |
| F4-f | 混合 asks（`custom` + `end_of_support`），`length=null` | 阻塞含 `supports.<id>.length: 缺少支撑面长度` | 符合预期 |
| F4-g | 圆周场景 `gravity=0` | `validateScene` 阻塞为空 | 符合预期（原有 g=0 豁免未被破坏） |
| F4-h | **单**物块 + 水平光滑面 + `gravity=0` + `length=null` + asks 全为 `custom` | `validateScene` 阻塞为空；`solve ok=true`；两个 custom 答案 `value=null` 且 note=`此问题已保留，当前没有对应的专用求解…`；**无任何数值化周期/压缩量**；但通用直线模板额外输出 `加速度 = 0 m/s² [由滑动摩擦产生]` 与 `到达端点的时间 = null [物体保持静止，不会到达端点]` | 部分符合 → DEF-R4 |

任务 F4 第 3 点（`stiffness` 只表示量纲，不得被误解为已支持弹簧动力学）：提示词与单位表均明示，且 F4-b / F4-h 证明**未引入任何弹簧动力学求解**（无周期公式、无简谐运动积分）→ PASS。`tests/f4-custom.test.ts`（新增 2 项）与本轮 F4-a…F4-h 一致通过。

### 9.7 第三阶段：严格草稿引用契约 —— **PASS**

`functions/interpret.ts` 的 `extractDraft()` 已确认调用：

```ts
return validateSceneDraft(candidate, { strictReferences: true });
```

失败时抛 `InterpretError('ai_draft_invalid', 502, reason, draftDiagnostic(...))`。

| 用例 | 输入 | 实际结果 |
| --- | --- | --- |
| S-a（正例） | known / assumed / unknown 路径全部可定位 | 严格模式通过；`known.length=1`、`assumed.length=1`、`unknown.length=1` |
| S-b（反例） | `known` 增加 `bodies.b1.vel.x_after` | 抛 `DraftContractError`，消息含 `draft 路径不存在` |
| S-c（反例） | `assumed` 增加 `bodies.b1.doesNotExist` | 抛错，含 `draft 路径不存在` |
| S-d（反例） | `unknown` 增加 `supports.s1.height` | 抛错，含 `draft 路径不存在` |
| S-e（反例） | `uncertain = ['bodies.b1.vel.x_after']`（路径形态且不存在） | 抛错，含 `draft 路径不存在` |
| S-f（正例） | `uncertain = ['无法确认题图中的边界是否足够大']`（自然语言） | **不抛错**；`uncertain` 长度为 0，`warnings` 含 `模型不确定性说明（非路径，已转入警告）` |
| S-g | `unknown` 用 `asks.friction_state`（场景确实存在该 ask） vs `asks.apex`（不存在） | 前者通过；后者抛 `draft 路径不存在` |
| S-h | 兼容模式（不传 `strictReferences`）+ 无效 known 路径 | 不抛错；该行被剔除，`warnings` 含 `无法定位的已知` |
| S-i | `extractDraft(JSON.stringify(含无效路径的草稿))` | 抛 `InterpretError`：`code='ai_draft_invalid'`、`status=502`、`diagnostic='reference'`、`detail=undefined`（**不含任何凭据字样**） |
| S-j | `known.path = 'scene.bodies.b1.mass'`（带根名前缀） | 严格模式通过（`normalizeScenePath` 正确处理前缀，未误判） |

**非法草稿不得进入 AI 面板**：`extractDraft` 抛错后由 `functions/handler.ts` 的 `failure()` 转为 `{ok:false, error:'ai_draft_invalid', diagnostic:'reference'}` + HTTP 502；`src/ai/client.ts` 的 `mappedError` 映射为 `AiDraftError`；`src/ui/AiPanel.tsx` 仅在 `readProblem` 成功返回时才 `dispatch({type:'setDraft'})`。因此非法草稿**不会进入预览、不会被应用、不会覆盖当前场景**。该链路由既有 `tests/ai-roundtrip.test.ts`（"云端给出真正未知的类型时由服务端拒绝，不当作合法小球应用"）与 `tests/ai-repair.test.ts`（23 项）覆盖并通过；§4.5 的线上实测亦印证错误时原场景逐字节不变。

### 9.8 第四阶段：线上真实用户界面 —— **BLOCKED（部署版本落后，非环境阻塞）**

**登录 / Secret / 网关状态（均正常）**

| 项 | 实测 |
| --- | --- |
| 登录态 | 浏览器已登录 Qoder Sites，**未出现** `sites_gateway_login_required` |
| 健康检查 | `GET /functions/v1/app?name=Physics` → **200** `{"ok":true,"message":"Hello, Physics!"}` |
| 契约头 | `X-Scene-Contract-Revision: fields-and-stages-v6` |
| Secret / 上游通道 | 函数输出日志 `{"event":"interpret_start","model":"fast","enabledModels":[...],"hasImage":false,"textChars":56}`、`{"event":"interpret_accepted","sessionId":"sess_*"}` → Cloud Agents 通道可用，**Secret 配置有效** |
| 网关 | POST 202 / GET 轮询 202→200 正常，无网关超时、无 5xx |

**阻塞原因：线上构建不含 F1–F4 修复**

线上前端 bundle 实测为 `assets/index-z4p0wKWI.js`（1,660,190 字节），标记检测：

| 标记 | 结果 | 含义 |
| --- | --- | --- |
| `场区进出场结果覆盖`（F3 新提示） | **false** | F3 修复未部署 |
| `stiffness`（F4 新单位） | **false** | F4 修复未部署 |
| `fields-and-stages-v6` | true | 契约版本正确 |
| `才能计算以焦耳表示的能量和功` | true | 该文案修复前即存在于 `src/solver/energy.ts`，**不能**作为 F1 部署证据 |

本轮本地构建产物为 `index-CqzYvgpy.js`，与线上 `index-z4p0wKWI.js` 不同，进一步确认线上落后于工作区。任务文件明确禁止发布站点，故**未重新部署**，F1–F4 的线上验证判 **BLOCKED**。

**线上实测（证明落后，而非推测）**：按任务文件题面在线上"服务端读题"界面实际提交 2 题（每次一题，徽标均确认为 `服务端读题`）。

*线上题 1*：`一个小球从距地面45 m高处由静止释放，取g=10 m/s²，忽略空气阻力，求落地时间和落地瞬间的速度。`

- 函数日志：`interpret_resumed` + `interpret_done`（jobId `7249bfa8…`，命中同题面指纹缓存），浏览器实测约 **27.2 s** 返回终稿。
- 草稿：known 3 项（初始高度 45 / 初速度 0 / 重力加速度 −10，均含原文依据）、assumed 3 项、unknown 2 项（落地时间、落地瞬间速度 → `landing`）、uncertain 0、warnings 0。
- 应用后场景：`ball pos(0,45) vel(0,0) mass:null` + `uniform_gravity global (0,-10)`。生成期间原场景未改变。
- 检查并求解 → **仍阻塞**：`小球 · 质量 / 请填写有限数值。` → **线上仍复现 F1**（与 §4.1 历史证据一致，属修复前构建的预期表现）。
- 撤销 1 次 → 场景恢复至提交前基线（`rev 3`，逐字节一致）。

*线上题 2*：`质量为2 kg的物块放在倾角30°的斜面上，静摩擦因数μs=0.7，只判断物块是否会滑动，取g=10 m/s²。`

- 函数日志：`interpret_start`（`textChars: 56`、`hasImage: false`）→ `interpret_accepted`（`sessionId: sess_*`）；浏览器实测约 **59.8 s** 返回终稿（新题面，未命中缓存）。
- 草稿 warnings 1 条：`题面未给动摩擦因数，已按 mu_k=mu_s 近似（1 处），请核对。` —— 来自 `functions/draft-schema.ts:410` 的**有意归一化并明示**（PLAN.md DEF-047/048），非模型擅自抄值。
- known 4 项（质量 2 / 倾角 30 / μs 0.7 / g 10，均含原文依据）、assumed 0、unknown 1 项（`slide`）、uncertain 0。
- 应用后场景：`incline angleDeg:30, length:null`、`contacts {mu_s:0.7, mu_k:0.7}`、`asks:[{id:'slide', kind:'friction_state'}]`、`mass:2`、`gravity:10`。生成期间原场景未改变。
- 检查并求解 → **仍阻塞**：`斜面 · 长度 / 缺少支撑面长度` → **线上仍复现 F2**。
- 撤销 1 次 → 场景恢复至提交前基线（`rev 3`，逐字节一致）。

任务文件另列的线上题 3（电场正电荷）与题 4（弹簧）未再提交：线上构建既已确认不含 F3/F4 修复（bundle 标记），重复提交只会再次得到修复前结果并额外消耗云端额度；其修复效果已在本地由 F3-a…F3-e、F4-a…F4-h 共 13 项用例覆盖。**这不是环境阻塞，是部署授权阻塞。**

**线上问题归类（按任务文件要求区分）**

| 类别 | 本轮线上是否出现 |
| --- | --- |
| HTTP / 网关 / 登录 / Secret 阻塞 | **未出现**（健康检查 200，无 `sites_gateway_login_required`，Secret 有效，无 5xx） |
| 上游 AI 超时或拥塞 | **未出现**（27.2 s / 59.8 s，均在 95 s POST 预算内） |
| 草稿契约错误 | **未出现**（两题草稿均通过 `parseSceneDraft`，无 `ai_draft_invalid`） |
| 本地确定性求解器 blocker | **出现 2 次**：`小球 · 质量`（线上题 1）、`斜面 · 长度`（线上题 2）——均为修复前构建的已知 F1/F2 表现 |
| 真正的物理答案错误 | **未出现** |

按要求，`ECONNREFUSED 127.0.0.1:8000` 与本地缺 Deno **未**记为 F1–F4 产品缺陷（见 ENV-1）。

### 9.9 本轮新发现缺陷

**DEF-R1**

```text
编号：F3（残留 R1）
严重级别：S3
环境：本地 vitest（Node v22.14.0 / vitest 2.1.9 / Windows 10.0.26200）
前置状态：HEAD f4d6298，工作区含未提交的 F1–F4 修复
最小输入：匀强电场 rect(center 0.4,0,w0.8,h4) vector(0,1000) + 全局重力 (0,-10)；
          小球 m=0.02 kg、q=+1e-4 C、v=(4,0)；fieldPlayback.exit='field'、fieldId=电场；
          asks=[field_exit, custom{question:'出场时间'}]
复现步骤：1) 构造上述场景 2) 调用 solve() 3) 读取 custom ask 对应答案的 note
预期：note 说明该问题已由场区进出场结果覆盖，并指向 field_exit 的时间字段
实际：note = "此问题已保留，当前没有对应的专用求解；请查看相关阶段或补充建模。"
      而同屏 field_exit 已输出"首次出场时间 0.2 s"
证据：src/solver/index.ts 正则第二组为 (?:位置|位移|速度|速率|方向)，缺少「时间/时刻」；
      定向用例 F3-b 实测输出
是否覆盖原场景：否
建议：把「时间」「时刻」加入第二组正则；或改为显式的 question→输出字段对照表，
      不再用自由文本正则近似
```

**DEF-R2**

```text
编号：F3（残留 R2）
严重级别：S3（影响面较大：触发措辞即上一轮线上真实模型的实际输出，见 §4.4）
环境：本地 vitest；措辞来源为 2026-11-28 线上真实草稿
前置状态：HEAD f4d6298，工作区含未提交的 F1–F4 修复
最小输入：同 DEF-R1 场景，asks=[field_exit,
          custom{question:'竖直位移（小球离开电场时相对进入点的竖直位移）'},
          custom{question:'出场速度大小（小球离开电场时的合速度）'}]
复现步骤：1) 构造场景 2) solve() 3) 分别读取两个 custom 答案的 note
预期：两条都应说明已由场区进出场结果覆盖（field_exit 已给出 Δy=-0.1 m 与速率 4.12 m/s）
实际：第 1 条仍为"此问题已保留，当前没有对应的专用求解…"（矛盾提示）；
      第 2 条正确显示"该问题已由场区进出场结果覆盖…"
证据：src/solver/index.ts 正则第一组为 (?:出场|进场|离场|场区)，不匹配「离开电场」；
      定向用例 F3-c 实测输出
是否覆盖原场景：否
建议：第一组补充「离开电场/进入电场/穿出/射出场区」等等价措辞；或改为"场景存在
      field_entry/field_exit 即视为覆盖"，并对后续过程问法单独排除（见 DEF-R3）
```

**DEF-R3**

```text
编号：F3（残留 R3，误报）
严重级别：S3
环境：本地 vitest
前置状态：HEAD f4d6298，工作区含未提交的 F1–F4 修复
最小输入：同 DEF-R1 场景，asks=[field_exit,
          custom{question:'出场后继续上升到最高点的速度'}]
复现步骤：1) 构造场景 2) solve() 3) 读取 custom 答案 note
预期：该问题询问"出场之后"的后续过程，field_exit 并不覆盖，应保留
      "此问题已保留，当前没有对应的专用求解"
实际：note = "该问题已由场区进出场结果覆盖，请查看对应进场/出场待求量的时间、位置、
      位移和速度字段。" → 指向并不存在的答案，属误导性提示（value 仍为 null，未伪造数值）
证据：正则同时命中「出场」与「速度」，未识别「后/之后/继续」等后续过程语义；
      定向用例 F3-d 实测输出
是否覆盖原场景：否
建议：命中前先排除含「出场后/离开场区后/之后/继续」的后续过程问法
```

**DEF-R4**

```text
编号：F4（残留 R1）
严重级别：S3（条件触发：需模型输出"单物块 + custom-only"的弹簧场景；
        上一轮线上实测为两物块场景，被多物体规则整体阻塞，未触发本缺陷）
环境：本地 vitest
前置状态：HEAD f4d6298，工作区含未提交的 F1–F4 修复
最小输入：单个 block（mass:null, attach.s:0）+ horizontal 支撑面（angleDeg:0, length:null）
          + contacts μs=μk=0 + gravity=0 + asks 全为 custom（'求振动周期'、'求最大压缩量'）
          + params[k]=100 unit='stiffness'
复现步骤：1) 构造场景 2) validateScene() 3) solve() 4) 查看全部 answers
预期：custom-only 的不支持题只保留原问题并说明无专用求解，不应输出与弹簧无关的
      普通直线运动答案
实际：validateScene 阻塞为空；solve ok=true；两个 custom 答案正确为 null 且
      note="此问题已保留，当前没有对应的专用求解…"；但通用直线模板额外输出
      「加速度 = 0 m/s²（由滑动摩擦产生）」与
      「到达端点的时间 = null（物体保持静止，不会到达端点）」
      —— 对弹簧振动题给出了"物体静止、加速度为 0"的直线运动结论
证据：定向用例 F4-h 实测输出；根因是 validate.ts 的 customOnlyQuery 豁免 gravity/length
      阻塞后，incline/kinematics 模板仍照常运行并输出附加答案
是否覆盖原场景：否
建议：customOnlyQuery 为真时跳过通用运动模板的附加答案（只输出 custom 保留项），
      或在答案区显式标注"以下运动学结果基于无弹簧的等效模型，不代表原题答案"
```

**OBS-1（观察项，非已确认缺陷）**

```text
编号：F1（观察项 OBS-1）
严重级别：S3（保守行为，不产生错误答案）
环境：本地 vitest
最小输入：纯全局竖直重力场 + asks 含 field_exit，mass:null
实际：仍阻塞 bodies.<id>.mass（fields.ts 的 projectileCompatible 显式排除 field_entry/field_exit）
说明：此时质量对运动学确实无关（q=0），理论上可放开；当前实现选择保守要求质量，
      不会产生错误数值，只多一步手动填写。按任务文件要求记为"待确认"，不作为已确认 bug。
```

**ENV-1（环境阻塞，非产品缺陷）**

```text
编号：ENV-1
严重级别：环境阻塞
环境：本地 Windows 10.0.26200
现象：deno: command not found → dev/function-local.ts 无法启动 → Vite 代理
      connect ECONNREFUSED 127.0.0.1:8000 → 前端显示"读题服务暂不可用（HTTP 500）"
判定：按任务文件要求不记为 F1–F4 产品缺陷；本地真实 Function 通道判 BLOCKED
```

**DEP-1（部署阻塞）**

```text
编号：DEP-1
严重级别：S2（阻塞线上验收，非功能缺陷）
现象：线上 bundle 为 index-z4p0wKWI.js，不含 F3 新提示与 stiffness 单位；
      本地构建为 index-CqzYvgpy.js；线上仍复现 F1（质量阻塞）与 F2（长度阻塞）
判定：F1–F4 的线上验证 BLOCKED。本任务禁止发布站点，故未部署
下一步：取得授权后 prepare_site + publish_site 发布当前工作区构建，
        再按任务文件第四阶段的 4 道题面重跑线上复查
```

### 9.10 判定汇总

| 项 | 判定 | 依据 |
| --- | --- | --- |
| **F1** 纯重力不被质量阻塞 | **PASS** | F1-a…F1-h 共 8 项定向用例；仓库 `tests/fields.test.ts`、`tests/spatial.test.ts` 新增用例通过；能量降级为 `mass_required`，未伪造焦耳值；电磁/碰撞仍要求真实质量。残留 OBS-1（保守，不影响正确性） |
| **F2** 只问摩擦状态不被长度阻塞 | **PASS** | F2-a…F2-f 共 6 项定向用例；`tests/incline.test.ts` 新增 2 项通过；`length=null` 时 `L=Infinity`，端点只取真实几何端 s=0，未使用示意默认长度；混合 asks 与常规场景仍正确阻塞 |
| **F3** 不重复产生矛盾 custom | **FAIL** | 提示词与结构化结果子项 PASS；但结果区提示正则覆盖不全：DEF-R1（「出场时间」漏判）、DEF-R2（线上真实措辞「离开电场」漏判）、DEF-R3（「出场后…最高点」误报） |
| **F4** 弹簧题保留/拒绝/量纲 | **PASS**（含残留 DEF-R4） | F4-a…F4-h 共 8 项定向用例；`tests/f4-custom.test.ts` 2 项通过；`stiffness`→N/m 双向换算正确；custom-only 免除无关 g/length 阻塞；非 custom-only 的 g=0 / g=null 仍被拒绝；圆周 g=0 豁免未被破坏；无伪造周期或压缩量 |
| **严格草稿路径契约** | **PASS** | `interpret.ts` 已用 `strictReferences: true`；S-a…S-j 共 10 项正反例全部符合预期；非法草稿不进入面板、不覆盖场景 |
| **本地自动测试** | **PASS** | `pnpm test` 27 文件 / 486 项；typecheck exit 0；build 成功；`test:function` → `FIXTURE: ALL PASSED`；定向 6 文件 / 177 项；`git diff --check` exit 0 |
| **线上条件** | **BLOCKED** | 登录 / Secret / 网关 / 健康检查全部正常，但线上 bundle `index-z4p0wKWI.js` 不含本轮修复（DEP-1），且任务禁止发布；已实测线上仍复现 F1 与 F2，证明是部署落后而非环境故障 |

### 9.11 未解决问题与下一步

| 编号 | 严重级别 | 状态 | 下一步 |
| --- | --- | --- | --- |
| DEF-R2 | S3 | 未解决 | **优先修**：正则第一组补「离开电场/进入电场/穿出」等等价措辞（触发源是线上真实模型输出） |
| DEF-R1 | S3 | 未解决 | 正则第二组补「时间/时刻」，或改用 question→字段显式对照 |
| DEF-R3 | S3 | 未解决 | 命中前排除「出场后/之后/继续」等后续过程语义 |
| DEF-R4 | S3 | 未解决 | custom-only 场景跳过通用运动模板附加答案，或显式标注为等效模型结果 |
| OBS-1 | S3 | 待确认 | 评估纯重力 + `field_entry`/`field_exit` 是否也可免质量 |
| DEP-1 | S2 | 阻塞中 | 取得授权后发布当前构建，再按任务第四阶段 4 道题面重跑线上复查 |
| ENV-1 | 环境 | 阻塞中 | 安装 Deno 后可在本地跑真实 Function 通道 |

按任务文件要求，以上缺陷**只记录原始复现，本轮未做任何修复改动**，等待用户授权。

### 9.12 凭据与敏感信息安全检查

| 检查项 | 结果 |
| --- | --- |
| 本节是否含 `QWEN_API_KEY` / `QODER_PAT` / Bearer Token / Cookie | **无** |
| 本节是否含题图 Base64 | **无**（本轮线上两题均为纯文字题，日志 `hasImage:false`） |
| 本节是否含完整模型原始输出 | **无**（只摘录 AI 面板渲染后的 known/assumed/unknown/warnings 摘要与本地求解器答案） |
| 函数请求日志 | 仅 `timestamp / request_id / status_code / execution_time_ms / function_name / pathname / method`，无题面、无凭据 |
| 函数输出日志 | 仅 `event / jobId / sessionId / model / enabledModels / hasImage / textChars`；**只记录题面字符数，不记录题面原文**；无模型原始输出、无凭据 |
| `pnpm run test:function` 安全断言 | `日志不含题图 base64`、`日志不含凭据字段`、`日志不含模型原始输出`、`日志保留安全诊断字段` 四项 **PASS** |
| 临时用例文件 | `tests/zz-recheck-scratch.test.ts` 已删除；不含任何凭据；`git status` 复核工作区与本轮开始时一致 |
| 工作区完整性 | 未 reset / clean / commit / push / 创建 PR / 发布站点；用户 21 个已修改文件与 7 个未跟踪文件（含 `.高中物理工作台.qoder.site.bak`）全部保留 |

### 9.13 完成标准对照

| # | 标准 | 结果 |
| --- | --- | --- |
| 1 | 本地自动检查结果完整 | **达成**（§9.2：5 条命令 + 定向子集 + 37 项专项用例，均附退出码与通过数） |
| 2 | F1–F4 每项都有定向复查结果 | **达成**（§9.3–§9.6，共 28 项定向用例逐项列出输入与实际输出） |
| 3 | 严格草稿路径契约有正、反例结果 | **达成**（§9.7：正例 S-a/S-f/S-g/S-j，反例 S-b/S-c/S-d/S-e/S-g，兼容模式 S-h，端到端 S-i） |
| 4 | 若执行线上测试，明确记录登录、Secret 和网关状态 | **达成**（§9.8：三项均正常；bundle 标记证明部署落后；五类问题归类） |
| 5 | 所有 FAIL 都有最小复现和证据 | **达成**（DEF-R1…DEF-R4 均含最小输入、复现步骤、预期/实际、代码位置证据） |
| 6 | 所有 BLOCKED 都写明外部阻塞原因 | **达成**（DEP-1 部署授权阻塞、ENV-1 本地 Deno 缺失） |
| 7 | 没有泄露任何凭据、题图 Base64 或模型原始输出 | **达成**（§9.12） |

**本轮检测完成。** 判定：F1 **PASS**、F2 **PASS**、F3 **FAIL**（3 项正则覆盖缺陷）、F4 **PASS**（含 1 项 S3 残留 DEF-R4）、严格草稿路径契约 **PASS**、本地自动测试 **PASS**、线上条件 **BLOCKED**（部署落后，非环境故障）。

### 9.14 F3/F4 修复复验（2026-11-28）

本节追加记录本轮对 DEF-R1、DEF-R2、DEF-R3、DEF-R4 的修复结果；前文独立复查的原始 FAIL 证据保留不改。当前仍是本地工作区验证，未重新发布 Qoder Sites。

#### F3 残留修复

`src/solver/index.ts` 的兼容 custom 识别现已覆盖“出场、进场、离场、离开电场/磁场、进入电场/磁场、穿出电场/磁场”等措辞，并把“时间/时刻、位置、位移、速度、速率、方向、坐标”视为场区结果字段。问题方向还会与结构化 `field_entry` / `field_exit` 待求量对应；场景仅有进场结果时，不会声称出场量已覆盖。对“出场后、之后、以后、随后、继续、最高点、落地后”等后续过程先排除，避免把场外最高点问题误指向 `field_exit`。

新增回归结果：

| 用例 | 结果 |
| --- | --- |
| `出场时间` | PASS：custom note 含“场区进出场结果覆盖” |
| `离开电场时的竖直位移` | PASS：custom note 含“场区进出场结果覆盖” |
| `出场后继续上升到最高点的速度` | PASS：custom note 保留“没有对应的专用求解”，且不含“场区进出场结果覆盖” |
| `场区内速度随时间的变化` | PASS：保留“没有对应的专用求解”，不会被宽泛的“场区”字样误判为出场查询 |
| 仅有 `field_entry` 时询问 `出场时间` | PASS：保留“没有对应的专用求解”，不指向不存在的 `field_exit` 答案 |

因此 DEF-R1、DEF-R2、DEF-R3 在当前工作区均已 PASS。结构化 `field_entry/field_exit` 答案本身未被 custom 过滤逻辑覆盖或删除。

#### F4 残留修复

`src/solver/index.ts` 现在对 `custom-only + stiffness` 场景清除普通运动模板的 `steps`、`formulas` 和普通答案，仅保留原 custom 待求项，并设置 notice：当前不支持弹簧动力学，不输出等效普通运动结果。

新增单物块弹簧求解回归：`validateScene(scene).blockers` 为空，`solve(scene).ok === true`，结果只保留 `period` custom answer，不含 `accel`、`end_t`、`end_v`，notice 含“不支持弹簧动力学”。DEF-R4 现为 PASS。

#### 本轮本地验证

```text
定向：pnpm exec vitest run tests/ai-scene-contract.test.ts tests/f4-custom.test.ts
       2 文件 / 86 项通过
完整：pnpm test → 27 文件 / 492 项通过
       pnpm run typecheck → 通过
       pnpm run build → 通过（仅既存大包体积警告）
       pnpm run test:function → FIXTURE: ALL PASSED
       git diff --check → 通过
```

#### 当前边界

- F1、F2、F3、F4：当前工作区本地回归均 PASS。
- 线上状态仍为 **BLOCKED**：尚未重新部署当前构建，因此没有声称线上 F3/F4 已修复。
- ENV-1 仍记录为环境问题：本机没有 Deno，不能启动 `dev/function-local.ts` 的真实本地 Function 通道。
- 本轮未执行 `git reset --hard`、`git clean -fd`、commit、push、PR 或 Qoder Sites 发布；现有本地改动继续保留。

补充边界回归：`场区内速度随时间的变化` 不再命中出场结果提示，且只有 `field_entry` 时不会覆盖不存在的 `field_exit`。完整本地测试因此更新为 27 文件 / 492 项通过。

---

## 10. P3 QoderCN 对接复核（2026-11-28）

任务来源：`自动化/P3-QODERCN-对接执行文件-F3-F4.md`。本节是对 §9.14（修复方自述复验）的**独立复核**，所有结论均来自本轮实际重跑，未沿用自述结果。§1–§9 历史章节（含 §9.9 的原始 FAIL 证据与 §9.14）全部保留未改。

前置状态：`git rev-parse --short HEAD` → `f4d6298`；工作区 22 个已修改文件 + 8 个未跟踪条目全部保留；本轮未执行 `git reset --hard`、`git clean -fd`、`git checkout -- .`、commit、push、创建 PR 或 Qoder Sites 发布；未设置 `VITE_AI_DEMO=1`；未把本地 fixture 当作线上通过证据。

### 10.1 F3 复核 —— **PASS**

场景：`ELECTROMAGNETIC_EXAMPLES` 中 `id === 'electric-field'` 的电场示例（含 `field_exit` 结构化待求量），逐条追加 custom 问题后调用 `solve()`，读取该 custom 答案的实际 `note`。

| custom 问题 | 预期 | 实际 note | 判定 |
| --- | --- | --- | --- |
| `出场时间` | 含"场区进出场结果覆盖" | `该问题已由场区进出场结果覆盖，请查看对应进场/出场待求量的时间、位置、位移和速度字段。` | **PASS**（§9.9 DEF-R1 已修复） |
| `离开电场时的竖直位移` | 含"场区进出场结果覆盖" | `该问题已由场区进出场结果覆盖，请查看对应进场/出场待求量的时间、位置、位移和速度字段。` | **PASS**（DEF-R2 已修复） |
| `出场后继续上升到最高点的速度` | 含"没有对应的专用求解"，不含"场区进出场结果覆盖" | `此问题已保留，当前没有对应的专用求解；请查看相关阶段或补充建模。` | **PASS**（DEF-R3 误报已修复） |
| `场区内速度随时间的变化` | 含"没有对应的专用求解"，不含"场区进出场结果覆盖" | `此问题已保留，当前没有对应的专用求解；请查看相关阶段或补充建模。` | **PASS**（未被"场区"字样宽泛误判） |

四条 custom 答案的 `value` 全部为 `null`，**没有伪造任何数值**。

**只有 `field_entry` 的边界**：把示例场景的结构化待求量由 `field_exit` 改为 `field_entry`，再追加 custom `出场时间` → 实际 note 为 `此问题已保留，当前没有对应的专用求解；请查看相关阶段或补充建模。`，**未声称已有出场结果** → PASS。

**结构化答案完整性**：对同一电场示例分别在"不含 custom"与"含上述 4 条 custom"两种情况下求解，过滤掉 custom 自身答案后逐条比对 `label / value / unit`：

- 两侧均为 **9 条**结构化答案，`label / value / unit` **完全一致**（`toEqual` 通过）；
- 数值样例：`首次出场时间 1.732050807568878 s`、`首次出场 · 位置 x 6.196152422706635 m`、`位置 y ≈ -2.36e-16 m`、`速度 vx 3 m/s`、`速度 vy -3.464101615137756 m/s`、`速率 4.582575694955842 m/s`；
- 结论：`field_entry` / `field_exit` 答案**未被 custom 兼容逻辑删除、覆盖或改成伪造数值** → PASS。

> 说明：比对按 `label/value/unit` 而非 `id`，因为 `makeAsk()` 的 id 由 `uid()` 随机生成，跨场景不可比；首次用 id 比对失败属复核用例自身缺陷，已修正后重跑，非产品问题。

代码位置：`src/solver/index.ts` 中新增 `fieldEntryQuery` / `fieldExitQuery` / `genericFieldBoundaryQuery` / `fieldAfterQuery` 四组正则，并要求问题方向与场景中实际存在的 `field_entry` / `field_exit` 对应（`fieldQueryCovered`），再叠加"后续过程"排除与字段词匹配（`时间|时刻|位置|位移|速度|速率|方向|坐标`）。

### 10.2 F4 复核 —— **PASS**

**主用例**：单物块 `block`（`mass: null`、`attach.s: 0`、`vel: {x:0,y:0}`）+ `horizontal` 支撑面（`angleDeg: 0`、`length: null`）+ `contacts μs=μk=0` + `gravity: 0` + `params[k]=100 unit='stiffness'` + asks 全为 `custom`（`求振动周期`、`求最大压缩量`）。

| 检查项 | 实际结果 | 判定 |
| --- | --- | --- |
| `validateScene(scene).blockers` | `[]`（空） | PASS |
| `solve(scene).ok` | `true` | PASS |
| `solution.notice` | `当前题目包含弹簧模型，但工作台暂不支持弹簧动力学；仅保留原待求问题，不输出等效普通运动结果。` → 含"不支持弹簧动力学" | PASS |
| `solution.answers` | 仅 2 条，id 与两个 custom ask 一一对应；`label` 为 `求振动周期` / `求最大压缩量`；`value` 均为 `null`；note 均为"此问题已保留，当前没有对应的专用求解…" | PASS |
| 不出现 `accel` / `end_t` / `end_v` | 三者均不存在 | PASS（§9.9 DEF-R4 已修复） |
| 不输出周期 / 最大压缩量伪造数值 | 所有 answer `value === null`，无任何数值 | PASS |
| `solution.steps` / `solution.formulas` | 长度均为 **0**（`toEqual([])` 通过） | PASS |

**边界回归（§4 要求 5 项）**

| 边界 | 实际结果 | 判定 |
| --- | --- | --- |
| 有 `stiffness` 但混有专用 ask（`custom` + `at_time`，`gravity: 10`、`length: 5`） | `notice === undefined`（未套用弹簧通告）；answers 含 `accel=0`、`end_t=null`、`a…x=0`、`a…v=0` 与 custom 保留项 → **未过度过滤** | PASS |
| 无 `stiffness` 的普通 custom-only 场景（`gravity: 10`、`length: 5`） | `notice === undefined`，不含"弹簧"字样 → **未误判为弹簧** | PASS |
| 普通物块 `gravity: 0` | 阻塞 `gravity: g 必须为正数` | PASS（约束保留） |
| 普通物块 `gravity: null` | 阻塞 `gravity: 缺少重力加速度 g（可填 9.8 或 10）`，code `missing_required` | PASS（约束保留） |
| 圆周运动 `gravity: 0` | `validateScene` 阻塞为 `[]`，`solve().ok === true` | PASS（豁免未回归） |
| `stiffness` 单位 | `UNITS.stiffness === {"N/m":{"si":1,"label":"N/m"}}`；`toSI(100,'N/m','stiffness') === 100`；`fromSI(100,'N/m','stiffness') === 100` | PASS |

代码位置：`src/solver/index.ts` 新增 `customOnly && scene.params.some(p => p.unit === 'stiffness')` 判定，命中时按 custom ask id 过滤 `answers`、清空 `steps` 与 `formulas` 并设置 `notice`。

### 10.3 严格草稿路径契约 —— **PASS**

调用点确认：`functions/interpret.ts:184` → `return validateSceneDraft(candidate, { strictReferences: true });`。
`functions/draft-schema.ts` 的严格分支：`:470`（known/assumed）、`:490`（unknown）、`:505`（路径形态 uncertain）。

本轮独立正反例（7 组）实测：

| 用例 | 实际结果 |
| --- | --- |
| 正例：known/assumed/unknown 路径全部可定位 | 严格模式通过，三类条目分别保留 1 条 |
| 反例：`known` 增加 `bodies.b1.vel.x_after` | 抛 `draft 路径不存在：bodies.b1.vel.x_after` |
| 反例：`assumed` 增加 `bodies.b1.vel.x_after` | 抛 `draft 路径不存在：bodies.b1.vel.x_after` |
| 反例：`unknown` 增加 `supports.s1.height` | 抛 `draft 路径不存在：supports.s1.height` |
| 反例：`uncertain = ['bodies.b1.vel.x_after']`（路径形态） | 抛 `draft 路径不存在：…` |
| 正例：`uncertain = ['无法确认题图中的边界是否足够大']`（自然语言） | **不抛错**；`uncertain` 长度 0，`warnings` = `["模型不确定性说明（非路径，已转入警告）：无法确认题图中的边界是否足够大"]` |
| `asks.<kind>` 存在性 | `asks.friction_state`（场景存在）通过；`asks.apex`（不存在）抛 `draft 路径不存在` |
| 兼容模式（不传 `strictReferences`） | 无效 known 行被剔除，`warnings` 含"无法定位的已知" |
| 端到端 `extractDraft()` | 抛 `InterpretError`：`code='ai_draft_invalid'`、`status=502`、`diagnostic='reference'`，**不返回草稿**；异常信息不含凭据 |

**非法草稿不进入面板 / 不覆盖场景**：`src/ui/AiPanel.tsx:60` 仅在 `readProblem` 成功返回后才 `dispatch({type:'setDraft', draft: result})`；失败走 `setError`，`:34` 与 `:169` 只会把 draft 置 `null`。因此非法草稿既不会进入预览，也不会覆盖当前场景（§4.5、§5.1–§5.3 的线上实测已印证错误/取消时场景逐字节不变）。

### 10.4 必跑命令结果（§6）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm exec vitest run tests/ai-scene-contract.test.ts tests/f4-custom.test.ts` | **2 文件 / 86 项通过**（`ai-scene-contract` 83 项、`f4-custom` 3 项）——与基线一致 | 0 |
| `pnpm test` | **27 文件 / 492 项通过**——与基线一致 | 0 |
| `pnpm run typecheck` | `tsc -b --noEmit` 无错误 | 0 |
| `pnpm run build` | 成功，产物 `dist/assets/index-Cp2i2VkH.js`；仅 >500 kB chunk 体积警告（按要求只记录，**不计为功能失败**） | 0 |
| `pnpm run test:function` | 末行 `FIXTURE: ALL PASSED`（含"日志不含题图 base64 / 不含凭据字段 / 不含模型原始输出 / 保留安全诊断字段"四项 PASS） | 0 |
| `git diff --check` | 无空白错误，仅 4 条 LF→CRLF 提示 | 0 |

**本轮另构造的独立探针**：按 §3、§4、§5 新建 **19 项**用例实跑（F3 六项含结构化答案完整性、F4 主用例 + 6 项边界、严格契约 7 组），**19/19 通过**。临时文件 `tests/zz-handoff-recheck.test.ts` 检测结束后**已删除**，`git status` 复核工作区与本轮开始时一致（未留下新文件）。

> 环境：Windows 10.0.26200 / Node v22.14.0 / pnpm 9.15.0 / vitest 2.1.9。本机仍无 Deno，`dev/function-local.ts` 无法启动，本地真实 Function 通道仍为环境阻塞（§9.9 ENV-1），不计入 F3/F4 产品判定。

### 10.5 新发现的问题

**未发现新 bug。**

- §9.9 记录的 DEF-R1、DEF-R2、DEF-R3（F3 三处正则覆盖缺陷）与 DEF-R4（F4 单物块弹簧输出无关直线运动答案）在本轮独立复核中**全部不再复现**，判定为已修复。
- OBS-1（纯重力 + `field_entry`/`field_exit` 且 `mass: null` 时仍要求质量）本轮未重新判定，仍为**待确认的保守行为**，不产生错误数值。
- 本轮唯一一次用例失败源于复核脚本自身用随机 `uid()` 比对答案 id，已修正，**非产品缺陷**。

### 10.6 线上状态 —— **BLOCKED / 未部署**

| 项 | 实测（2026-11-28 本轮） |
| --- | --- |
| 线上 bundle | `assets/index-z4p0wKWI.js`（1,660,190 字节） |
| `不支持弹簧动力学`（F4 新 notice） | **false** |
| `场区进出场结果覆盖`（F3 新提示） | **false** |
| `stiffness`（F4 新单位） | **false** |
| 本地本轮构建产物 | `dist/assets/index-Cp2i2VkH.js`（与线上不同） |
| 健康检查 | `GET /functions/v1/app?name=Physics` → **200**，`X-Scene-Contract-Revision: fields-and-stages-v6` |

**结论：线上状态 = `BLOCKED / 未部署`。** 站点本身可访问、函数健康、契约版本正确，但运行的仍是 F3/F4 修复前的构建，因此**不得**把本轮本地测试、Function fixture 或 §4/§9.8 的历史线上结果写成"当前线上修复已确认"。§9.8 实测的线上 F1（`小球 · 质量` 阻塞）与 F2（`斜面 · 长度` 阻塞）在重新发布前仍会在线上复现。

解除条件：取得用户另行授权后执行 `prepare_site` + `publish_site` 发布当前工作区构建，再按 §9.8 的题面在线上重跑 F3/F4 复查。本轮**未**部署、未提交、未推送、未创建 PR。

### 10.7 敏感信息安全检查

| 检查项 | 结果 |
| --- | --- |
| 本节是否含 Secret / `QWEN_API_KEY` / `QODER_PAT` / Bearer Token / Cookie 的**值** | **无**（仅出现变量名用于说明配置状态） |
| 是否含题图 Base64 | **无**（本轮为纯本地单元测试，未上传任何题图） |
| 是否含完整模型原始输出 | **无**（本轮未调用云端模型；摘录内容均为本地求解器 answer/note 与单元测试输出） |
| `pnpm run test:function` 安全断言 | 4 项全部 PASS |
| 工作区完整性 | 未 reset / clean / checkout / commit / push / PR / 发布；临时探针文件已删除 |

### 10.8 判定汇总

| 项 | 判定 |
| --- | --- |
| **F3** 场区进出场与重复 custom | **PASS**（4 条问题措辞 + field_entry-only 边界 + 结构化答案完整性，共 6 项全通过） |
| **F4** 不支持弹簧题 | **PASS**（主用例 7 项检查 + 6 项边界回归全通过） |
| **严格草稿路径契约** | **PASS**（`interpret.ts:184` 严格模式 + 7 组正反例 + 端到端 `ai_draft_invalid`/502 + 面板不接收非法草稿） |
| **本地命令** | **PASS**（6 条命令退出码全 0；492 项 / 86 项 / fixture ALL PASSED） |
| **新发现 bug** | **未发现新 bug** |
| **线上** | **BLOCKED / 未部署** |
