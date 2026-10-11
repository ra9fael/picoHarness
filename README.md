# PicoHarness

单页浏览器治具：一块跑 CircuitPython 的 Pico，一个 HTML 文件，USB 串口直连。
Single-file browser test harness: a Pico running CircuitPython, one HTML file, direct USB serial.

[![中文](https://img.shields.io/badge/Lang-中文-green.svg)](#文档--documentation) [![English](https://img.shields.io/badge/Lang-English-blue.svg)](#文档--documentation)

以 [PicoJig](../PicoJig-main) 为蓝本。PC 侧不装任何东西：浏览器用 **Web Serial API** 直连设备的 USB CDC 串口，
板子上跑一个 CircuitPython `code.py`，两边用 JSON-lines 说话。
已验证：Raspberry Pi Pico 2（rp2350a）、CircuitPython 10.3.1、桌面版 Chrome / Edge。

Built after [PicoJig](../PicoJig-main). Nothing to install on the PC: the page talks to the board's USB CDC port
through the **Web Serial API**, the board runs one CircuitPython `code.py`, and the two speak JSON-lines.
Verified on Raspberry Pi Pico 2 (rp2350a), CircuitPython 10.3.1, desktop Chrome / Edge.

功能：数字输入/输出、PWM、ADC（含片内温度）、I2C 原始总线事务、UART（含实时终端标签）、示波器面板、调试控制台（监听 + REPL 直通）。
Features: digital in/out, PWM, ADC (plus on-die temperature), raw I2C transactions, UART with live terminal tabs,
a scope panel, and a debug console (monitor + REPL passthrough).

## 文档 / Documentation

| 文档 Document | 中文 | English | 内容 Contents |
| :--- | :---: | :---: | :--- |
| 使用手册 / User Manual | [中文](./docs/zh/01_GUIApp_FW_Manual/README.md) | [English](./docs/en/01_GUIApp_FW_Manual/README.md) | 装机、界面、逐功能用法<br>Setup, UI, feature-by-feature usage |
| 协议参考 / Protocol Reference | [中文](./docs/zh/02_Library_User_Guide/README.md) | [English](./docs/en/02_Library_User_Guide/README.md) | 命令、事件、二进制帧<br>Commands, events, binary frames |
| 使用示例 / Workflows | [中文](./docs/zh/03_Sample_Program_User_Guide/README.md) | [English](./docs/en/03_Sample_Program_User_Guide/README.md) | 动手 recipes 与故障排查表<br>Hands-on recipes and troubleshooting |
| 构建指南 / Build Guide | [中文](./docs/zh/04_FW_Build_Guide.txt) | [English](./docs/en/04_FW_Build_Guide.txt) | 构建、部署、验证链、固件要点<br>Build, deploy, verification, firmware notes |
| 版本说明 / Release Notes | [中文](./docs/zh/05_Release_Notes.txt) | [English](./docs/en/05_Release_Notes.txt) | 版本历史<br>Version history |

## 快速上手 / Quick start

```bash
npm install
npm run build          # -> dist/index.html（自包含单文件 / self-contained single file）
```

1. 给板子烧 CircuitPython UF2，得到 CIRCUITPY 卷 / Flash a CircuitPython UF2 to get the CIRCUITPY volume.
2. `circup install asyncio`（固件的事件循环依赖它 / the firmware's event loop needs it）.
3. 把 `src/fw/code.py` 复制到 CIRCUITPY 根目录 / copy `src/fw/code.py` to the volume root.
4. 用 Chrome/Edge 打开 `dist/index.html`，点"连接设备" / open `dist/index.html`, click **Connect**.

细节见 [使用手册 §2](./docs/zh/01_GUIApp_FW_Manual/README.md#2-准备板子) / [User Manual §2](./docs/en/01_GUIApp_FW_Manual/README.md#2-prepare-the-board)。

## 目录结构 / Layout

```
src/fw/        CircuitPython 固件（部署到 CIRCUITPY 卷）/ firmware (deployed to CIRCUITPY)
src/ui/        界面源码（TS + CSS + HTML 模板）/ UI sources
docs/          双语文档 / bilingual documentation
tools/         PC 侧调试脚本（需 .venv）/ PC-side probe scripts
build.mjs      esbuild 打包 + 内联 / bundling and inlining
```

## 架构 / Architecture

固件单文件：`COMMANDS` 分发表按 cmd 路由到各功能驱动；`claim(n, who, force)` / `release(n)`
引脚所有权裁决是所有硬件操作的唯一入口，"一个脚同一时刻只属于一个功能"由固件保证，不靠界面自觉。
主循环是 asyncio 任务组（命令读取 + 输入边沿 + ADC 死区 + 波形流 + UART 收字节流），
命令与遥测各走一条通路。协议与调度的坑见 [02 协议参考](./docs/zh/02_Library_User_Guide/README.md) 与
[04 构建指南](./docs/zh/04_FW_Build_Guide.txt)。

The firmware is one file: a `COMMANDS` dispatch table routes each command to its driver, and the
`claim(n, who, force)` / `release(n)` ownership arbiter is the only entry point for hardware work, so
"one pin, one function" is guaranteed by the device rather than by UI discipline. The main loop is an
asyncio task group (command reader + input edges + ADC deadband + waveform stream + UART RX drain).
Protocol details and scheduler pitfalls: see [02 Protocol Reference](./docs/en/02_Library_User_Guide/README.md)
and [04 Build Guide](./docs/en/04_FW_Build_Guide.txt).

界面分层，依赖单向向下 / UI layers, dependencies point downward:

```
serial.ts             Session 门面：连接/握手/REPL/状态机 / connect, handshake, REPL, state machine
├─ core/transport.ts  字节管道：端口所有权、混流分帧（文本行 + 0xAA'W' 二进制帧）
├─ core/rpc.ts        JSON-lines 协议：请求/应答配对、事件分发、ready 等待
model/pins.ts         工作台唯一数据真源 / single source of truth for the workbench
workbench/            引擎 + FunctionDef 插件（digital / pwm / adc / i2c / uart / scope / uartterm）
                      新增功能 = 写一个 def(+driver) 并注册进 defs 数组
core/events.ts        极简 Emitter / minimal event emitter
```

## 开发环境 / Dev setup

```bash
uv venv -p 3.12 --seed -n .venv
. .venv/Scripts/activate && uv pip install pyserial
.venv/Scripts/python.exe tools/serial_probe.py COM3
```

仓库没有 tsconfig.json，类型检查要显式给参数，命令见 [04 构建指南](./docs/zh/04_FW_Build_Guide.txt)。
`npm run build` 走 esbuild，不做类型检查。

There is no tsconfig.json; the explicit type-check command is in
[04 Build Guide](./docs/en/04_FW_Build_Guide.txt). `npm run build` uses esbuild and does not type-check.

## 路线图 / Roadmap

已完成 / Done：Web Serial 握手闭环、IO 分配工作台（引脚池 + 泳道、拖拽绑定、自动顶位、即时下发）、
GPIO / PWM / ADC 泳道、ADC 批量波形流 + 示波器、片内温度虚拟通道、MQTT 式事件订阅、
二进制帧 kind 注册表、I2C 总线泳道（原始事务 + 合法序对探测）、UART 总线泳道 + 控制台实时终端标签、
调试控制台（监听 / REPL / 复制导出）、配置持久化（浏览器 localStorage）、中英双语界面。

Next：SPI 总线泳道（需支持 CS）、设备端 `config.json` 上电自恢复、独立错误面板。

SPI bus lane (must support CS), device-side `config.json` restore on boot, and a standalone error panel.
