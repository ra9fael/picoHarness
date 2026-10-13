# PicoHarness

[![中文](https://img.shields.io/badge/Lang-中文-green.svg)](./README.md) [![English](https://img.shields.io/badge/Lang-English-blue.svg)](./README.en.md)

一块跑 CircuitPython 的 Pico，一个 HTML 文件，浏览器直连 USB 串口。
本仓库文档提供**中文**与**英文**两版：这份是中文版，英文版见 [README.en.md](./README.en.md)。基于 [PicoJig](../PicoJig-main)。

---

## 文档

| 文档 | 内容 |
| :--- | :--- |
| [使用手册](./docs/zh/01_GUIApp_FW_Manual/README.md) | 装机、界面、逐功能用法 |
| [协议参考](./docs/zh/02_Library_User_Guide/README.md) | 命令、事件、二进制帧 |
| [使用示例](./docs/zh/03_Sample_Program_User_Guide/README.md) | 动手 recipes 与故障排查表 |
| [构建指南](./docs/zh/04_FW_Build_Guide.txt) | 构建、部署、验证链、固件要点 |
| [版本说明](./docs/zh/05_Release_Notes.txt) | 版本历史 |

---

## 1. 概述

单页浏览器治具。页面通过浏览器的 **Web Serial API** 直连板子的 USB CDC 串口——数据口跑协议、
控制台口归 CircuitPython——板子上跑 `boot.py` + `code.py`，两边用 JSON-lines 说话。PC 侧什么都不装，也不起服务，交付物就是一个自包含的 HTML 文件。

已验证环境：Raspberry Pi Pico 2（rp2350a）、CircuitPython 10.3.1、桌面版 Chrome / Edge。

## 2. 功能

数字输入 / 输出、PWM、ADC（含片内温度虚拟通道）、I2C 原始总线事务、UART（带实时终端标签，可切 HEX/文本）、
SPI 原始总线事务（每条总线最多 4 路片选）、
ADC 波形的示波器面板、调试控制台（原始串口监听 + REPL 直通，日志走独立的控制台口，
进 REPL 不用重选端口；但 REPL 是靠 Ctrl+C 停掉 code.py 的，这段时间协议没人应答）。
界面中英双语、扁平化、无圆角。

## 3. 快速上手

```bash
npm install
npm run build          # -> dist/index.html（自包含单文件）
```

1. 给板子烧 CircuitPython UF2，得到 CIRCUITPY 卷。
2. `circup install asyncio adafruit_pioasm`：前者是固件事件循环的依赖，CircuitPython 不内置；后者只在 PIO 那台
   PWM 发生器上用得到，缺了不影响硬件 slice，界面只是不再出现 HW / PIO 选择。
3. 把 `src/fw/boot.py` 和 `src/fw/code.py` 复制到卷根目录（根目录若有 `main.py` 要删掉，它会顶掉 `code.py`），
   然后按一次 RESET：`boot.py` 只有硬复位才生效，第二个 CDC 口是它打开的。
4. 用 Chrome / Edge 打开 `dist/index.html`，点"连接设备"，在选择框里把这块板的所有条目全选。

完整装机与板子侧检查见 [使用手册 §2](./docs/zh/01_GUIApp_FW_Manual/README.md#2-准备板子)。

## 4. 目录结构

```
src/fw/        CircuitPython 固件（部署到 CIRCUITPY 卷）
src/ui/        界面源码（TS + CSS + HTML 模板）
docs/          双语文档
tools/         PC 侧调试脚本（需 .venv）
build.mjs      esbuild 打包 + 内联
```

## 5. 架构

固件是 `boot.py` + `code.py`：`boot.py` 只开第二个 CDC 口，协议本体在 `code.py` 里——
`COMMANDS` 分发表按 cmd 路由到各功能驱动；`claim(n, who, force)` / `release(n)`
引脚所有权裁决是所有硬件操作的唯一入口，"一个脚同一时刻只属于一个功能"由固件保证，不靠界面自觉。
主循环是 asyncio 任务组：命令读取、输入边沿、ADC 死区、波形流、UART 收字节流，命令与遥测互不排队。

界面分层，依赖单向向下：

```
serial.ts             Session 门面：认口 / 握手 / REPL / 状态机
├─ core/ports.ts      端口识别：两个 CDC 口共用同一 VID/PID，只能靠 nonce ping 认
├─ core/transport.ts  字节管道：端口所有权、混流分帧（文本行 + 0xAA'W' 二进制帧）
├─ core/rpc.ts        JSON-lines 协议：请求/应答配对、事件分发、ready 等待
model/pins.ts         工作台唯一数据真源
workbench/            引擎 + FunctionDef 插件（digital / pwm / adc / i2c / uart / scope / uartterm）
                      新增功能 = 写一个 def(+driver) 并注册进 defs 数组
core/events.ts        极简 Emitter
```

真机踩出来的调度坑（`stdin.read(1)` 会阻塞、`busio.UART` 默认读超时、USB CDC 上 `flush=True` 抛错、
`usb_cdc.Serial` 是二进制流）
写在 [04 构建指南](./docs/zh/04_FW_Build_Guide.txt)；线上格式见 [02 协议参考](./docs/zh/02_Library_User_Guide/README.md)。

## 6. 开发与验证

```bash
uv venv -p 3.12 --seed -n .venv
. .venv/Scripts/activate && uv pip install pyserial
.venv/Scripts/python.exe tools/serial_probe.py        # 自动找出两个口，自己认出口色
```

仓库没有 `tsconfig.json`，直接跑 `npx tsc` 会报 TS5058；显式类型检查命令、构建与部署步骤、完整验证链
都在 [04 构建指南](./docs/zh/04_FW_Build_Guide.txt)。`npm run build` 走 esbuild，不做类型检查。

## 7. 路线图

已完成：Web Serial 握手闭环、IO 分配工作台（引脚池 + 泳道、拖拽绑定、自动顶位、即时下发）、
GPIO / PWM / ADC 泳道（PWM 逐通道可选硬件 slice 或 PIO 状态机，实测低到 0.1 Hz）、ADC 批量波形流 + 示波器、片内温度虚拟通道、MQTT 式事件订阅、
二进制帧 kind 注册表、I2C 总线泳道（原始事务 + 合法序对探测）、UART 总线泳道 + 控制台实时终端标签、
SPI 总线泳道（按实测引脚组，允许半总线、每条最多 4 路 CS、原始字节事务台）、
调试控制台（监听 / REPL / 复制导出）、配置持久化（浏览器 localStorage）+ 导出/导入/清空菜单、
中英双语界面、双 CDC（协议独占数据口、并行 nonce ping 认口 + 角色缓存显示在状态栏、
自动挂日志口、进 REPL 不用重选端口）、设备端 `config.json`（板子卷上的第三份配置，手动保存才改写，
连接时按"板子 > 浏览器 > 空白"取用，冲突才问）。

下一步：独立错误面板。
