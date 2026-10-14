# PicoHarness 协议参考

这篇是速查手册，不是教程。想知道怎么用先看 [01 使用手册](../01_GUIApp_FW_Manual/README.md)。

固件版本 0.1.19-cfg 的全部对外接口。

---

## 1. 传输层

一条串口字节流，两种帧。这条流跑在 `usb_cdc.data` 口上（由 `boot.py` 的
`usb_cdc.enable(console=True, data=True)` 打开）；`console` 口归 CircuitPython 自己，
只出横幅、`print`、异常回溯和 REPL，不再有协议字节。板子上没有 `boot.py` 时
`usb_cdc.data` 为 `None`，协议回落到唯一那个 CDC 口，帧格式不变。

### 1.1 文本帧（JSON-lines）

每行一条 JSON，`\n` 结尾。设备侧一律用紧凑分隔符输出（`(",", ":")`，
即 `{"a":1,"b":2}` 而不是 `{"a": 1, "b": 2}`），同样的数据省约 15% 字节。

三种消息：

```jsonc
// 请求（主机 → 设备）
{"id": 12, "cmd": "gpio.out", "args": {"mask": 4, "vals": 4}}

// 应答（设备 → 主机），id 原样回带
{"id": 12, "ok": true, "data": { ... }}
{"id": 12, "ok": false, "error": "RuntimeError: pin GP7 busy"}

// 事件（设备 → 主机，无 id，随时可发）
{"evt": "gpio_in", "in": 128}
```

`error` 一律是 `异常类名: 消息` 的字符串，主机侧不需要解析类型，直接显示即可。

### 1.2 二进制帧

只有波形流用。帧结构：

```
0xAA  'W'  <u16le 长度>  <payload>
```

payload 第一个字节是 **kind**，标识这是哪种流：

| kind | 含义 | payload |
| --- | --- | --- |
| 1 | ADC 波形批次 | `struct.pack("<BBHH", 1, nch, ms, nrows)` + `u16le[nch]` 引脚号 + `u16le[nrows*nch]` 采样值（行主序，一行=一个采样时刻） |

设备端用 `usb_cdc.data.write()` 一次性原子写出整帧，和文本帧走同一个端口，
所以两种帧天然保序，不会交错。没有 `boot.py` 时回落到单口：整帧写 `usb_cdc.console`，
与 `print` 共用同一个 CDC 端点，保序性不变。

主机侧做**字节级混流解析**：扫 `0xAA 'W'` 魔数，魔数之前的字节照常按文本行分帧，
之后按长度取整帧。文本 JSON 是纯 ASCII，永远不含 `0xAA`，所以魔数不会被误认。
帧没收全就暂存，等下一个 chunk 继续。二进制帧旁路 JSON 层，直接交给按 kind 注册的处理器。

**加一种新流**：固件和设备两侧各维护一张 `kind → 处理函数` 表，注册新 kind 即可，
分帧管线不用动。

---

## 2. 握手

设备启动时主动发一条事件：

```json
{"evt":"ready","app":"PicoHarness","version":"0.1.19-cfg",
 "cp":[10,3,1],"pins":29,"gp":[0,1,2,...,22,26,27,28],
 "caps":{"pwm":[...],"pwm_pio":{"pins":[...],"max_sm":12,"tick_cycles":1,
                                            "fixed_cycles":8,"counters":65535,
                                            "clk_min":2288,"clk_max":150000000},
         "adc":[...],"i2c_pairs":[[scl,sda],...],
         "uart":{"tx":[...],"rx":[...],"pairs":[[tx,rx],...]},
         "spi":{"groups":[{"sck":[...],"mosi":[...],"miso":[...]},...],
                "max_buses":2,"max_cs":4,"baud_ceiling":75000000},
         "cfg":{"path":"/config.json","max_bytes":65536},
         "usb":{"data":true}}}
```

| 字段 | 含义 |
| --- | --- |
| `version` | 固件版本。界面报错时先核对这个 |
| `cp` | CircuitPython 版本三元组 |
| `pins` | 最大可寻址脚号 + 1（数组维度用），**不是**引脚个数 |
| `gp` | 本板**能取到的**脚号数组（从 `board` 声明的 Pin 对象算出，号码读自声明名，只有 ADC 别名的按 `ADC_BASE+通道` 补号）；可能有洞，界面芯片池以此为准 |
| `caps.pwm` | 能做 PWM 的脚号数组 |
| `caps.pwm_pio` | PIO 那台 PWM 发生器的能力表：`pins` 是能挂 PIO 状态机的脚号数组，`max_sm` 是整块芯片的状态机预算，剩下五个数（`tick_cycles`、`fixed_cycles`、`counters`、`clk_min`、`clk_max`）定出频率窗口。**这台固件没有 PIO 发生器时整个字段是 `null`**（比如 `lib/adafruit_pioasm.mpy` 没装），主机就不显示 HW / PIO 选择 |
| `caps.adc` | 能做 ADC 的脚号数组，含虚拟通道 `100`（内部温度） |
| `caps.i2c_pairs` | **有序对**数组，每对是 `[SCL, SDA]` |
| `caps.uart` | `tx` 数组、`rx` 数组、`pairs` 有序对数组（`[TX, RX]`） |
| `caps.spi` | `groups` 每组的 `sck/mosi/miso` 脚号数组，外加 `max_buses`、`max_cs`、`baud_ceiling` |
| `caps.cfg` | 设备端配置保险箱：`path` 是它在卷上的文件名，`max_bytes` 是单次能写进去的上限，`writable` 说代码到底能不能写这块卷（取 `storage.getmount("/").readonly` 的反值；没放 `boot.py` 的板子是 `false`，不带这个字段的旧固件按"能写"处理，因为主机这边无法自己判断）。**这台固件没有 `cfg.*` 命令时整个字段缺席**，界面就不显示"保存到板子"那一组按钮（与 `pwm_pio` 缺席时不显示 HW / PIO 选择是同一条规则） |
| `caps.usb.data` | 协议是否跑在独立的 data 口上（`boot.py` 生效即为 true） |

### 2.0 脚号从哪来：封装 × 板级定义

有两层东西限制"这块板上有哪些脚"，界面只画穿过这两层的脚：

1. **芯片封装**。pico-sdk `src/rp2350/hardware_regs/include/hardware/platform_defs.h`
   里 `NUM_BANK0_GPIOS` 是 RP2350A（QFN-60）= 30（GP0..GP29）、RP2350B（QFN-80）= 48（GP0..GP47）。
   同一文件把 ADC 写成 `ADC_BASE_PIN=26 / NUM_ADC_CHANNELS=5` 与 `40 / 9`，
   即 **RP2350A 的 ADC0..ADC3 = GP26..GP29，RP2350B 的 ADC 脚 = GP40..GP47**。
   CircuitPython `common-hal/analogio/AnalogIn.c` 就是按这个窗口判定的，超出即 `Invalid pin`。
2. **板级定义**。CircuitPython 只把板子 `pins.c` 里**声明过**的脚交给你，而 `Pin` 对象
   身上没有号码可读，号码只能从声明名里解析。rp2350 这几块板的声明名有三种形状：
   `board.GP13`（普通 GPIO）、`board.GP26_A0`（同一个脚，同时是 ADC 通道 0）、
   `board.A3`（ADC 通道 3，**名字里根本没有 GP**）。所以只有 ADC 别名的脚按
   `ADC_BASE + 通道号` 编号，`ADC_BASE` 就是 `A0` 背后那个脚的号码——每块 rp2 板都把
   `A0` 写成了带 GP 的名字（这里是 `board.GP26_A0`，QFN-80 上是 `GP40_A0`），
   于是这条规则是从设备上算出来的，不需要按板子写死。真机上的结果：`dir(board)` 里
   找不到 `GP29` 这个属性，但可寻址集合是 GP0..GP29，因为 GP29 就是 `A3` /
   `VOLTAGE_MONITOR`，而且上板实测它样样能干：ADC3 读到 VSYS/3（raw 31815 → 1.600 V
   → VSYS ≈ 4.80 V）、`PWMOut` 建得起来、`DigitalInOut` 能输出、
   `busio.I2C(SCL=GP29, SDA=GP28)` 被接受、`busio.UART(TX=GP28, RX=GP29)` 建得起来。
   表仍然有洞、仍然比封装窄：`raspberry_pi_pico2_w/pins.c` 不声明 GP23/GP24/GP25
   （在这块板上它们是 `SMPS_MODE` / `LED` / `VBUS_SENSE`，既没有 GP 也没有 ADC 通道号，
   所以取不到），两块树莓派板的表都不声明 GP30..GP47。

固件开机时扫 `board` 得出这个集合（`gp`），之后所有能力表都是它的子集：取不到的脚
不会出现在池里，也不会被任何 `caps` 数组给出。**换句话说，"Pico 2 W 有没有 GP30..GP47"
这类问题的答案是：芯片有（RP2350B 封装），你的 CircuitPython 板级定义没声明，
治具就取不到；哪天你用的构建声明了它，池子里会自动多出来，固件里没有任何写死的脚数。**

洞在协议上的表现：范围检查用的是"最大脚号 + 1"这条连续的界（`0..NUM_PINS-1`），
所以一个落在界内、但板级定义没声明的脚会通过范围检查，随后在 `_pin()` 那里报
`ValueError: board has no GP23` 这样的错误；`gpio.cfg` 的掩码是逐脚展开的，遇到洞直接跳过、
不报错。界面按 `caps.gp` 渲染，压根不会把这些脚端给你，所以正常操作碰不到这两条。

`caps` 里 PWM / ADC / I2C 对是**探测出来的**（逐脚试建对象、按规则枚举有序对再试建），
UART 是**按文档规则现算**的：偶发 TX、奇发 RX、实例号 `((n+4)//8) % NUM_UARTS`，
这三条都是 CircuitPython `common-hal/busio/UART.c` 自己的算法，固件只是把它跑一遍；
SPI 见下面。探测和计算只在开机时做一次并缓存，`hello` 复用的就是这份缓存。
`caps.pwm_pio.pins` 不在这几条之列：PIO 矩阵覆盖 RP2350 每一个 GPIO，所以它直接取可寻址脚号集合。
那五个窗口参数也一次都不探测，固件把已知事实原样上报——`counters`/`max_sm` 是芯片参数，
`fixed_cycles` 由这段指令的形状数出来，`clk_min`/`clk_max` 是在这块板子上实测到的 SM 时钟边界。

**SPI 是唯一的静态表**：`SPI_GROUPS` 的 GP0..GP28 行是 `tools/spi_probe.py` 在
CircuitPython 10.3.1 / Pico 2 上逐组合实测（53 个被接受、1571 个报 `Invalid pins`），
实测结果与 pico-sdk `hardware/gpio.h` 的 F1 列**逐行一致**；GP30..GP47 行取自同一张表
（QFN-80 专属行），在 30 脚的板子上取不到、也就不会被送到界面上——固件发 `caps.spi` 前
会把这张表投影到 `gp` 上。开机不做 SPI 扫描：穷举要 1600 多次构造调用、耗时按分钟算，
而这个答案是芯片的属性，不是接线的属性，扫了也不会变。

主机连接时的动作：两个 CDC 口共用同一 VID/PID，`getInfo()` 区分不了，所以给每个已授权端口
**并行**发 `ping`，回带 nonce 的那个才是协议口（零点击）；第一个正答复一到就开始连接，
不陪沉默的端口耗到超时。角色结论缓存 4 秒，同一次连接里再问同一批端口（比如紧接着挂日志口）
不会重探，所以重连不必再等一轮超时。对上后发 `hello` 取上面这份载荷，不必重启设备；
旧固件不应答 `hello` 时，取载荷也走下面这条重启路径。
已授权的端口全都不应答时（`code.py` 没在跑：停在 REPL 或崩了），回落到老路径：
在**探测期间真有过设备输出的那个端口**上发 `Ctrl+C`、`Ctrl+D` 把板子复位到运行 `code.py`
的状态——data 口不吃控制字节，所以候选按谁有动静来排——然后等 `ready` 行。
踢过之后"这个口不是协议口"的结论已经不作数了，所以清掉缓存再问一遍，中途不会再弹端口选择框。
设备程序在链路建立之后自己重启时（按 RESET、或从资源管理器保存 `code.py`），会再广播一条
`ready`，界面把它当作"设备已重启"提示并刷新能力表。

### 2.1 关于 I2C / UART / SPI 的合法性

这几类功能的引脚**不是任意组合都行**，而且合法性是"对"的属性，不是"单脚"的属性：

- **I2C（rp2 走硬件外设，不是 PIO）**：`common-hal/busio/I2C.c` 只认 Synopsys DW_apb_i2c
  两路硬件 I2C（`NUM_I2CS = 2`），判定条件就是它源码里那一行：
  `scl % 2 == 1 && sda % 2 == 0 && (scl / 2) % 2 == (sda / 2) % 2`——SCL 奇数脚、
  SDA 偶数脚、两者落在同一路外设（等价于 `SDA ≡ SCL-1 (mod 4)`，但**不要求相邻**：
  GP1/GP0、GP1/GP4、GP1/GP8 都是合法对）。不满足就直接 `Invalid pins`，没有 PIO/位模拟兜底。
  所以 GP8/GP10（都是偶数）永远配不成总线。频率上限 1 MHz（同一份源码里 validate 的）。
  这条规则也覆盖 GP29：实测 `busio.I2C(SCL=GP29, SDA=GP28)` 是被接受的（接着报的是没上拉，
  那是接线条件不是引脚限制），`caps.i2c_pairs` 因此带着 SCL=29 的 8 个序对。
- **UART（rp2 硬件外设，非 PIO）**：只有 UART0 / UART1 两路。规则在
  `common-hal/busio/UART.c`：**每个偶数脚都能做 TX，每个奇数脚都能做 RX**，
  具体用哪个功能由引脚号决定——`n % 4 == 0`（TX）或 `n % 4 == 1`（RX）用 F2
  `GPIO_FUNC_UART`，`n % 4 == 2`（TX）或 `n % 4 == 3`（RX）用 F11 `GPIO_FUNC_UART_AUX`
  （RP2350 才有这第二组复用）。实例号取 `((n + 4) / 8) % NUM_UARTS`，全双工时两端必须一致——
  上板实测：`busio.UART(TX=GP28, RX=GP29)` 建得起来，`busio.UART(TX=GP28, RX=GP27)` 报
  `Invalid pins`，因为 28 落在 UART0、27 落在 UART1。单看每个脚都没问题，`caps.uart.tx` /
  `caps.uart.rx` 列的就是单脚能力，只有 `caps.uart.pairs` 才套用实例这条。
  **GP0(TX) / GP1(RX) 属于 UART0**：单口那会儿实测被 CircuitPython 串口控制台占用，
  这版双口固件上实测可以正常建总线，所以它们和其它脚一样出现在 `caps.uart` 里。
- **SPI（rp2 硬件外设）**：`caps.spi.groups` 给出两组脚，**SCK/MOSI/MISO 必须全在同一组内**，
  跨组时 `busio.SPI()` 直接报 `Invalid pins`。两组也正好对应两路外设（`NUM_SPIS = 2`），
  所以同时最多 `caps.spi.max_buses` 路总线（实测第三路报 `SPI peripheral in use`）。
  SCK 是必须的，只给 SCK 不给数据脚时报 `Must provide MISO or MOSI pin`，
  缺 MOSI 或缺 MISO 的半总线则能建起来。完整两组（RP2350 全脚号）是：

  | 外设 | SCK | MOSI(TX) | MISO(RX) |
  | --- | --- | --- | --- |
  | SPI0 | 2, 6, 18, 22, 34, 38 | 3, 7, 19, 23, 35, 39 | 0, 4, 16, 20, 32, 36 |
  | SPI1 | 10, 14, 26, 30, 42, 46 | 11, 15, 27, 31, 43, 47 | 8, 12, 24, 28, 40, 44 |

  30..47 是 QFN-80 专属行，30 脚的板子上不会出现（`caps.spi.groups` 已按 `gp` 投影）。
  **CS 不在这张表里**：这个端口的 `busio.SPI` 不管片选，固件用普通输出脚拉低/拉高，
  所以任何空闲 GP 都能当 CS，上限 `caps.spi.max_cs` 路。

主机侧的判定规则：

| 功能 | 一个脚算配齐吗 | 何时查配对 |
| --- | --- | --- |
| I2C | 不算，SDA 和 SCL 都要填 | 两个都填了才查 `i2cPairOk` |
| UART | **算**，只发或只听是合理用法 | 两个都填了才查 `uartPairOk` |
| SPI | **半算**：SCK 必须有，MOSI/MISO 有一个就够 | 每次填数据脚都查 `spiSetOk`（同组） |

---

## 3. 命令总表

28 条。除 `ping` / `echo` 外，成功的应答 `data` 通常就是第 4 节那份 state 对象。

### 3.1 通用

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `ping` | 无（原样回带 `t`） | `{"pong": <t>}` |
| `hello` | 无 | `data` = 开机 `ready` 的那份载荷（app/version/cp/pins/gp/caps），供后接入的主机免重启取能力 |
| `echo` | 任意 | 原样回带 args，用于自检 |
| `reset` | 无 | 先回 `{"reset": "pending"}`，约 0.25 秒后复位设备。存在的理由：`boot.py` 只在硬复位时跑，改完 `boot.py` 不必再走到板前按 RESET |

### 3.2 GPIO

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `gpio.cfg` | `in` `out` `pd` `pn`（均为位掩码） | 增量配置方向和上下拉。被 PWM/ADC/I2C/UART 占用的脚自动跳过，不会抢 |
| `gpio.out` | `mask` `vals` | 按位改写输出：`mask` 指定动哪些脚，`vals` 给这些脚的值 |
| `gpio.state` | 无 | 返回完整 state 对象，主机用于对账 |

掩码位 = `1 << 脚号`。上下拉三态：`pd` 位=下拉，`pn` 位=无，两者都为 0=上拉（默认）。

### 3.3 PWM

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `pwm.cfg` | `pin`, `freq`(默认 1000), `duty`(默认 0.5), `backend`(默认 `"hw"`) | 启动或改参。`duty` 取 0..1；`backend` 是 `"hw"`（硬件 slice）或 `"pio"`（状态机）。`hw` 的 `freq` 单位 Hz、只接受整数值，低于 1 直接报错 `freq < 1 Hz: PWMOut takes whole hertz`；`pio` 的 `freq` 可以是小数，窗口由 `caps.pwm_pio` 那五个数算出来，越界报 `... below PIO floor ...` / `freq above PIO ceiling ...` |
| `pwm.stop` | `pin` | 停掉并释放该脚，两种发生器一起拆（PIO 那路会把状态机还回预算） |

改频率时固件会 `deinit` 后重建对象——rp2 上直接写 `.frequency` 会抛
`Invalid variable_frequency`，这是绕开硬件库缺陷的做法。
`backend` 与现状不同也一律重建：一个 pad 只能挂一种发生器，而正在跑的状态机还在照它那条
4 深的 TX FIFO 出货，直接写新计数要等五个周期才见效。

`hw` 这路的分频器做不到你想要的每一个整数频率：它只能跑 125 MHz/(div×(top+1))，
实测下限 9 Hz（1..8 Hz 全部落到 9），高频也会量化（1000→990、2000→2035）。
所以回包里 `pwm.<脚>.hfreq` 给的是**当前发生器真实跑出来的频率**，`freq` 仍是你请求的值，
界面据此把频率框标成琥珀色并写一条日志。

同一 slice 的两个脚（如 GP24/GP25 = slice 4，按 `(n // 2) mod 8` 算）不能各自设频率：第二个 `pwm.cfg`
直接失败并回 `RuntimeError: Conflicting settings for shared resource`，
固件此时会退还该脚的所有权，不会留下半占用的引脚。详见 [01 手册](../01_GUIApp_FW_Manual/README.md#44-pwm)。

### 3.4 ADC

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `adc.cfg` | `pin` | 认领为 AnalogIn。`pin=100` 是内部温度虚拟通道 |
| `adc.stop` | `pin` | 停止并释放 |
| `adc.stream` | `on`, `pins[]`, `ms`(≥10, 默认 50), `batch`(1..100, 默认 20), `fmt`(`json`\|`bin`) | 开关波形流。`on:false` 关闭。`pins` 可含 100 |

`adc.stream` 开启期间，死区事件推送（`adc`）自动静音，改由 `adc_w` 批量帧供给，
避免两条路同时刷。

**温度通道**：本 CircuitPython build 不暴露 `board.TEMPERATURE_SENSOR`，固件读
`microcontroller.cpu.temperature`（°C 浮点），再按数据手册曲线反演成等效 raw16：

```
v = 0.706 - (t - 27) * 0.001721
raw = v / 3.3 * 65535
```

这样温度完全复用既有的 u16 管线（事件、流、二进制帧、波形缓冲都不用改数据形状），
摄氏度由主机侧用每通道 `k·x+b` 校正还原。分辨率约 0.03°C/LSB。

### 3.5 I2C

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `i2c.cfg` | `id`, `sda`, `scl`, `freq`(默认 100000) | 建总线。参数与现状完全相同则直接返回不重建 |
| `i2c.release` | `id` | 释放总线与其两个引脚 |
| `i2c.scan` | `id` | `{"addrs": [地址...]}` |
| `i2c.xfer` | `id`, `addr`(0..127), `w`(字节数组), `r`(读字节数 0..4096), `rep_start`(bool) | 原始事务 |

`i2c.xfer` 的三种形态：

| `w` | `r` | `rep_start` | 总线动作 |
| --- | --- | --- | --- |
| 有 | 0 | — | `writeto` |
| 0 | 有 | — | `readfrom` |
| 有 | 有 | true | `writeto_then_readfrom`（写寄存器指针后重复起始再读） |

返回 `{"rd": [字节...]}`，没读就是空数组。

建总线时如果两线空闲没被拉高，报 `No pull up found`——这是**接线或上拉电阻问题**，
不是引脚选错，界面会照样提示。

### 3.6 UART

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `uart.cfg` | `id`, `tx`(-1 表示不接), `rx`(-1 同上), `baud`(默认 115200) | 建总线。`tx` `rx` 全为 -1 报错 |
| `uart.release` | `id` | 释放 |
| `uart.write` | `id`, `data`(字节数组) | 返回 `{"written": n}` |
| `uart.read` | `id`, `n`(0..4096) | 返回 `{"rd": [字节...]}` |

总线对象以 **非阻塞**方式创建（`timeout=0`），所以 `uart.read` 是"读到啥算啥"，
不会干等。内部为手动读取临时设 200ms 有界等待，读完立即恢复非阻塞——
否则会拖住事件流任务。

`tx` 为 -1 时 `uart.write` 报 `this bus has no TX pin`；`rx` 为 -1 时 `uart.read` 同理。

### 3.7 SPI

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `spi.cfg` | `id`, `sck`, `mosi`(-1 表示不接), `miso`(-1 同上), `cs`(引脚数组，最多 `caps.spi.max_cs` 路), `baud`(默认 100000), `mode`(默认 0，CPOL/CPHA) | 建总线。参数与现状完全相同则直接返回不重建 |
| `spi.release` | `id` | 释放总线与其全部成员（含每路 CS） |
| `spi.xfer` | `id`, `w`(字节数组), `r`(读字节数 0..4096), `cs`(片选下标，-1 表示全程不拉低任何 CS), `hold`(bool，事务结束保持拉低) | 全双工原始事务 |

`spi.cfg` 的校验顺序，报错就按这个顺序来：

| 顺序 | 报错原文 | 触发条件 |
| --- | --- | --- |
| 1 | `busio.SPI on rp2 needs at least a MOSI or a MISO pin` | `mosi` 和 `miso` 都是 -1（SCK 单独一条线跑不起来） |
| 2 | `mode must be 0..3 (CPOL/CPHA)` | `mode` 越界 |
| 3 | `at most %d CS lines per bus` | `cs` 数量超过 `SPI_MAX_CS` |
| 4 | `pin out of range` | 任一引脚号不在 0..`NUM_PINS-1`（`NUM_PINS` = 最大可命名脚号 + 1，见 2.0） |
| 5 | `one pin cannot hold two SPI roles` | 同一个脚出现在 SCK/MOSI/MISO/CS 里两次 |
| 6 | `SPI GP%d(SCK)/GP%d(MOSI)/GP%d(MISO) is not a routable set: ...` | 三个数据脚不在同一引脚组 |
| 7 | `GP%d already belongs to SPI bus %d — release it first` | 该脚已被另一条在跑的 SPI 总线占用 |
| 8 | `could not build SPI on GP%d/GP%d/GP%d: ...` | 底层 `busio.SPI` 构造失败，典型内层消息是 `SPI peripheral in use` |
| 9 | `SPI GP%d configure failed: ...` | 拿锁后 `configure()` 失败 |

第 7 条不能交给 `claim()` 去做：两条总线的 `owner[]` 都写 `"spi"`，
`claim` 会静默成功，随后构造才失败，而回滚会把**另一条总线还在驱动的脚**解除声明。

`spi.xfer` 的返回：

```json
{"rd": [字节...], "cs": 片选下标, "held": 是否保持拉低, "hbaud": 实际时钟, "mode": 模式}
```

`w` 与 `r` 可以只给一个，也可以同时给（写 N 字节同时读 N 字节）。`cs` 是**下标**不是引脚号：
`0` 用 `cs` 数组的第一个脚，`-1` 表示所有 CS 保持高电平（纯时钟抓取）。
`hold: true` 用来做分片事务——片选不抬，下一次 `spi.xfer` 接着同一次选中往下传，
记得事后再发一次 `hold: false` 把它放回来。

这个口的全双工只有 `write_readinto()` 一个调用，而且要求两个等长缓冲区，
所以固件把短的 `w` 用 `0xFF` 空闲时钟补齐，读回来只截前 `r` 个字节：

```python
n = max(len(w), rlen)          # 时钟数取两者较大
tx = bytearray(b"\xff" * n); tx[:len(w)] = w
obj.write_readinto(tx, rx); rd = rx[:rlen]
```

`hbaud` 是**分频器实际跑出来的时钟**，不是你请求的那个。rp2 把 150 MHz 系统时钟除以
**偶数**整数，上限 75 MHz（`caps.spi.baud_ceiling`），所以 9600 实际是 9599 Hz、
2 MHz 实际是 1973684 Hz、10 MHz 实际是 9375000 Hz。和 PWM 的 `hfreq` 同一个诚实口径。

### 3.8 事件订阅

MQTT 风格的开关，用来控制设备主动推什么。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `sub` | `topic`(字符串), `params`(可选对象) | 订阅。**立即回发一条 retained 快照**，主机不必等下一次变化 |
| `unsub` | `topic` | 退订，返回 `{"unsub": topic}` |

| 主题 | 参数 | 门控的是 |
| --- | --- | --- |
| `gpio.in` | `mask`, `min_ms` | 输入电平事件。**严格门控**：没订阅就完全不推 |
| `adc.<脚号>` | `deadband` | 该通道 ADC 事件的死区灵敏度 |
| `uart.<总线号>` | 无 | 该总线的 RX 字节流 |

注意 ADC 的不对称设计：ADC **没有**轮询兜底，所以 `adc_monitor` 始终上报所有已配置通道，
订阅只用来调死区和触发 retained 快照，不是开关。GPIO 则严格门控，因为 1s 的
`gpio.state` 对账轮询本来就会刷新输入状态。

### 3.9 设备端配置

把界面上那份配置存进板子的卷里。这三条是例外：应答 `data` 不是 state 对象。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `cfg.get` | 无 | `{"text": "<快照 JSON 或 null>", "path": ..., "bytes": n}`；`bytes` 只在文件存在时带上。文件不存在时 `text` 是 `null`，不是错误 |
| `cfg.save` | `text`(字符串) | 写入。返回 `{"bytes": n, "path": ...}` |
| `cfg.clear` | 无 | 删除。返回 `{"removed": true\|false, "path": ...}`，没有文件也算成功 |

固件是**保险箱，不是读者**：它只检查送来的字符串是一段合法 JSON、并且顶层有 `pins`
数组，然后原样存下，绝不解析字段，也**不在上电时按它给引脚编程**。所以快照的格式只有
一个主人（前端的 `src/ui/model/store.ts`），导出的文件、浏览器里那份、板子里这第三份
是同一串字节；固件升级不会因为"看不懂"而丢掉用户的东西。

报错原文：

| 命令 | 报错 | 触发条件 |
| --- | --- | --- |
| `cfg.save` | `need args.text` | 没带 `text`，或带的不是字符串 |
| `cfg.save` | `config is not JSON` | 字符串解析不出 JSON |
| `cfg.save` | `not a PicoHarness snapshot` | 解析出来是 JSON，但不是带 `pins` 数组的对象——大概率是手工编辑时改坏了 |
| `cfg.save` | `config too large: N bytes` | 超过 `caps.cfg.max_bytes` |
| `cfg.save` | `wrote N bytes, volume holds M` | 改名之后卷上的字节数和刚写的对不上 |
| `cfg.get` | `/config.json is N bytes, over the 65536 limit` | 卷上那份大得反常——先报，不去读它 |
| `cfg.save` | `OSError: [Errno 30] Read-only filesystem` | 板上的 `boot.py` 还是不带 `storage.remount(...)` 的旧版，或拷进去了但没硬复位——卷对代码仍是只读的 |
| `cfg.clear` | `/config.json is on a read-only volume; delete it from the host` | 同上一条。只读卷上 `os.remove()` 和"文件本来就不在"撞成同一种 `OSError`，不先拦下来的话应答会说"没有文件"，而文件其实还好好地在卷上 |

写入走 `config.json.tmp` → 删除旧文件 → 改名，读完字节数再核对一遍，然后 `os.sync()`：
掉电或主机拔线时，卷上要么是完整的旧配置，要么是完整的新配置，不会留下半份。
`cfg.get` 在读之前先看大小，超过 `max_bytes` 直接报错，不会为了一份坏文件把内存吃光。

这三条有一个前提在 `boot.py` 里：`storage.remount("/", readonly=False,
disable_concurrent_write_protection=True)`。CircuitPython 默认把卷对**代码**挂成只读，
没有这一行 `cfg.save` 一律 `Errno 30`。代价是 Windows 看 G: 用的是缓存，只有卷被重新读一次
（复位、拔插、弹出）才追上板子写下的东西——实测连续覆盖两次、再等 20 秒，Explorer 里还是最早
那一份，甚至板子已经删掉了它还显示着。所以"存到板子了没有"要用界面上的**载入**去问板子，别用
资源管理器去看文件；要在 G: 上拖文件部署，先按一次 RESET 让两份视图对齐。

这个前提只能在 `boot.py` 里成立，代码里没有自我更正的余地：10.3.1 上从 `code.py` 调
`storage.remount()` 直接 `RuntimeError: Cannot remount path when visible via USB`。所以固件把
结论如实报进 `caps.cfg.writable`（读的是 `storage.getmount("/").readonly`，注意这个属性名，
没有 `.writable`、也没有 `.mount_point`），主机据此收起**保存到板子 / 删除板子配置**这两个必然
失败的按钮；要换状态，就改 `boot.py` 再硬复位——界面上的**重启板子**就是这条命令的入口。

---

## 4. state 对象

`gpio.state` 的返回，也是多数命令 `data` 的内容。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `in` | 位掩码 | 当前输入电平（只看配成输入的脚） |
| `out` | 位掩码 | 当前输出锁存值 |
| `cfg_in` | 位掩码 | 配成输入的脚 |
| `cfg_out` | 位掩码 | 配成输出的脚 |
| `cfg_pd` | 位掩码 | 启用下拉的输入脚 |
| `cfg_pn` | 位掩码 | 设为无拉制的输入脚 |
| `cfg_pwm` | 位掩码 | 被 PWM 占用的脚 |
| `cfg_pio_pwm` | 位掩码 | 这些脚里由 PIO 状态机驱动的那些（`cfg_pwm` 的子集） |
| `pio_sm_free` | 整数 | 还剩几个空闲状态机；预算是**整块芯片**的，不是按脚算的 |
| `pwm` | 对象 | `{"<脚号>": {"freq": f, "hfreq": h, "duty": d, "be": "hw"|"pio"}}`，`be` 是当前发生器，`hfreq` 是它实际跑出来的频率（硬件 slice 只能落到整数赫兹，PIO 由 SM 时钟/周期数决定） |
| `cfg_adc` | 位掩码 | 被 ADC 占用的**物理**脚（不含虚拟温度通道） |
| `adc_temp` | 布尔 | 温度通道是否启用 |
| `cfg_i2c` | 位掩码 | 被 I2C 占用的脚 |
| `i2c` | 数组 | `[{"id":i,"sda":n,"scl":n,"freq":h}, ...]` |
| `cfg_uart` | 位掩码 | 被 UART 占用的脚 |
| `uart` | 数组 | `[{"id":i,"tx":n,"rx":m,"baud":h}, ...]`（未接的一侧为 -1） |
| `cfg_spi` | 位掩码 | 被 SPI 占用的脚，**每路 CS 也算** |
| `spi` | 数组 | `[{"id":i,"sck":n,"mosi":n,"miso":n,"cs":[n,...],"baud":h,"hbaud":h,"mode":m}, ...]`（未接的一侧为 -1） |

主机拿这份 state 和自己的期望值比，发现漂移就重发配置。这就是"板子被重启过也能自愈"的机制。
总线数组（`i2c` / `uart` / `spi`）参与漂移比对，格式是 `id:成员,成员,...` 排序拼接的签名；
SPI 的签名里带 `cs` 顺序、`baud` 与 `mode`，所以片选少一路也会被判成漂移。
`hbaud` 是分频器实际跑出来的时钟，请求值放在 `baud`，两者可以不同。
PWM 的漂移比对是两半一起看：`cfg_pwm` 说哪些脚在跑，`cfg_pio_pwm` 说其中哪几路归 PIO。
只有前一个数对得上、发生器却悄悄换成了硬件 slice，也算漂移，会重新下发 `pwm.cfg`（带 `backend`）。

---

## 5. 事件一览

| 事件 | 载荷 | 触发条件 |
| --- | --- | --- |
| `ready` | 见第 2 节 | 设备启动 |
| `gpio_in` | `{"in": 掩码}` | 已订阅 `gpio.in` 且电平变化 |
| `adc` | `{"vals": {"脚号": raw}}` | 任一已配置通道相对上次推送超死区（默认约 0.5%，可按订阅覆盖） |
| `adc_w` | `{"pins":[], "ms":n, "v":[[..]]}` 或二进制帧 | 波形流开启，攒满 `batch` 行发一帧 |
| `uart_rx` | `{"id": 总线号, "data": [字节...]}` | 已订阅该总线且收到字节 |
| `dbg` | `{"task":名, "alive":true}` 或 `{"task":名,"err":"..."}` | 任务存活上报 / 任务内部异常 |

`dbg` 是调试用的。它的存在有个具体原因：`gather` 会吞掉子任务的异常，
某个 monitor 协程死了表面上毫无征兆，所以每个任务首次进入循环时报一次 `alive`，
捕获到异常时报 `err`。排查"某个功能突然不动了"先看有没有 `dbg` 事件。

设备启动时还会发一行终端标题转义序列（OSC，`ESC ] 0 ; ... ESC \`），
粘在 `ready` 前面且不带换行。解析时要先剥离 ANSI 再取 JSON——
主机侧的做法是找第一个 `{` 然后从那里开始解析。

---

## 6. 引脚所有权

所有硬件操作都经过一张 `owner[]` 表裁决：

- `claim(脚, 功能, force)` — 占用。`force=true` 可以抢走别人的脚（PWM/ADC/总线配置用这个）。
- `release(脚)` — 释放。
- 每个功能释放自己总线/通道时，只清 `owner[脚] == 自己` 的项，不会误释放别人的。

所以"一个脚只属于一个功能"是固件保证的，不靠界面自觉。页面刷新、两个窗口同时开，
都不会出现两边都以为脚是自己的情况。

三条总线的功能名分别是 `"i2c"`、`"uart"`、`"spi"`。SPI 把 SCK、MOSI、MISO 和**每一路 CS**
都登记在同一个 `owner="spi"` 下，因为 `busio.SPI` 没有逐脚释放的接口——
释放任意一个成员就是把整条总线拆掉（`spi.release` 也只认总线号）。
CS 被算成"已占用"是有实际理由的：它是一根普通输出线，
如果界面允许对它做 `gpio.set`，主机就能在事务中间把某器件选中或松开。

---

## 7. 版本与兼容

`version` 字段是判断设备快慢的第一依据。

界面报 `unknown cmd: xxx`，或者 `gpio.state` 的应答里缺 `cfg_uart` / `uart` 这类字段，
几乎总是**板子上跑的还是旧 `code.py`**，不是上位机的问题。
先核对 `version`，必要时重新复制 `code.py`。

老固件没有 `caps.i2c_pairs` / `caps.uart` / `caps.spi` 时，主机的引脚校验会宽松放行——
反正设备才是最终裁决者，配不上会明确报错。SPI 尤其如此：没有 `caps.spi.groups`
时任何引脚组合都摆得进去，是 `spi.cfg` 那条 routable set 报错来收尾的；
片数上限和时钟上限也退成默认的 4 路 CS / 2 条总线，界面不再过滤高频预设。

`caps.pwm_pio` 缺失走的是另一条路：不是"宽松放行"，而是"整个功能收起来"。收不到这份能力表
就等于板子没有 PIO 发生器，界面不显示 HW|PIO 切换条；
配置里如果存着 PIO 通道，会被降级回硬件切片并夹进硬件窗口（1–30,000,000 Hz），
免得把板子不支持的请求发下去。发出去的 `pwm.cfg` 仍带 `backend:"hw"`，
老固件不认这个参数也只是忽略它。窗口本身由这张表算出，两端都是精确除法，
所以换固件不用改上位机的数字。

`caps.cfg` 走的是 `pwm_pio` 那条路，不是"宽松放行"：收不到就没有"保存到板子 / 从板子载入 /
删除板子配置"这三行菜单，界面也不会发 `cfg.*`。老的 `code.py` 因此不会收到它答不上来的命令，
用户看到的是"这几项没有"，不是一行 `unknown cmd`。
