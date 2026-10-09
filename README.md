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
3. 用桌面版 Chrome/Edge 打开 `dist/index.html`，点"连接设备"，在串口选择器中选择板子。

## 协议

每行一条 JSON。请求 `{"id":1,"cmd":"ping","args":{...}}`；应答 `{"id":1,"ok":true,"data":{...}}`；设备事件 `{"evt":"..."}`。启动时设备发 `{"evt":"ready",...}` 握手行（含 `caps` 引脚能力表：固件启动时对每脚试建 `PWMOut`/`AnalogIn` 探测得出，UI 不硬编码硬件兼容性），UI 连接时先发 Ctrl+C/Ctrl+D 复位程序再等待 ready。已实现命令：`ping`、`echo`、`gpio.cfg {in,out,pd,pn}`（增量方向/上下拉配置，PWM 占用的脚自动跳过）、`gpio.out {mask,vals}`（按位改写输出）、`gpio.state`（返回 `{in,out,cfg_in,cfg_out,cfg_pd,cfg_pn,cfg_pwm,pwm}` 位图）、`pwm.cfg {pin,freq,duty}`（duty 0..1，重复调用即改参）、`pwm.stop {pin}`。掩码位 = `1<<GPn`；输入上下拉三态：`pd` 位=下拉、`pn` 位=无、默认上拉。注意 rp2 硬件 PWM 按 slice 共享频率，同 slice 两脚频率互相覆盖。**IO 分配工作台**：顶部引脚池 + 数字输入/数字输出/PWM 三条功能泳道，拖动 GP 芯片入泳道或"点芯片再点泳道"即绑定（修改即时下发，无暂存按钮）；同一引脚只属一个功能，跨泳道自动顶位；拖回池中或点 × 释放；PWM 泳道仅接受能力表内的脚。因 CircuitPython 无 select/非阻塞 stdin，输入电平由 UI 以 200ms 轮询 `gpio.state` 获取（非设备主动推送）。界面支持中/英双语（头部 EN/中文 按钮，localStorage 持久化）。

## 路线图

- [x] Spike：Web Serial + JSON lines 握手闭环
- [x] GPIO：逐引脚方向/上下拉/输出实时配置，state 轮询
- [x] IO 分配工作台 + PWM 简易信号源：引脚池 + 输入/输出/PWM 泳道，拖拽绑定，固件能力表
- [ ] I2C / SPI / UART 泳道（含 REPL 占用 USB 的取舍）
- [ ] config.json 持久化、错误面板
