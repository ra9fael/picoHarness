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
  var CAPS = {
    pins: 29,
    pwm: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
    adc: [26, 27, 28, 100],
    i2c_pairs: [[1, 0], [5, 4], [9, 8], [13, 12], [17, 16], [21, 20]],
    uart: { tx: [0, 2, 4, 6, 8], rx: [1, 3, 5, 7, 9], pairs: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]] },
    usb: { data: true },
  };

  function makePort(name, isProtocol) {
    var p = {
      name: name,
      protocol: isProtocol,
      pending: [],
      ctrl: null,
      rx: "",
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
          return p.send({ id: m.id, ok: true, data: { version: "0.1.14-mock", caps: CAPS } });
        if (m.cmd === "echo")
          return p.send({ id: m.id, ok: true, data: { msg: m.args.msg } });
        if (m.cmd === "gpio.state")
          return p.send({
            id: m.id,
            ok: true,
            data: { cfg_in: 0, cfg_out: 0, out: 0, dev_in: 0, cfg_pwm: 0, cfg_adc: 0, cfg_i2c: 0, cfg_uart: 0 },
          });
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
