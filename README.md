# 高中物理工作台

面向高中物理的交互式网页原型，参考 GeoGebra 的对象、参数与图形联动方式。支持搭建场景、调整参数，并查看解析答案、推导、运动动画与曲线。

## 当前能力

- 二维场景编辑、对象列表、属性面板、参数绑定与滑块。
- 初始位置与速度编辑、画布缩放平移、撤销与重做。
- 匀变速直线运动、抛体运动、单物体斜面摩擦求解。
- 运动轨迹、时间轴、曲线和公式推导。
- 场景浏览器本地保存、JSON 导入导出。
- AI 建模草稿的预览与应用入口。

**AI 读题目前默认使用预设演示数据，尚未接入真实的云端识别服务。** 设置 `VITE_AI_ENDPOINT` 后，前端会向指定服务发送题目与可选图片，并接收场景草稿。当前仓库不包含该服务端实现，也尚未完成 Qoder Sites 部署。

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

## 可选 AI 服务

在本地 `.env.local` 中配置：

```dotenv
VITE_AI_ENDPOINT=https://your-backend.example/api/interpret
```

接口接受 JSON 格式的 POST 请求：`text`，以及可选的 `imageBase64` 和 `imageName`。响应需符合 `src/model/types.ts` 中的 `SceneDraft` 类型。图片大小上限为 4 MB。

所有 `VITE_` 变量都会进入浏览器构建，只能配置公开服务地址；AI 服务密钥应保存在后端。公开上线前需实现服务端访问控制、限流与调用额度控制。

## 项目结构

- `src/model`：场景类型、单位、几何、参数与模型校验。
- `src/solver`：物理解析求解器。
- `src/state`：编辑状态、历史记录与持久化。
- `src/ui`：画布、对象与属性、动画、曲线和结果面板。
- `src/ai`：AI 接口客户端与演示草稿。
- `tests`：自动测试。

完整方向和部署计划见 [PLAN.md](./PLAN.md)。
