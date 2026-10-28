// A fake launcher for the signal trials' integration controls (test/interrupt-signals.test.ts): it ignores the program
// and plays a scenario on SIGINT, so runProc's REAL scheduling, sends and finish are what's judged.
//   SCENARIO=honoured  the first press ends it at once, by SIGINT's default action (a fixed product)
//   SCENARIO=late-exit the first press ends it ~440 ms later, just before S3's press 2 is due
const scenario = process.env.SCENARIO;
process.stdout.write("ENTER 1\n");
const die = () => { process.removeAllListeners("SIGINT"); process.stdout.write("KeyboardInterrupt\n"); process.kill(process.pid, "SIGINT"); };
process.on("SIGINT", () => (scenario === "late-exit" ? setTimeout(die, 440) : die()));
setInterval(() => {}, 1000);
