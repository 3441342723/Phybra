# 高中物理工作台

面向高中物理的交互式网页原型，参考 GeoGebra 的对象、参数与图形联动方式。支持搭建场景、调整参数，并查看解析答案、推导、运动动画与曲线。

## 当前能力

- 二维场景编辑、对象列表、属性面板、参数绑定与滑块。
- 「视图 → 坐标维度」可开启三维 x/y/z：小球可编辑 z、vz，重力/电场可编辑 z 分量，磁场可编辑 Bx、By、Bz。画布可右键拖动旋转（触屏用「旋转视角」），滚轮缩放；拖动物体保持 z，z/vz 在属性中修改。曲线包含 z、vz、az，能量和答案使用同一份空间运动结果。
- 「载入示例 → 三维运动」提供螺旋运动、倾斜磁场、空间电场加速。三维首版支持一个自由小球与多个全局场（匀强重力/电场/磁场、点质量/点电荷、沿轴线性渐变重力/电场），暂不支持有限场区、支撑面、绳杆、碰撞或线性渐变磁场；这些组合会明确提示。三维自由空间不默认附加地面，切回二维时保留空间参数并提示处理非零空间分量。
- 「对象」中创建小球、物块、绳、杆和斜面；斜面设为 0° 就是水平面。「场」可叠加重力、电场、磁场及点质量/点电荷源。场区支持全局、矩形、圆形和多边形；匀强场可切换为线性渐变场，小球可选是否带电。
- 「载入示例 → 电磁学」包含平行板加速/偏转、磁场出界/半圆返回、复合场速度选择和场区穿越。矩形电场可由板间电压计算；待求量可查询进入/离开指定场区及穿越时的状态。
- 「载入示例 → 碰撞」包含等质量弹性对碰、完全非弹性正碰、不等质量追碰和二维斜碰。放置两个小球，编辑质量、碰撞半径、位置和初速度，并设置恢复系数，可查看碰前碰后速度、冲量、系统动量与动能损失。碰撞动画、曲线和能量图都会显示两球及碰撞耗散。
- 初始位置与速度编辑、画布缩放平移、撤销与重做。
- 匀变速直线运动、抛体运动、单物体斜面摩擦求解。
- 运动轨迹、时间轴、曲线和公式推导。
- 播放倍率可自行设置，默认 1×；倍率只影响播放，时间轴和答案仍显示真实物理时间。
- 场景浏览器本地保存、JSON 导入导出。
- AI 建模草稿的预览与应用入口；读题契约支持基础力学和带电小球/匀强电场/平行板/磁场的场景字段，数值缺失会保留为未知并交由本地求解器提示。

AI 读题默认调用 Sites 同源函数 `POST /functions/v1/app/interpret`。配置服务端 Secret `QWEN_API_KEY` 时，Function 通过 Qwen 兼容接口生成草稿，并用私有 Storage 保存任务意图与结果，客户端以 `GET .../interpret?job=...` 续取；未配置时回退到 Cloud Agents（`QODER_PAT`）。浏览器不接触任何云端凭据。未开启后端时该接口返回 `service_not_configured`，手动搭建与计算不受影响。设置 `VITE_AI_DEMO=1` 可强制回到内置演示草稿。

网页与读题服务共享小球、电荷、场和分阶段草稿格式；更新时应一起部署前端及整个 `functions/` 包。若发布后仍显示 `bodies.0.kind 不是支持的物体类型`，先用 Ctrl+F5 重新加载页面：旧版页面只认识物块及旧抛体，会拒绝合法的 `ball` 小球。新版请求和响应携带格式版本号，检测到不同版本时会明确提示刷新或同时更新两端。

可先运行 `npm run build`，再运行 `node tests/browser-ai-fields.mjs --production` 验证实际构建产物的读题、草稿、阶段应用、求解和撤销流程。该检查启动独立本地服务，使用实际客户端及 Function，仅以固定草稿替代 Cloud Agents，不使用凭据，不代表线上模型实测。浏览器默认使用 Chrome；本机只有 Edge 时在 PowerShell 先设置 `$env:CHROME_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'`。修订题全文及答案见 [碰撞与复合场修订题](docs/碰撞与复合场修订题.md)。

AI 草稿格式校验失败时，在能读取原始题面/题图且请求大小允许的情况下，服务端最多发起一次格式修正，并继续严格校验。尚未传完的 JSON 继续等待；修正仍失败时显示原因类别和“重新生成草稿”，不要求用户补全文字。重新生成使用新任务标识，避免一直复用失败结果；等待中断后的续取仍使用同一任务。修正结果不会直接替换当前场景，也不会用本地示例冒充 AI 输出。可分别用 `node tests/browser-ai-fields.mjs --repair`、`node tests/browser-ai-fields.mjs --regenerate` 验证自动修正和失败后重新生成流程；两者均为模拟云端返回的本地浏览器检查。

平行板采用理想匀强电场并忽略边缘效应。碰撞首版模拟两个自由小球的瞬时光滑碰撞；暂不包括外力、转动、切向摩擦、多次碰撞和物体形变。

## 本地运行

需要支持 Vite 5 的 Node.js，建议使用 Node.js 22 LTS 或更高版本。

```sh
npm ci
npm run dev
```

浏览器打开终端显示的本地地址，默认是 http://127.0.0.1:5173。

## 检查与构建

```sh
npm test
npm run typecheck
npm run build
npm run preview
```

构建目录为 `dist/`。当前测试覆盖求解器、单位、参数路径、状态管理、交互布局，以及动画与求解结果的一致性。

## AI 读题服务

默认端点是同源 `POST /functions/v1/app/interpret`，由 `functions/` 下的 Sites Edge Function 处理。服务端优先读取平台 Secret `QWEN_API_KEY` 调用 Qwen 兼容接口；未配置时读取 `QODER_PAT` 调用 Qoder Cloud Agents。密钥不进入源码、构建产物或浏览器。如需指向自建服务，在本地 `.env.local` 中配置：

```dotenv
VITE_AI_ENDPOINT=https://your-backend.example/api/interpret
```

接口接受 JSON 格式的 POST 请求，字段为 `text`，以及可选的 `imageBase64`（标准 Base64 编码）和 `imageName`。成功结果为 JSON `SceneDraft`，字段为 `source`、`scene`、`known`、`assumed`、`unknown`、`uncertain` 和 `warnings`。其中 `scene` 使用 version 2；缺少的物理数值用 `null` 表示。草稿中的 `known`/`assumed` 项包含 `path`、`label`、`value`，并可附带 `quote`/`basis`；`unknown` 项包含 `path` 和 `label`。路径必须引用草稿中的场景对象或受支持的求解目标。题面文字上限 8000 字符；题图在服务端按文件头识别 PNG/JPEG/WebP/GIF，并拒绝与文件扩展名不一致的内容，解码后上限 600 KB（超出返回 413 `image_too_large`）。POST 返回 `202` 和 `jobId` 后，客户端轮询同一路径的 `GET .../interpret?job=...`；Qwen 任务保存在私有 Storage，支持模型降级链、一次格式修正和阶段性超时重试。HTTP 429 显示额度耗尽，504 显示读题超时，其他非成功状态显示服务不可用。

`GET /functions/v1/app` 保留为健康检查。本地可在安装 Deno 后用 `deno run --allow-net=127.0.0.1:8000 dev/function-local.ts` 起函数，配合 `pnpm run dev` 的同源代理联调；无 Deno 时用 `node --experimental-strip-types dev/function-fixture.ts` 跑注入假 Cloud Agents 客户端的无凭据检查。

### 在 Qoder Sites 上启用真实读题

1. 在 Qoder 中打开本仓库，先在终端执行 `pnpm install`、`pnpm test`、`pnpm run typecheck` 和 `pnpm run build`。
2. 在 Sites 项目的服务端 Secrets/Environment Variables 中新增 `QWEN_API_KEY` 以启用 Qwen；如需 Cloud Agents 回退，再配置 `QODER_PAT`。它们必须是服务端 Secret，不能写入 `.env`、`VITE_` 变量、源码或前端构建配置。
3. 确认站点同时部署前端和 `functions/` 目录，并保留函数入口 `functions/index.ts`。前端默认请求同源 `POST /functions/v1/app/interpret`，不需要把 PAT 暴露给浏览器。
4. 先发布预览，在预览域名访问 `/functions/v1/app?name=Physics`；返回 `{"ok":true,...}` 才继续做真实读题验证。若返回 `service_not_configured`，检查 Secret 名称、作用域和部署版本后重新发布。
5. 在工作台打开“AI 读题”，确认状态显示“服务端读题”，提交一段文字题，再上传一张小于 600 KB 的 PNG/JPEG/WebP/GIF 题图。生成后先检查已知量、假设、缺项和警告，再点击“应用替换场景”；替换可以用撤销恢复。
6. 在 Qoder 的函数日志中只核对请求计数、任务/模型/会话 ID 和错误码，不记录题面、图片、API key 或模型原始输出。用完预览后再按 Sites 的发布流程发布正式版本，并重复健康检查、文字/图片、刷新续取和撤销验证。

本地不调用云端时可执行 `pnpm run test:function` 做无凭据函数契约检查，或用 `VITE_AI_DEMO=1 pnpm run dev` 使用内置演示草稿。客户端与服务端当前统一按 600 KB 题图上限校验；Function 已有最小间隔、单 IP/全局每日额度门控（由 `RATE_MIN_INTERVAL_MS`、`RATE_DAILY_PER_IP`、`RATE_DAILY_GLOBAL` 配置），但默认是进程内内存计数，持久化额度数据库和公开访问策略仍待 P4/P6。

### 线上受控验证记录（2026-11-25）

站点 `physics-workbench`（预览/发布同址 `https://physics-workbench-0nigdkgdgmj.qoder.zone`，访问范围 private，需登录）。前端 `dist/` 与 `functions/` 同次发布，函数入口 `functions/index.ts`，逻辑函数名 `app`。

- **健康检查**：`GET /functions/v1/app?name=Physics` → `{"ok":true,"message":"Hello, Physics!"}`（每次发布后复验）。
- **文字题**：「质量 2 kg…初速度 6 m/s…动摩擦因数 0.2，g 取 10」→ 合法草稿，`known` 附原文依据，`assumed` 显式记录 μs=μk 与水平面建模长度 100 m，加速度等未给量保持 `null`；应用后本地求解得 a=−2 m/s²、t=3 s、s=9 m，无需手填任何字段。
- **图片题**：题图标注 30°/5 m/μk=0.25，但三角形按 54° 绘制 → 草稿取标注值 30°，未按图形比例反推；质量与不相关量保持 `null`；应用后求解得 a=−2.83 m/s²、t=1.88 s、v=5.32 m/s。
- **草稿门禁**：生成期间与失败后 `phy.scene.v2` 逐字节不变；必须点击「应用替换场景」才写入；一次撤销后场景 JSON 与替换前逐字节一致；取消请求后等待超过服务端预算仍无迟到草稿写入，面板恢复可用。
- **凭据隔离**：浏览器网络请求全部同源，无 `api.qoder.com.cn` 直连；`dist/` 与 `src/` 中无 PAT/Bearer/云端密钥，构建产物里 `import.meta.env` 为空对象，仅保留 `VITE_AI_ENDPOINT`/`VITE_AI_DEMO` 两个公开名。`QODER_PAT` 只在 `functions/cloud-agents.mjs` 内经 `Deno.env.get` 读取。
- **函数日志**：仅 `interpret_start`/`interpret_done`/`interpret_incomplete`，字段为模型 ID、会话 ID、轮询次数、耗时、事件类型计数、`hasImage`、`textChars` 计数与错误码/字段路径级原因；无 PAT、题面原文、题图 base64 或模型原始输出。
- **错误流程（线上实测）**：空题面 → 400 `invalid_text`；700 KB 题图 → 413 `image_too_large`（面板提示「超过读题服务 600 KB 上限」）；非图片文件 → 415 `unsupported_image_type`；非法 JSON 请求体 → 400 `invalid_json`；上游超时 → 504（面板提示「读题超时：请精简题面或稍后重试」）。每次错误后原场景保留，手动搭建与本地求解仍可用（错误后重新求解仍得 t=3 s、s=9 m）。
- **错误流程（本地 fixture 覆盖，线上不便强制造成）**：429/额度耗尽、非法 SceneDraft、非法模型 JSON、无模型回复超时、无可用模型、方法与路径错误。
- **已知限制**：云端生成延迟波动大（Qwen 任务通过私有 Storage 续取，Cloud Agents 为回退通道）。Function 已做最小间隔与每日额度门控，但默认内存计数会在重启或跨实例时丢失；持久化额度、匿名公开访问与并发保护仍待 P4/P6。

客户端会对 AI 响应和导入场景执行运行时校验，包括字段类型、枚举、有限数字、唯一 ID、场景引用、参数绑定和草稿路径；电荷、电场、场区边界和电磁待求量也必须通过同一契约。结构错误会在进入预览前拒绝。物理条件缺失仍保留在场景草稿中，交由本地求解器报告并由用户补充。取消请求不会将迟到响应写入草稿；AI 只负责生成场景草稿，答案仍由本地确定性求解器计算。

所有 `VITE_` 变量都会进入浏览器构建，只能配置公开服务地址；AI 服务密钥应保存在后端。公开上线前需完成持久化额度、并发保护和访问控制，并按 P5/P6 复验。

## 项目结构

- `src/model`：场景类型、单位、几何、参数与模型校验。
- `src/solver`：物理解析求解器。
- `src/state`：编辑状态、历史记录与持久化。
- `src/ui`：画布、对象与属性、动画、曲线和结果面板。
- `src/ai`：AI 接口客户端与演示草稿。
- `tests`：自动测试。

完整方向和部署计划见 [PLAN.md](./PLAN.md)；P3 的实现、验证和后续交接见 [P3-HANDOFF.md](./P3-HANDOFF.md)。
