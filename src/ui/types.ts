export type JsonMsg = {
  id?: number | null;
  ok?: boolean;
  error?: string;
  data?: any;
  evt?: string;
  in?: number; // gpio_in event: live input level bitmask
  vals?: Record<string, number>; // adc event: raw readings keyed by pin
  caps?: { pwm?: number[]; adc?: number[] };
};

// LinkState models port reality, not wishful thinking:
//   closed      no port
//   connecting  requestPort/open in flight
//   open        port healthy, program handshake unconfirmed
//   ready       open + code.py answered with {"evt":"ready"}
//   repl        open + REPL prompt (>>>) confirmed
export type LinkState = "connecting" | "open" | "ready" | "repl" | "closed" | "error";
