# OpenBoxHub 开发约定

## 项目目标

OpenBoxHub 是纯前端参数化收纳盒设计工具，仓库为 `geekheart/OpenBoxHub`，在线地址为 `https://geekheart.github.io/OpenBoxHub/`。用户在浏览器内配置外盒、整数网格与合并内盒、底板和盒盖，查看装配，再下载 STL/ZIP。

请优先保持几何正确性、参数含义与可打印的导出结果。界面以中文为主，尺寸统一为毫米。不得把网格检查、切片软件读取或效果图描述为实物打印验证。

## 环境与命令

使用 Node.js 24、pnpm 11.19.0 和已提交的 `pnpm-lock.yaml`。

```bash
pnpm install --frozen-lockfile
pnpm dev --port 5173
pnpm test
pnpm build
pnpm preview --port 4173
```

- `pnpm test` 使用 Node test runner 与 `tsx`，测试位于 `tests/geometry.test.ts`。
- `pnpm build` 执行 `tsc -b` 后通过 Vite 构建到 `dist/`。
- `启动盒子工坊.command` 是 macOS 本地便利入口，不是部署必需项。通用安装和开发命令应始终可用。
- 保持固定依赖与锁文件一致；确需更改依赖时，一并更新锁文件。

## 架构与职责

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 参数类型、默认参数、打印与装配数据结构 |
| `src/geometry.ts` | 无 DOM 的参数校验与 Manifold 实体建模 |
| `src/geometry.worker.ts` | 初始化 WASM、响应建模请求、转移网格数组 |
| `src/App.tsx` | 参数状态、分组编辑、Worker 请求、导出弹窗及 Blob 下载 |
| `src/Scene.tsx` | Three.js 渲染、相机、组件选择、显隐与装配动画 |
| `src/export.ts` | 二进制 STL、平铺排布、ZIP、参数和装配清单 |
| `src/styles.css` | 工作台、全屏、弹窗与响应式布局 |

新增参数时同步检查类型、默认值、界面、`validateParams`、几何、导出清单、测试和 README。参数约束应有清楚的用户提示；不要在核心中悄悄钳制输入。

## 纯前端边界

- 参数建模、预览、STL 序列化和 ZIP 生成都必须在浏览器中完成。
- 不引入保存 API、业务后端、数据库、模型上传或服务端文件写入。Vite 仅是开发服务器，线上仅需静态文件。
- Manifold WASM 使用 Vite 资源导入，Worker 使用模块 URL；保持根目录与仓库子目录部署可用。不要硬编码 `/assets/` 等站点根路径。
- 通过 `Blob` 和带 `download` 属性的链接触发浏览器下载，及时释放对象 URL。异步导出应检查模型和目标是否仍匹配，不能下载过期模型。
- 保留 Worker 请求序号检查，忽略过时结果；参数修改不能被先前的异步计算覆盖。模型无效或正在更新时，不应允许导出旧状态。
- 模型生成失败时可保留上一个有效预览，但要明确显示错误与旧模型状态。

## 实体建模约定

- 在 `geometry.ts` 保持可测试的建模核心，不依赖 React、Three.js 或浏览器 DOM。
- 使用 Manifold/CrossSection 的实体布尔运算生成真实壁厚、内腔和贯通孔，不得用材质透明、双面薄片或视觉遮盖代替可导出的几何。
- 合并内盒必须先合并格子轮廓，再裁切到外盒内腔，偏移间隙和壁厚，最后挖空。不能留下合并前的内部隔墙。
- 分组必须完整且不重复地覆盖网格，每组通过共边连通；仅对角相连不是有效内盒。支持矩形、L 形及有效环形分组。
- 外盒锁定后，内盒划分不能改变其尺寸。仅切换 `lidType` 时，外盒和内盒网格应保持一致。
- 所有盖型统一预留 `lidDepth + lidClearance` 的内盒顶部空间；修改该规则必须检查盖型互换和装配干涉。
- `gap` 是每个内盒对格子边界的单边间隙，相邻内盒间隙为 `2 × gap`；`lidClearance` 是盒盖单边间隙。
- 镂空目前仅作用于外盒底板。保留边缘实心区域，仅接纳完整孔，验证真实孔宽、最小筋宽和内壁留边。无完整孔时明确提示，过密阵列应有计算量限制。

### WASM 资源释放

Manifold、CrossSection 及运算产生的临时结果通常持有 WASM 句柄，不能依赖 JavaScript GC 释放。

- 在 `buildModel` 中沿用 `keep()` / `resources` 管理，并在 `finally` 中释放所有句柄，包括异常路径。
- 每次 `offset`、`translate`、`extrude`、布尔运算、`decompose()` 等返回的新句柄都要登记。不要漏掉链式调用的中间对象，也不要重复登记并重复释放同一对象。
- 返回主线程的数据应为复制后的普通对象和 TypedArray，不能包含存活的 WASM 实体。
- 转成 Float32 后仍须保持闭合、正向且无退化三角面；不要删除现有量化重建和简化步骤而不验证极小圆角、薄壁和大尺寸情况。
- Three.js 的几何、材质、控制器和渲染器，以及事件监听、动画帧、Worker 与对象 URL，同样需要在更新或卸载时清理。

## 打印坐标与展示分离

- `PartData.positions` 是不可被场景修改的标准打印网格：毫米、XY 居中、最小 Z 为 0。
- 外盒和内盒开口向上；盒盖顶板向下、定位裙边向上，便于独立打印。
- `assemblyPosition` / `assemblyRotation` 仅描述装配，爆炸、开盖、透明、相机与显隐仅属于展示状态。
- `serializeSTL` 只能序列化标准打印网格，不能直接从 Three.js 场景或当前动画姿态抓取数据。
- 平铺 STL 可应用自己的排布平移，但每个零件必须位于 Z=0 且彼此分离。该通用排布不承诺适合特定热床。
- ZIP 保持每个零件独立，并包含毫米单位、参数、分组、装配变换和打印说明。STL 本身不保存单位或打印配置。

## 验证

几何或导出修改后运行 `pnpm test` 与 `pnpm build`。当前测试覆盖真实 Float32 坐标焊接后的边闭合和方向、退化面、体积、尺寸、装配无干涉、盖型互换、L 形/环形合并、完整孔阵列及无需网络的下载文件生成。

根据实际改变补充有意义的回归用例，避免仅重复实现细节的测试。尤其注意：

- 极限尺寸、小圆角、薄壁与多行列组合。
- 外盒、所有内盒和盒盖之间没有实体体积重叠。
- 合并真正减少隔墙，镂空是真实贯通孔，导出不受展示姿态影响。
- 文件完整、STL 面数与字节数一致、ZIP 内零件数和清单一致。

界面或资源加载有改动时，在浏览器检查有效模型、参数修改、错误反馈、全屏与退出、合并与拆分、底板、盖型、视图切换及 STL/ZIP 下载。生产检查使用 `dist/` 的 HTTP 静态服务，并验证子路径下 Worker、WASM 和图片加载；仅运行开发服务器不等于部署验证。

打印验证应准确分层描述：自动化网格/装配检查、Bambu Studio 读取/切片检查、实物试打。没有实物记录时，不宣称配合、承载或材料收缩已验证。

## 文档与截图

- `README.md` 是项目介绍与使用部署入口；`AGENTS.md` 是维护规则；`agent.md` 仅指向本文件，避免维护两套规则。
- README 截图放在 `docs/images/`，使用实际运行页面：`overview.png`、`layout-merge.png`、`perforation.png`、`exploded.png`、`export.png`。
- 截图前等待建模与渲染完成；展示清楚的功能状态，避免错误提示、未加载画布、开发工具或私密信息。界面发生明显变化时更新相关截图及替代文本。
- README 中的功能、测试数量和部署步骤必须与代码一致，不使用虚构的许可证、Stars 或通过状态徽章。
- 原始 `.3mf` 参考文件保留本地，不作为构建、在线运行或公开仓库的必要资源；不要覆盖原件。参考测量与推断记录在 `docs/reference-analysis.md`，区分原模型事实与新增设计。

## GitHub Pages 发布

- 仓库：`https://github.com/geekheart/OpenBoxHub`；默认发布分支：`main`。
- 工作流：`.github/workflows/pages.yml`；Pages Source 使用 **GitHub Actions**。
- 推送 `main`、推送任意 tag，或选择 `main` / tag 手动触发后，先安装锁定依赖并测试、构建，再将对应提交的 `dist/` 作为 Pages artifact 部署。PR 仅测试构建；删除 tag 不部署。
- `github-pages` environment 允许 `main` 分支和 `*`、`**/*` 两个 tag 名称规则。生产发布共用并发组，避免分支与 tag 同时覆盖站点；工作流权限按需要最小化。
- 保持 Vite 的相对 `base`，以支持 `https://geekheart.github.io/OpenBoxHub/` 的子路径。图片、Worker、WASM 不应依赖本机绝对路径。
- 不提交 `node_modules/`、`dist/`、本地导出物、临时日志或认证信息。发布产物由 Actions 构建，不手工维护第二套站点代码。
- 发布后确认工作流成功，并实际访问线上页面检查模型、静态资源和下载，再报告已上线。
