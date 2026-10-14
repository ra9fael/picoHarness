// Browser-only Web Serial mock, injected by evaluate_script so the UI can be
// smoke-tested without owning a physical port. Simulates a dual-CDC board:
// one port answers the protocol ping, the other only emits device chatter.
//
//   window.__mock.requestPortCalls  // how many times the picker was opened
//   window.__mock.dev("text")       // push bytes from the console port
//
(function () {
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  // Caps for one believable device: a Pico 2 W on CircuitPython, i.e. exactly the
  // GPIOs its official board table names (ports/raspberrypi/boards/
  // raspberry_pi_pico2_w/pins.c: GP0..GP22 and GP26..GP28 -- GP23/24/25 are not in
  // that table, they are the CYW43 SMPS_MODE/LED/VBUS_SENSE pins, and GP29 reaches
  // Python only as A3/VOLTAGE_MONITOR). The holes are the point of this mock: the
  // pool, the badges and every legality predicate have to work on a pin set that is
  // not 0..N.
  // The tables are GENERATED with the same rules the firmware uses (see code.py
  // probe_uart / probe_i2c_pairs and pico-sdk hardware/gpio.h), so the mock can
  // never drift into asserting a stale hand-copied list.
  var GPS = [];
  for (var g = 0; g <= 22; g++) GPS.push(g);
  for (g = 26; g <= 29; g++) GPS.push(g);
  // GP29 has no "GP29" attribute on this board, but code.py still numbers it: a
  // pin whose only names are ADC aliases (A3/VOLTAGE_MONITOR) is addressed as
  // ADC_BASE + channel, and A0 carries the GP token that gives the base. The
  // holes at GP23/24/25 stay holes because SMPS_MODE/LED/VBUS_SENSE expose
  // neither a GP name nor an A-channel. The holes are the point of this mock:
  // the pool, the badges and every legality predicate have to work on a pin set
  // that is not 0..N.
  var has = function (n) { return GPS.indexOf(n) >= 0; };
  // The RP2350A ADC window from pico-sdk platform_defs.h (ADC_BASE_PIN=26,
  // NUM_ADC_CHANNELS=5) intersected with what this board names; +100 is the
  // virtual on-die temperature channel.
  var ADC = [];
  for (var a = 26; a <= 29; a++) if (has(a)) ADC.push(a);
  ADC.push(100);
  var inst = function (n) { return ((n + 4) / 8 | 0) % 2; }; // CP UART.c
  var UART_TX = GPS.filter(function (n) { return n % 2 === 0; });
  var UART_RX = GPS.filter(function (n) { return n % 2 === 1; });
  var UART_PAIRS = [];
  UART_TX.forEach(function (t) {
    UART_RX.forEach(function (r) { if (inst(t) === inst(r)) UART_PAIRS.push([t, r]); });
  });
  var I2C_PAIRS = [];
  GPS.forEach(function (scl) {
    if (scl % 2 !== 1) return; // CP I2C.c: SCL odd, SDA even, one and the same peripheral
    GPS.forEach(function (sda) {
      if (sda % 2 === 0 && ((scl / 2 | 0) % 2) === ((sda / 2 | 0) % 2)) I2C_PAIRS.push([scl, sda]);
    });
  });
  // The two SPI peripherals, from the F1 column of the same table (no CSn rows:
  // busio.SPI takes no CS pin), projected onto this board's GPIOs the way the
  // firmware's caps.spi does.
  var SPI_FULL = [
    { sck: [2, 6, 18, 22, 34, 38], mosi: [3, 7, 19, 23, 35, 39], miso: [0, 4, 16, 20, 32, 36] },
    { sck: [10, 14, 26, 30, 42, 46], mosi: [11, 15, 27, 31, 43, 47], miso: [8, 12, 24, 28, 40, 44] },
  ];
  var SPI_GROUPS = SPI_FULL.map(function (grp) {
    var out = {};
    Object.keys(grp).forEach(function (role) {
      out[role] = grp[role].filter(has);
    });
    return out;
  });
  var CAPS = {
    gp: GPS,
    pins: GPS[GPS.length - 1] + 1, // highest named GPIO + 1, as code.py reports it
    pwm: GPS.slice(), // every RP2350 GPIO carries a PWM channel (F4 column)
    adc: ADC,
    i2c_pairs: I2C_PAIRS,
    uart: { tx: UART_TX, rx: UART_RX, pairs: UART_PAIRS },
    usb: { data: true },
    // Mirrors the firmware's caps.spi — the two rp2350 SPI pin groups measured by
    // tools/spi_probe.py, one CS budget, and the 75 MHz divider ceiling.
    spi: {
      groups: SPI_GROUPS,
      max_buses: 2,
      max_cs: 4,
      baud_ceiling: 75000000,
    },
    // Mirrors the firmware's pio_caps() (tools/pio_bg_probe.py measured these on-board):
    // every RP2350 GPIO has a PIO matrix, 12 state machines per chip, and the window
    // below is what clk_min/clk_max over the counter limits work out to.
    pwm_pio: {
      pins: GPS.slice(),
      max_sm: 12,
      tick_cycles: 1,
      fixed_cycles: 8,
      counters: 65535,
      clk_min: 2288,
      clk_max: 150000000,
    },
    // The device-side config vault (firmware cfg.get/cfg.save/cfg.clear). The mock
    // keeps it in a variable: same refusal of non-snapshot text, same reply fields,
    // and it survives a program restart the way the real file survives a reboot.
    // window.__MOCK_READONLY = a board whose boot.py never remounted the volume:
    // writable is false and both write paths answer the way Errno 30 does.
    cfg: { path: "/config.json", max_bytes: 65536, writable: !window.__MOCK_READONLY },
  };

  // The group a requested data-pin set belongs to, or null when it spans two (the
  // port then answers "Invalid pins"). Absent members (-1) do not participate.
  function SPI_GROUP(sck, mosi, miso) {
    for (var i = 0; i < CAPS.spi.groups.length; i++) {
      var g = CAPS.spi.groups[i];
      var ok = g.sck.indexOf(sck) >= 0;
      if (mosi >= 0) ok = ok && g.mosi.indexOf(mosi) >= 0;
      if (miso >= 0) ok = ok && g.miso.indexOf(miso) >= 0;
      if (ok) return g;
    }
    return null;
  }

  function spiRealHz(baud) {
    var SYS = 150000000;
    if (baud >= 75000000) return 75000000;
    for (var div = 2; div <= 2 * SYS; div += 2) {
      if (SYS / div <= baud) return Math.floor(SYS / div);
    }
    return baud;
  }

  // `1 << 32` wraps in JavaScript, so a mask wider than 31 slots is built with plain
  // arithmetic -- the same reason the UI's setBit() exists.
  function setBit(mask, n) {
    return mask + 2 ** n;
  }

  // A mask is up to 48 bits wide, past what JavaScript's bitwise operators keep, so
  // every read and write here is plain arithmetic -- the same rule the UI's setBit()
  // and the firmware's shifts follow. `| 0` would truncate a GP32.. GP47 mask.
  function bitOn(mask, n) {
    return Math.floor(mask / 2 ** n) % 2 === 1;
  }

  function putBit(mask, n, on) {
    return bitOn(mask, n) === on ? mask : on ? setBit(mask, n) : mask - 2 ** n;
  }

  function pioMask(p) {
    var mask = 0;
    Object.keys(p.pw).forEach(function (k) {
      if (p.pw[k].be === "pio") mask = setBit(mask, Number(k));
    });
    return mask;
  }

  // read_state()'s PWM half, which the firmware sends with every pwm.* reply: cfg_pwm is
  // the live channels and cfg_pio_pwm the subset the PIO generator owns. The UI reads both
  // as "what the board is actually running", so omitting cfg_pwm would make a working
  // slice look dead and the HW|PIO pick would never settle.
  function pwmState(p) {
    var cfg = 0;
    Object.keys(p.pw).forEach(function (k) {
      cfg = setBit(cfg, Number(k));
    });
    return {
      cfg_pwm: cfg,
      cfg_pio_pwm: pioMask(p),
      pio_sm_free: CAPS.pwm_pio.max_sm - p.pioSm,
      pwm: p.pw,
    };
  }

  // read_state() in full. The host diffs this every second, so any lane the mock
  // leaves out is a lane it will re-drive forever with a command it does not
  // answer. GPIO carries real state now (owner[] plus the output levels); ADC/I2C
  // and UART are reported empty because this mock has never implemented them, and
  // SPI is derived from p.spi exactly as the firmware derives it from spi_bus --
  // CS lines included, since a GPIO write to a line acting as CS would select a
  // device.
  function gpioState(p) {
    var d = pwmState(p);
    d.in = 0; // no way for a smoke test to drive a pin
    d.out = p.gpio.vals;
    d.cfg_in = p.gpio.in;
    d.cfg_out = p.gpio.out;
    d.cfg_pd = p.gpio.pd;
    d.cfg_pn = p.gpio.pn;
    d.cfg_adc = 0;
    d.adc_temp = 0;
    d.cfg_i2c = 0;
    d.i2c = [];
    d.cfg_uart = 0;
    d.uart = [];
    var ids = Object.keys(p.spi).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    var mask = 0;
    var list = [];
    ids.forEach(function (k) {
      var b = p.spi[k];
      [b.sck, b.mosi, b.miso].concat(b.cs).forEach(function (n) {
        if (n >= 0) mask = setBit(mask, n);
      });
      list.push(b);
    });
    d.cfg_spi = mask;
    d.spi = list;
    return d;
  }

  // Pins a driver other than GPIO already holds, so gpio.cfg can skip them instead of
  // stealing them -- the firmware's owner[] rule, which is what makes the workbench's
  // "stop the PWM first" ordering matter.
  function takenMask(p) {
    var mask = 0;
    Object.keys(p.pw).forEach(function (k) {
      mask = setBit(mask, Number(k));
    });
    Object.keys(p.spi).forEach(function (k) {
      var b = p.spi[k];
      [b.sck, b.mosi, b.miso].concat(b.cs).forEach(function (n) {
        if (n >= 0) mask = setBit(mask, n);
      });
    });
    return mask;
  }

  function pioSolve(freq, duty) {
    var C = CAPS.pwm_pio;
    var d = Math.max(Math.min(duty, 1), 0.0001);
    if (d > 0.5) d = 1 - d; // the counters are symmetric: the wider phase sets the budget
    var counts = Math.min(2 * C.counters, Math.floor(C.clk_max / freq) - C.fixed_cycles);
    if (counts < 2)
      return { error: "freq above PIO ceiling " + Math.floor(C.clk_max / (C.fixed_cycles + 2)) + " Hz" };
    counts = Math.min(counts, Math.floor(C.counters / d));
    var total = counts + C.fixed_cycles;
    var clock = Math.floor(freq * total);
    if (clock < C.clk_min)
      return {
        error: "clock " + clock + " Hz below PIO floor " + C.clk_min + " Hz: " + freq +
          " Hz at duty " + duty + " is out of PIO range",
      };
    return { hfreq: clock / total };
  }

  function makePort(name, isProtocol) {
    var p = {
      name: name,
      protocol: isProtocol,
      pending: [],
      ctrl: null,
      rx: "",
      pw: {}, // slot -> {freq, hfreq, duty, be}, mirroring firmware read_state().pwm
      pioSm: 0, // state machines in use, the same budget the firmware counts
      spi: {}, // bus id -> {sck, mosi, miso, cs, baud, hbaud, mode}, ditto read_state().spi
      cfgText: null, // the stored config.json contents, ditto the cfg.* vault on the board
      gpio: { in: 0, out: 0, pd: 0, pn: 0, vals: 0 }, // owner[] for "gpio": masks + output values
      getInfo: function () {
        return { usbVendorId: 0x2e8a, usbProductId: 0x000b };
      },
      open: function () {
        p.rx = "";
        return new Promise(function (res) {
          p.readable = new ReadableStream({
            start: function (c) {
              p.ctrl = c;
              p.pending.forEach(function (b) {
                c.enqueue(b);
              });
              p.pending = [];
            },
          });
          p.writable = new WritableStream({
            write: function (chunk) {
              p.onWrite(chunk);
            },
          });
          setTimeout(res, 0);
        });
      },
      close: function () {
        p.ctrl = null;
        p.readable = null;
        p.writable = null;
        return Promise.resolve();
      },
      push: function (bytes) {
        if (p.ctrl) p.ctrl.enqueue(bytes);
        else p.pending.push(bytes);
      },
      send: function (obj) {
        p.push(enc.encode(JSON.stringify(obj) + "\n"));
      },
      onWrite: function (chunk) {
        p.rx += dec.decode(chunk, { stream: true });
        var i;
        while ((i = p.rx.indexOf("\n")) >= 0) {
          var line = p.rx.slice(0, i).replace(/\r/g, "").trim();
          p.rx = p.rx.slice(i + 1);
          if (line && p.protocol) p.reply(line);
        }
      },
      reply: function (line) {
        var m;
        try {
          m = JSON.parse(line.slice(line.indexOf("{")));
        } catch (e) {
          return;
        }
        if (!m || !m.cmd) return;
        if (m.cmd === "ping") return p.send({ id: m.id, ok: true, data: { pong: m.args.t } });
        if (m.cmd === "hello")
          return p.send({ id: m.id, ok: true, data: { version: "0.1.19-mock", caps: CAPS } });
        if (m.cmd === "echo")
          return p.send({ id: m.id, ok: true, data: { msg: m.args.msg } });
        if (m.cmd === "reset") {
          // The firmware answers first and resets about a quarter second later, because
          // boot.py only runs on a hardware reset. A mock cannot make its port vanish, so
          // only the observable half is simulated: the reply, then the same ready
          // broadcast a power-on sends. Nothing in the UI issues reset yet; this handler
          // exists so an offline harness never answers "unknown cmd".
          p.send({ id: m.id, ok: true, data: { reset: "pending" } });
          if (p.protocol)
            setTimeout(function () {
              p.push(enc.encode(JSON.stringify({ evt: "ready", app: "PicoHarness", version: "0.1.19-mock", pins: CAPS.gp.length, cp: [10, 3, 1], caps: CAPS }) + "\n"));
            }, 400);
          return;
        }
        // The config vault, mirroring the firmware's cfg.* handlers: the text is
        // stored as given, only checked for being a snapshot, and never read.
        if (m.cmd === "cfg.get")
          return p.send({
            id: m.id,
            ok: true,
            data:
              p.cfgText === null
                ? { text: null, path: CAPS.cfg.path }
                : { text: p.cfgText, path: CAPS.cfg.path, bytes: p.cfgText.length },
          });
        if (m.cmd === "cfg.save") {
          if (!CAPS.cfg.writable)
            return p.send({ id: m.id, ok: false, error: "OSError: [Errno 30] Read-only filesystem" });
          var txt = m.args && m.args.text;
          if (typeof txt !== "string")
            return p.send({ id: m.id, ok: false, error: "need args.text" });
          if (txt.length > CAPS.cfg.max_bytes)
            return p.send({ id: m.id, ok: false, error: "config too large: " + txt.length + " bytes" });
          var snap = null;
          try {
            snap = JSON.parse(txt);
          } catch (e) {
            return p.send({ id: m.id, ok: false, error: "config is not JSON" });
          }
          if (!snap || !Array.isArray(snap.pins))
            return p.send({ id: m.id, ok: false, error: "not a PicoHarness snapshot" });
          p.cfgText = txt;
          return p.send({ id: m.id, ok: true, data: { bytes: txt.length, path: CAPS.cfg.path } });
        }
        if (m.cmd === "cfg.clear") {
          if (!CAPS.cfg.writable)
            return p.send({ id: m.id, ok: false, error: "/config.json is on a read-only volume; delete it from the host" });
          var had = p.cfgText !== null;
          p.cfgText = null;
          return p.send({ id: m.id, ok: true, data: { removed: had, path: CAPS.cfg.path } });
        }
        if (m.cmd === "gpio.state") {
          return p.send({ id: m.id, ok: true, data: gpioState(p) });
        }
        // gpio.cfg replaces the whole input/output/pull mask set at once, and a pin
        // another driver owns is skipped rather than stolen — the firmware's owner[]
        // rule, which is what makes the workbench's "stop the PWM first" ordering
        // matter. Without this handler every drift poll answered "unknown cmd" and
        // the workbench logged a failure per pin per second.
        if (m.cmd === "gpio.cfg") {
          var c = m.args || {};
          var inM = Number(c.in) || 0;
          var outM = Number(c.out) || 0;
          var pdM = Number(c.pd) || 0;
          var pnM = Number(c.pn) || 0;
          var next = { in: 0, out: 0, pd: 0, pn: 0, vals: p.gpio.vals };
          var taken = takenMask(p);
          for (var g = 0; g < GPS.length; g++) {
            var n = GPS[g];
            if (bitOn(taken, n)) continue; // owned elsewhere: not ours to reconfigure
            var want = bitOn(outM, n) ? "out" : bitOn(inM, n) ? "in" : null;
            if (want === "out") next.out = setBit(next.out, n);
            else if (want === "in") {
              next.in = setBit(next.in, n);
              if (bitOn(pdM, n)) next.pd = setBit(next.pd, n);
              else if (bitOn(pnM, n)) next.pn = setBit(next.pn, n);
            }
            if (want !== "out") next.vals = putBit(next.vals, n, false);
          }
          p.gpio = next;
          return p.send({ id: m.id, ok: true, data: gpioState(p) });
        }
        if (m.cmd === "gpio.out") {
          var mask = Number(m.args.mask) || 0;
          var vals = Number(m.args.vals) || 0;
          for (var g2 = 0; g2 < GPS.length; g2++)
            if (bitOn(mask, GPS[g2]))
              p.gpio.vals = putBit(p.gpio.vals, GPS[g2], bitOn(vals, GPS[g2]));
          return p.send({ id: m.id, ok: true, data: gpioState(p) });
        }
        // rp2 SPI: pins must come from one group, a bare SCK is refused, and the
        // clock is 150 MHz divided by an even integer (so requests above 75 MHz
        // and odd intermediate values land elsewhere — hbaud tells the truth).
        if (m.cmd === "spi.cfg") {
          var a = m.args;
          var g = SPI_GROUP(a.sck, a.mosi, a.miso);
          if (!(a.sck >= 0 && (a.mosi >= 0 || a.miso >= 0)))
            return p.send({ id: m.id, ok: false, error: "SCK plus MOSI or MISO is required" });
          if (!g) return p.send({ id: m.id, ok: false, error: "Invalid pins" });
          if (a.cs && a.cs.length > CAPS.spi.max_cs)
            return p.send({ id: m.id, ok: false, error: "too many CS lines" });
          var taken = Object.keys(p.spi).filter(function (k) {
            return Number(k) !== Number(a.id);
          });
          var clash = null;
          taken.forEach(function (k) {
            var b = p.spi[k];
            [b.sck, b.mosi, b.miso].concat(b.cs).forEach(function (n) {
              if (n >= 0 && [a.sck, a.mosi, a.miso].concat(a.cs || []).indexOf(n) >= 0) clash = b;
            });
          });
          if (clash)
            return p.send({
              id: m.id,
              ok: false,
              error: "GP" + clash.sck + " already belongs to SPI bus " + clash.id + " — release it first",
            });
          if (taken.length >= CAPS.spi.max_buses)
            return p.send({ id: m.id, ok: false, error: "SPI peripheral in use" });
          p.spi[String(a.id)] = {
            id: a.id,
            sck: a.sck,
            mosi: typeof a.mosi === "number" ? a.mosi : -1,
            miso: typeof a.miso === "number" ? a.miso : -1,
            cs: (a.cs || []).slice(),
            baud: a.baud,
            hbaud: spiRealHz(a.baud),
            mode: a.mode | 0,
          };
          return p.send({ id: m.id, ok: true, data: { spi: p.spi[String(a.id)] } });
        }
        if (m.cmd === "spi.xfer") {
          var bus = p.spi[String(m.args.id)];
          if (!bus) return p.send({ id: m.id, ok: false, error: "unknown SPI bus" });
          var rd = [];
          for (var i = 0; i < (m.args.r || 0); i++) rd.push((i * 17 + 3) & 0xff);
          return p.send({
            id: m.id,
            ok: true,
            data: { rd: rd, cs: m.args.cs, held: !!m.args.hold, hbaud: bus.hbaud, mode: bus.mode },
          });
        }
        if (m.cmd === "spi.release") {
          var gone = p.spi[String(m.args.id)];
          if (gone) delete p.spi[String(m.args.id)];
          return p.send({ id: m.id, ok: true, data: { released: !!gone } });
        }
        // The two generators the firmware ships: the rp2 slice takes whole hertz only and
        // cannot go below 9 Hz (measured on GP25/GP2/GP12/GP0, CircuitPython 10.3.1), and
        // the PIO countdown reaches hundredths of a hertz at the price of one state
        // machine. hfreq is always what the pin really generates, never the request.
        if (m.cmd === "pwm.cfg") {
          var be = m.args.backend || "hw";
          var slot = String(m.args.pin);
          var prev = p.pw[slot];
          // owner[] says "pwm" straight through a switch, but one pad cannot hold two
          // generators: the old one is torn down before the new one is armed.
          if (prev && prev.be === "pio") p.pioSm--;
          delete p.pw[slot];
          if (be === "pio") {
            if (p.pioSm >= CAPS.pwm_pio.max_sm)
              return p.send({
                id: m.id,
                ok: false,
                error: "no free PIO state machine (" + p.pioSm + "/" + CAPS.pwm_pio.max_sm + " in use)",
              });
            var sol = pioSolve(m.args.freq, m.args.duty);
            if (sol.error) return p.send({ id: m.id, ok: false, error: sol.error });
            p.pioSm++;
            p.pw[slot] = { freq: m.args.freq, hfreq: sol.hfreq, duty: m.args.duty, be: "pio" };
          } else {
            if (m.args.freq < 1)
              return p.send({ id: m.id, ok: false, error: "freq < 1 Hz: PWMOut takes whole hertz" });
            var req = Math.floor(m.args.freq);
            p.pw[slot] = { freq: req, hfreq: req < 9 ? 9 : req, duty: m.args.duty, be: "hw" };
          }
          return p.send({ id: m.id, ok: true, data: pwmState(p) });
        }
        if (m.cmd === "pwm.stop") {
          var gone2 = p.pw[String(m.args.pin)];
          if (gone2 && gone2.be === "pio") p.pioSm--;
          delete p.pw[String(m.args.pin)];
          return p.send({ id: m.id, ok: true, data: pwmState(p) });
        }
        p.send({ id: m.id, ok: false, error: "unknown cmd: " + m.cmd });
      },
    };
    return p;
  }

  var data = makePort("data", true);
  var cons = makePort("console", false);
  // What a CircuitPython console really has queued when a host opens it: the
  // boot banner and a prompt. It also gives the UI something to rank by when it
  // has to choose which silent port to kick (see byChatter).
  cons.push(enc.encode("Adafruit CircuitPython 10.3.1 on 2026-10-01; Raspberry Pi Pico 2 with RP2350\n>>> "));
  // window.__MOCK_STOPPED = code.py is not running: no port answers a ping until
  // the host sends Ctrl+D on the console port, exactly like the real board.
  if (window.__MOCK_STOPPED) {
    data.stopped = true;
    var origWrite = cons.onWrite;
    cons.onWrite = function (chunk) {
      var s = dec.decode(chunk);
      if (s.indexOf("\x04") >= 0) data.stopped = false;
      origWrite.call(cons, chunk);
    };
    var origReply = data.reply;
    data.reply = function (line) {
      if (data.stopped) return;
      origReply.call(data, line);
    };
  }
  // window.__MOCK_SINGLE = a board without boot.py: one port carries everything,
  // so the UI must keep mirroring the protocol port.
  var single = !!window.__MOCK_SINGLE;
  CAPS.usb.data = !single;
  var granted = single || window.__MOCK_HIDE_CONSOLE ? [data] : [data, cons];

  window.__mock = {
    ports: granted,
    requests: 0,
    get requestPortCalls() {
      return this.requests;
    },
    // Live handle on the capability table, so a test can flip one field and let the
    // board re-announce itself the way a reboot with a different boot.py would.
    caps: CAPS,
    ready: function () {
      if (!data.protocol) return;
      data.push(
        enc.encode(
          JSON.stringify({
            evt: "ready",
            app: "PicoHarness",
            version: "0.1.19-mock",
            pins: CAPS.gp.length,
            cp: [10, 3, 1],
            caps: CAPS,
          }) + "\n"
        )
      );
    },
    dev: function (text) {
      cons.push(enc.encode(text));
    },
    devProto: function (text) {
      data.push(enc.encode(text));
    },
    devJson: function (obj) {
      cons.push(enc.encode(JSON.stringify(obj) + "\n"));
    },
  };

  // navigator.serial is a getter on Navigator.prototype; plain assignment is
  // silently ignored, so the real API would keep answering.
  Object.defineProperty(navigator, "serial", {
    value: {
      getPorts: function () {
        return Promise.resolve(granted.slice());
      },
      requestPort: function () {
        window.__mock.requests++;
        return Promise.resolve(single ? data : cons);
      },
    },
    configurable: true,
  });
})();
