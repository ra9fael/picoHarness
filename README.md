# PicoHarness

以 [PicoJig](../PicoJig-main) 为蓝本的 CircuitPython 版测试治具（test harness）：PC 侧交付物是单个 HTML 文件，通过浏览器 **Web Serial API** 直连 Pico 系的 USB CDC 串口（已验证 Pico 2 / rp2350a）；设备端运行 CircuitPython `code.py`，以 JSON-lines 协议接收命令、控制 GPIO 与 PWM，并内置 xterm.js 调试控制台（原始流监听 + REPL 直通）。

## 目录结构

```
src/fw/        CircuitPython 代码（部署到 CIRCUITPY 卷）
src/ui/        UI 源码（TS + CSS + HTML 模板）
tools/         PC 侧调试脚本（serial_probe.py，需 .venv）
build.mjs      esbuild 打包 + 内联，产出 dist/index.html
```

## 构建

```bash
npm install
npm run build   # -> dist/index.html（自包含单文件）

# Python 调试环境（工具脚本用）
uv venv -p 3.12 --seed -n .venv
. .venv/Scripts/activate && uv pip install pyserial
.venv/Scripts/python.exe tools/serial_probe.py COM3
```

## 使用

1. 用 [CircuitPython UF2](https://circuitpython.org/board/raspberry_pi_pico/)（Pico W 用 pico_w 版）烧写 Pico，得到 CIRCUITPY 卷。
2. 把 `src/fw/code.py` 复制到 CIRCUITPY 根目录。
3. **安装固件依赖**：CircuitPython 不内置 asyncio，`code.py` 的事件循环依赖第三方库（含 `adafruit_ticks`）。推荐用 circup：`pip install circup && circup install asyncio`（自动带依赖，版本随 CP 匹配）；手工装则从 Library Bundle 取 `asyncio`（对应 CP 大版本的 mpy 包）与 `adafruit_ticks` 放入 `CIRCUITPY/lib/`。缺库时 code.py 会报 `ImportError: no module named 'asyncio'`。
4. 用桌面版 Chrome/Edge 打开 `dist/index.html`，点"连接设备"，在串口选择器中选择板子。

## 协议

每行一条 JSON。请求 `{"id":1,"cmd":"ping","args":{...}}`；应答 `{"id":1,"ok":true,"data":{...}}`；设备事件 `{"evt":"..."}`（已实现：`gpio_in {in}` 输入电平边沿推送，固件 asyncio `gpio_monitor` 任务 50ms 采样、仅变化时发出；`adc {vals}` ADC 批次读数，`adc_monitor` 任务 100ms 采样、任一通道相对上次推送变化超死区（约 0.5%）时推全量）。启动时设备发 `{"evt":"ready",...}` 握手行（含 `caps` 引脚能力表：固件启动时对每脚试建 `PWMOut`/`AnalogIn` 探测得出，UI 不硬编码硬件兼容性），UI 连接时先发 Ctrl+C/Ctrl+D 复位程序再等待 ready。已实现命令：`ping`、`echo`、`gpio.cfg {in,out,pd,pn}`（增量方向/上下拉配置，PWM 占用的脚自动跳过）、`gpio.out {mask,vals}`（按位改写输出）、`gpio.state`（返回 `{in,out,cfg_in,cfg_out,cfg_pd,cfg_pn,cfg_pwm,pwm}` 位图）、`pwm.cfg {pin,freq,duty}`（duty 0..1，重复调用即改参）、`pwm.stop {pin}`、`adc.cfg {pin}`（认领为 AnalogIn）、`adc.stop {pin}`。掩码位 = `1<<GPn`；输入上下拉三态：`pd` 位=下拉、`pn` 位=无、默认上拉。注意 rp2 硬件 PWM 按 slice 共享频率，同 slice 两脚频率互相覆盖。**IO 分配工作台**：顶部引脚池 + 数字输入/数字输出/PWM/ADC 四条功能泳道，拖动 GP 芯片入泳道或"点芯片再点泳道"即绑定（修改即时下发，无暂存按钮）；同一引脚只属一个功能（固件 `owner[]` 裁决表统一仲裁，claim/release），跨泳道自动顶位；拖回池中或点 × 释放；PWM 泳道仅接受能力表内的脚，频率用"数值预设 × 单位预设（mHz/Hz/kHz/MHz）"组合输入（无绝对频率下拉；mHz/亚 1Hz 值会如实到达设备端报"频率不支持"——rp2 `PWMOut` 只收整数 Hz，物理下限约 7.4Hz；改频率时固件 deinit 重建 PWMOut，绕开 rp2 `Invalid variable_frequency` 缺陷）。工作台配置（绑定/上下拉/PWM 参数）持久化在浏览器 localStorage，重开页面自动恢复并随连接下发。输入电平实时性：事件驱动（`gpio_in` 边沿推送直达 UI），另有 1s `gpio.state` 对账轮询用于掉线/软复位后自愈。界面支持中/英双语（头部 EN/中文 按钮，localStorage 持久化）。

## 架构

固件（`src/fw/code.py`，单文件部署）：`COMMANDS` 分发表按 cmd 路由到各功能驱动（gpio / pwm / adc）；`claim(n, who, force)` / `release(n)` 引脚所有权裁决是所有硬件操作的唯一入口，新增功能只需注册命令 + 实现自己的 claim 语义。主循环为 asyncio 任务（`command_reader` 非阻塞读 stdin + `gpio_monitor` 边沿推送 + `adc_monitor` 死区推送）。⚠️ CircuitPython 的 mpy 版 asyncio 的 `gather()` 是**按顺序 await 子任务**的（不像 CPython 并发调度）——把永不结束的 `command_reader` 放第一位会让后面的 monitor 永远得不到运行；因此 monitor 用 `create_task` 直接挂上事件循环，只 `await command_reader()`。

UI（`src/ui/`）分三层，依赖单向向下：

```
serial.ts        Session 门面：connect/握手/REPL/状态机（console.ts、main.ts 只认这层）
├─ core/transport.ts  Layer1 字节管道：端口所有权、pump 自动重挂、行分帧、waitForText
├─ core/rpc.ts        Layer2 JSON-lines 协议：sendCmd/应答配对、事件分发、ready 等待
model/pins.ts    工作台唯一数据真源（roles/pulls/pwm/设备状态），"levels" 事件驱动定向刷 LED
workbench/       引擎 + FunctionDef 注册表（digital.ts / pwm.ts / adc.ts）：
                 泳道、拖拽规则、芯片视图、下发调度全部来自 def 插件；
                 新增 I2C/SPI/ADC = 写一个 def(+driver) 模块并注册进 defs 数组
core/events.ts   极简 Emitter，层间解耦
```

## 路线图

- [x] Spike：Web Serial + JSON lines 握手闭环
- [x] GPIO：逐引脚方向/上下拉/输出实时配置，state 轮询
- [x] IO 分配工作台 + PWM 简易信号源：引脚池 + 输入/输出/PWM 泳道，拖拽绑定，固件能力表
- [x] 架构重构：固件 dispatch+裁决表、asyncio 事件推送；UI 三层（Transport/Rpc/Session）+ FunctionDef 插件化工作台
- [x] PWM 频率预设下拉 + 数值/单位分离编辑；控制台日志复制/导出
- [x] 工作台配置持久化（浏览器 localStorage，静默恢复；连接后经 gpio.cfg/PWM 对账自动下发到设备）
- [x] ADC 读取泳道：adc.cfg/adc.stop + 固件 adc_monitor 死区事件推送，芯片电压/raw 一键切换
- [ ] I2C / SPI / UART 泳道（含 REPL 占用 USB 的取舍）
- [ ] 设备端 config.json 开机自恢复（本轮只做了浏览器侧持久化）、错误面板
