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
          return p.send({ id: m.id, ok: true, data: { version: "0.1.18-mock", caps: CAPS } });
        if (m.cmd === "echo")
          return p.send({ id: m.id, ok: true, data: { msg: m.args.msg } });
        if (m.cmd === "gpio.state") {
          var spiMask = 0;
          var spiList = [];
          Object.keys(p.spi).forEach(function (k) {
            var b = p.spi[k];
            [b.sck, b.mosi, b.miso].concat(b.cs).forEach(function (n) {
              if (n >= 0) spiMask |= 1 << n;
            });
            spiList.push(b);
          });
          var data = pwmState(p);
          data.cfg_in = 0; data.cfg_out = 0; data.out = 0; data.dev_in = 0;
          data.cfg_adc = 0; data.cfg_i2c = 0; data.cfg_uart = 0;
          data.cfg_spi = spiMask; data.spi = spiList;
          return p.send({ id: m.id, ok: true, data: data });
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
