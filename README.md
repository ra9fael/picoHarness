# PicoHarness

[![中文](https://img.shields.io/badge/Lang-中文-green.svg)](#中文) [![English](https://img.shields.io/badge/Lang-English-blue.svg)](#english)

一块跑 CircuitPython 的 Pico，一个 HTML 文件，浏览器直连 USB 串口。
Built on [PicoJig](../PicoJig-main). Documentation is available in **Chinese** and **English**; pick your language below.
本仓库文档提供**中文**与**英文**两版，请按语言跳转对应章节。

---

## 文档 / Documentation

| 文档 Document | 中文 | English | 内容 Contents |
| :--- | :---: | :---: | :--- |
| 使用手册 / User Manual | [中文](./docs/zh/01_GUIApp_FW_Manual/README.md) | [English](./docs/en/01_GUIApp_FW_Manual/README.md) | 装机、界面、逐功能用法<br>Setup, UI, feature-by-feature usage |
| 协议参考 / Protocol Reference | [中文](./docs/zh/02_Library_User_Guide/README.md) | [English](./docs/en/02_Library_User_Guide/README.md) | 命令、事件、二进制帧<br>Commands, events, binary frames |
| 使用示例 / Workflows | [中文](./docs/zh/03_Sample_Program_User_Guide/README.md) | [English](./docs/en/03_Sample_Program_User_Guide/README.md) | 动手 recipes 与故障排查表<br>Hands-on recipes and troubleshooting |
| 构建指南 / Build Guide | [中文](./docs/zh/04_FW_Build_Guide.txt) | [English](./docs/en/04_FW_Build_Guide.txt) | 构建、部署、验证链、固件要点<br>Build, deploy, verification, firmware notes |
| 版本说明 / Release Notes | [中文](./docs/zh/05_Release_Notes.txt) | [English](./docs/en/05_Release_Notes.txt) | 版本历史<br>Version history |

---

<a id="english"></a>
## English

### 1. Overview

A single-page browser test harness. The page talks to the board's USB CDC port through the
**Web Serial API**; the board runs one CircuitPython `code.py`, and the two speak JSON-lines.
Nothing is installed on the PC, and no server is started: the deliverable is one self-contained HTML file.

Verified on Raspberry Pi Pico 2 (rp2350a), CircuitPython 10.3.1, desktop Chrome / Edge.

### 2. Features

Digital input / output, PWM, ADC (including the on-die temperature as a virtual channel), raw I2C bus
transactions, UART with live terminal tabs (hex or text rendering), a scope panel for the ADC waveform
stream, and a debug console (raw serial monitor plus REPL passthrough). The UI is bilingual, flat, and
corner-free.

### 3. Quick start

```bash
npm install
npm run build          # -> dist/index.html (self-contained single file)
```

1. Flash a CircuitPython UF2 to get the CIRCUITPY volume.
2. `circup install asyncio` — the firmware's event loop needs it; CircuitPython does not ship one.
3. Copy `src/fw/code.py` to the root of the volume (remove any `main.py` there, it would win over `code.py`).
4. Open `dist/index.html` in Chrome or Edge and click **Connect**.

Full setup, including the board-side checks: [User Manual §2](./docs/en/01_GUIApp_FW_Manual/README.md#2-prepare-the-board).

### 4. Repository layout

```
src/fw/        CircuitPython firmware (deployed to the CIRCUITPY volume)
src/ui/        UI sources (TS + CSS + HTML templates)
docs/          bilingual documentation
tools/         PC-side probe scripts (needs .venv)
build.mjs      esbuild bundling and inlining
```

### 5. Architecture

The firmware is one file. A `COMMANDS` dispatch table routes each command to its driver, and the
`claim(n, who, force)` / `release(n)` ownership arbiter is the only entry point for hardware work, so
"one pin, one function at a time" is guaranteed by the device rather than by UI discipline. The main
loop is an asyncio task group: command reader, input-edge monitor, ADC deadband monitor, waveform
streamer, and UART RX drain. Commands and telemetry therefore never queue behind each other.

The UI is layered, and dependencies point one way, downward:

```
serial.ts             Session facade: connect, handshake, REPL, state machine
├─ core/transport.ts  Byte pipe: port ownership, mixed-stream framing (text lines + 0xAA'W' binary frames)
├─ core/rpc.ts        JSON-lines protocol: request/reply pairing, event dispatch, ready wait
model/pins.ts         Single source of truth for the workbench
workbench/            Engine + FunctionDef plugins (digital / pwm / adc / i2c / uart / scope / uartterm)
                      A new function = one def (+ driver) module registered in the defs array
core/events.ts        Minimal event emitter
```

Scheduler traps found on real hardware (blocking `stdin.read(1)`, `busio.UART` default timeout,
`flush=True` on USB CDC) are written up in
[04 Build Guide](./docs/en/04_FW_Build_Guide.txt); the wire format is in
[02 Protocol Reference](./docs/en/02_Library_User_Guide/README.md).

### 6. Development and verification

```bash
uv venv -p 3.12 --seed -n .venv
. .venv/Scripts/activate && uv pip install pyserial
.venv/Scripts/python.exe tools/serial_probe.py COM3
```

There is no `tsconfig.json` in this repository, so `npx tsc` alone fails; the explicit type-check
command, the build/deploy steps, and the full verification chain are in
[04 Build Guide](./docs/en/04_FW_Build_Guide.txt). `npm run build` uses esbuild and does not type-check.

### 7. Roadmap

Done: Web Serial handshake loop, IO-assignment workbench (pin pool + lanes, drag to bind, automatic
displacement, instant dispatch), GPIO / PWM / ADC lanes, batched ADC waveform stream plus scope,
on-die temperature virtual channel, MQTT-style event subscriptions, binary-frame kind registry,
I2C bus lane with raw transactions and legal-pair probing, UART bus lane with live console terminal
tabs, debug console (monitor / REPL / copy and export), browser-side configuration persistence,
bilingual UI.

Next: SPI bus lane (must support CS), device-side `config.json` restore on boot, standalone error panel.

---

<a id="中文"></a>
## 中文

### 1. 概述

单页浏览器治具。页面通过浏览器的 **Web Serial API** 直连板子的 USB CDC 串口，板子上跑一个 CircuitPython
`code.py`，两边用 JSON-lines 说话。PC 侧什么都不装，也不起服务，交付物就是一个自包含的 HTML 文件。

已验证环境：Raspberry Pi Pico 2（rp2350a）、CircuitPython 10.3.1、桌面版 Chrome / Edge。

### 2. 功能

数字输入 / 输出、PWM、ADC（含片内温度虚拟通道）、I2C 原始总线事务、UART（带实时终端标签，可切 HEX/文本）、
ADC 波形的示波器面板、调试控制台（原始串口监听 + REPL 直通）。界面中英双语、扁平化、无圆角。

### 3. 快速上手

```bash
npm install
npm run build          # -> dist/index.html（自包含单文件）
```

1. 给板子烧 CircuitPython UF2，得到 CIRCUITPY 卷。
2. `circup install asyncio`：固件的事件循环依赖它，CircuitPython 不内置。
3. 把 `src/fw/code.py` 复制到卷根目录（根目录若有 `main.py` 要删掉，它会顶掉 `code.py`）。
4. 用 Chrome / Edge 打开 `dist/index.html`，点"连接设备"。

完整装机与板子侧检查见 [使用手册 §2](./docs/zh/01_GUIApp_FW_Manual/README.md#2-准备板子)。

### 4. 目录结构

```
src/fw/        CircuitPython 固件（部署到 CIRCUITPY 卷）
src/ui/        界面源码（TS + CSS + HTML 模板）
docs/          双语文档
tools/         PC 侧调试脚本（需 .venv）
build.mjs      esbuild 打包 + 内联
```

### 5. 架构

固件是单文件：`COMMANDS` 分发表按 cmd 路由到各功能驱动；`claim(n, who, force)` / `release(n)`
引脚所有权裁决是所有硬件操作的唯一入口，"一个脚同一时刻只属于一个功能"由固件保证，不靠界面自觉。
主循环是 asyncio 任务组：命令读取、输入边沿、ADC 死区、波形流、UART 收字节流，命令与遥测互不排队。

界面分层，依赖单向向下：

```
serial.ts             Session 门面：连接 / 握手 / REPL / 状态机
├─ core/transport.ts  字节管道：端口所有权、混流分帧（文本行 + 0xAA'W' 二进制帧）
├─ core/rpc.ts        JSON-lines 协议：请求/应答配对、事件分发、ready 等待
model/pins.ts         工作台唯一数据真源
workbench/            引擎 + FunctionDef 插件（digital / pwm / adc / i2c / uart / scope / uartterm）
                      新增功能 = 写一个 def(+driver) 并注册进 defs 数组
core/events.ts        极简 Emitter
```

真机踩出来的调度坑（`stdin.read(1)` 会阻塞、`busio.UART` 默认读超时、USB CDC 上 `flush=True` 抛错）
写在 [04 构建指南](./docs/zh/04_FW_Build_Guide.txt)；线上格式见 [02 协议参考](./docs/zh/02_Library_User_Guide/README.md)。

### 6. 开发与验证

```bash
uv venv -p 3.12 --seed -n .venv
. .venv/Scripts/activate && uv pip install pyserial
.venv/Scripts/python.exe tools/serial_probe.py COM3
```

仓库没有 `tsconfig.json`，直接跑 `npx tsc` 会报 TS5058；显式类型检查命令、构建与部署步骤、完整验证链
都在 [04 构建指南](./docs/zh/04_FW_Build_Guide.txt)。`npm run build` 走 esbuild，不做类型检查。

### 7. 路线图

已完成：Web Serial 握手闭环、IO 分配工作台（引脚池 + 泳道、拖拽绑定、自动顶位、即时下发）、
GPIO / PWM / ADC 泳道、ADC 批量波形流 + 示波器、片内温度虚拟通道、MQTT 式事件订阅、
二进制帧 kind 注册表、I2C 总线泳道（原始事务 + 合法序对探测）、UART 总线泳道 + 控制台实时终端标签、
调试控制台（监听 / REPL / 复制导出）、配置持久化（浏览器 localStorage）、中英双语界面。

下一步：SPI 总线泳道（需支持 CS）、设备端 `config.json` 上电自恢复、独立错误面板。
