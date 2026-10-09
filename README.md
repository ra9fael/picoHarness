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

每行一条 JSON。请求 `{"id":1,"cmd":"ping","args":{...}}`；应答 `{"id":1,"ok":true,"data":{...}}`；设备事件 `{"evt":"..."}`（已实现：`gpio_in {in}` 输入电平边沿推送，固件 asyncio `gpio_monitor` 任务 50ms 采样、仅变化时发出，且**仅在主机订阅了 `gpio.in` 主题时推送**；`adc {vals}` ADC 批次读数，`adc_monitor` 任务 100ms 采样、任一通道相对上次推送变化超死区（约 0.5%，可按订阅覆盖）时推全量；`adc_w {pins,ms,v}` 波形批量帧——`adc.stream` 开启时固件 `adc_streamer` 任务按 `ms` 间隔采样、攒满 `batch` 行发一帧，同时 `adc_monitor` 自动静音，把多通道的逐变化推送压成 ~1Hz 定长帧）。启动时设备发 `{"evt":"ready",...}` 握手行（含 `caps` 引脚能力表：固件启动时对每脚试建 `PWMOut`/`AnalogIn` 探测得出，UI 不硬编码硬件兼容性），UI 连接时先发 Ctrl+C/Ctrl+D 复位程序再等待 ready。已实现命令：`ping`、`echo`、`gpio.cfg {in,out,pd,pn}`（增量方向/上下拉配置，PWM 占用的脚自动跳过）、`gpio.out {mask,vals}`（按位改写输出）、`gpio.state`（返回 `{in,out,cfg_in,cfg_out,cfg_pd,cfg_pn,cfg_pwm,pwm}` 位图）、`pwm.cfg {pin,freq,duty}`（duty 0..1，重复调用即改参）、`pwm.stop {pin}`、`adc.cfg {pin}`（认领为 AnalogIn；`pin=100` 为**内部温度传感器**虚拟通道——本板 CP 10.3.1 不暴露 `board.TEMPERATURE_SENSOR`，固件改读 `microcontroller.cpu.temperature` 并按数据手册曲线反演成 raw16，走与 GP 通道完全相同的 u16 管线，`caps.adc` 含 100）、`adc.stop {pin}`、`adc.stream {on,pins,ms,batch,fmt}`（波形流开关，见 `adc_w`；`fmt` 取 `json`（默认）或 `bin`；`pins` 可含 100）、`sub {topic,params}` / `unsub {topic}`（**MQTT 式事件订阅**：主题未订阅则对应 monitor 静默；订阅即回发一条 retained 快照，主机无需等下一次变化。`gpio.in` 参数 `{mask,min_ms}`，`adc.<n>` 参数 `{deadband}`——ADC 无轮询兜底，故 `adc_monitor` 始终上报已配置通道，订阅只调死区灵敏度并触发 retained 快照）。掩码位 = `1<<GPn`；输入上下拉三态：`pd` 位=下拉、`pn` 位=无、默认上拉。注意 rp2 硬件 PWM 按 slice 共享频率，同 slice 两脚频率互相覆盖。**文本帧一律用紧凑分隔符**（`json.dumps(separators=(",",":"))`，去掉 `,`/`:` 后空格，同数据量约省 15% 字节）。**二进制波形帧**（`adc.stream fmt:"bin"`）：帧 = `0xAA 'W' + u16le(payload_len) + payload`，payload 首字节为 **kind**（`kind=1` = ADC 波形批次；固件与 UI 各持一张 kind→handler 注册表，新增遥测流只需注册新 kind 而不动分帧管线），kind=1 时 payload = `struct.pack("<BBHH", kind=1, nch, ms, nrows)` + `u16le[nch] pins` + `u16le[nrows*nch] samples`（行主序，一行一个采样时刻）；固件用 `usb_cdc.console.write()` 单次原子写出，与 `print` 走同一 CDC 端点保序。由于文本流是纯 ASCII JSON，绝不含 `0xAA`，UI 侧 transport 做**字节级混流解析**：扫描 `0xAA 'W'` 魔数，之前的字节走既有文本行分帧，帧不完整则暂存到后续 chunk 到达，二进制帧旁路 JSON rpc 层直达 scope（`emit("frame")`）。**IO 分配工作台**：顶部引脚池 + 数字输入/数字输出/PWM/ADC 四条功能泳道，拖动 GP 芯片入泳道或"点芯片再点泳道"即绑定（修改即时下发，无暂存按钮）；同一引脚只属一个功能（固件 `owner[]` 裁决表统一仲裁，claim/release），跨泳道自动顶位；拖回池中或点 × 释放；PWM 泳道仅接受能力表内的脚，频率 = 数值输入框 + 单位下拉（mHz/Hz/kHz/MHz）组合，输入框旁 ▾ 按钮弹出**全量数值预设网格**（1..1000，自定义下拉而非 datalist——浏览器 datalist 会按当前值过滤候选，输入 50 只剩 50/500；mHz/亚 1Hz 值会如实到达设备端报"频率不支持"——rp2 `PWMOut` 只收整数 Hz，物理下限约 7.4Hz；改频率时固件 deinit 重建 PWMOut，绕开 rp2 `Invalid variable_frequency` 缺陷）。**ADC 波形面板**：工作台下方可折叠 #scope 区，通道按钮列出 ADC 泳道已绑引脚（含 TEMP，≤4 路），**每通道颜色按 pin→slot 稳定映射持久分配**（开关其它通道不会重排仍可见通道的颜色），"开始采集"下发 `adc.stream`（25ms×25 行/帧），收到的 `adc_w`（JSON）或二进制帧（按 kind 分派）写入每通道环形缓冲，canvas 按 rAF 脏标记重绘。**采集模式**：Roll（定深 2048，连续滚动记录）/ FIFO（可配深度 256/512/1024/2048/4096，环形覆盖、老数据丢弃，视图铺满窗口）。**工具栏**：模式下拉 + 深度下拉（仅 FIFO 可用）、格式选择（JSON / struct 二进制，运行中切换即重启流）、横向/纵向自适应开关、十字线开关、Y 轴 V/raw 单位切换、每通道 `y = k·x + b` 校正编辑器（raw 域，绘制时应用；TEMP 通道据此把 raw 还原为 °C）。**交互**：滚轮水平缩放**锚定光标处采样点**（窗口 32..深度，关横向自适应）、Shift+滚轮垂直缩放锚定光标处电压、**拖拽平移**回看历史、双击复位为全适配；**十字标线**（可开关）跟随光标，左上读数框显示时刻（-Xs）、光标处电压与各通道当前值（按通道色标注）。坐标轴：Y 轴按当前单位标刻度，X 轴秒刻度（负值=距现在），信息行显示 `{sps} sps · 窗口 {秒}s`。**流开启期间芯片数值复用每帧最新行**（`adc_monitor` 此时静音，scope 把最新行回灌 model），芯片读数经 EMA（α=0.3）平滑 + 250ms 定时刷新 + tabular-nums 等宽字体，消除死区事件突发导致的数字抖动与泳道回流。通道选择/折叠/视图/校正/格式全部存 localStorage。工作台配置（绑定/上下拉/PWM 参数）持久化在浏览器 localStorage，重开页面自动恢复并随连接下发。输入电平实时性：事件驱动（`gpio_in` 边沿推送直达 UI）——绑定输入泳道后 `gpio.cfg` 会自动 `sub gpio.in`（携带当前输入掩码），释放/清空则 `unsub`；另有 1s `gpio.state` 对账轮询用于掉线/软复位后自愈（并顺带补发订阅）。ADC 泳道芯片：GP 通道 V/mV/raw 三态循环，**TEMP 通道则在 °C/raw 间切换**（°C 由 raw16 经数据手册曲线还原）。界面支持中/英双语（头部 EN/中文 按钮，localStorage 持久化）。

## 架构

固件（`src/fw/code.py`，单文件部署）：`COMMANDS` 分发表按 cmd 路由到各功能驱动（gpio / pwm / adc）；`claim(n, who, force)` / `release(n)` 引脚所有权裁决是所有硬件操作的唯一入口，新增功能只需注册命令 + 实现自己的 claim 语义。主循环为 asyncio 任务组（`command_reader` 读 stdin + `gpio_monitor` 边沿推送 + `adc_monitor` 死区推送 + `adc_streamer` 波形批量流），按官方 asyncio 指南的 blessed 模式：每个协程先 `create_task` 拿 Task 句柄、再 `await gather(t1, t2, t3, t4)`（该 mpy 端口的 `gather()` 只接受 Task 对象，传裸协程会触发 `sleep_ms` 的 "missing await" 断言）。⚠️ 真机二分排查（A–F 变体）实锤的第一课：`sys.stdin.read(1)` 会**阻塞直到至少一个字节到达**，绝非"无数据返回 None"的非阻塞惯用法——不加门控时 command_reader 第一步就冻结整个事件循环、所有兄弟 monitor 任务永远饿死（这正是 ADC 无读数的根因）；正确姿势是 `select.poll()` 注册 stdin 后用 `while _stdin_poll.poll(0):` 门控每次读取。另注意：USB CDC 上 `print(..., flush=True)` 每次写完后抛 `OSError [Errno 22]`（文本已出，勿显式 flush）；mpy asyncio 端口本身是队列轮转调度器，`create_task` 并发没有缺陷（早前"gather 按顺序 await 饿死子任务"的诊断已被真机证伪）。

UI（`src/ui/`）分三层，依赖单向向下：

```
serial.ts        Session 门面：connect/握手/REPL/状态机（console.ts、main.ts 只认这层）
├─ core/transport.ts  Layer1 字节管道：端口所有权、pump 自动重挂、字节级混流解析（文本行分帧 + `0xAA 'W'` 二进制帧）、waitForText
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
- [x] 固件 asyncio 调度修复（select.poll 门控 stdin）+ 4 任务 gather；ADC/GPIO 事件链路真机验证
- [x] ADC 波形批量流（adc.stream/adc_w）+ #scope 示波器面板：环形缓冲、rAF 脏标记重绘
- [x] scope 交互：滚轮水平/Shift+垂直缩放、双击复位、横纵自适应、Y 轴 V/raw、每通道 k·x+b 校正
- [x] ADC 芯片读数抗抖：EMA 平滑 + 250ms 定时刷新 + 等宽数字；流开启时复用 adc_w 最新行
- [x] 通信格式可选：adc_w 支持 JSON 或 struct 二进制帧（0xAA'W' 混流解析），紧凑分隔符省字节
- [x] scope 通道颜色按引脚稳定分配（pin→slot 持久映射，开关其它通道不再重排颜色）
- [x] ADC 内部温度通道：虚拟 pin 100（`microcontroller.cpu.temperature` 反演为 raw16，走同一 u16 管线），芯片直接显示 °C，可入波形
- [x] scope 光标锚定缩放 + 拖拽平移 + 可开关十字标线（读数框显示时刻/各通道值）
- [x] scope 双采集模式 Roll（定深 2048）/ FIFO（可配 256..4096，环形覆盖）
- [x] 二进制帧 kind 注册表（kind=1 adc_w，固件/UI 各建 kind→handler 表，可扩展新遥测流）
- [x] 事件订阅模式（MQTT 式 `sub`/`unsub {topic,params}` + retained 保留值）：`gpio.in` 严格订阅门控（mask/min_ms），`adc.<n>` 死区可调；UI 绑泳道自动 sub/unsub，1s 对账轮询兜底
- [ ] I2C / SPI / UART 泳道（含 REPL 占用 USB 的取舍）
- [ ] 设备端 config.json 开机自恢复（本轮只做了浏览器侧持久化）、错误面板
